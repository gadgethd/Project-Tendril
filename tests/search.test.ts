import { describe, expect, it, vi } from 'vitest';
import {
  allocateResearchSources,
  fuseResults,
  isOfficialMcpUrl,
  parseSearxngResponse,
  rankResults,
  SearchCache,
  SearchService,
  type ParsedSearchResult,
  type SearchResponse,
} from '../src/browser/search.js';
import { TendrilError } from '../src/errors.js';
import type { BrowserManager } from '../src/browser/manager.js';
import type { SearchProviderName, SearchResult } from '../src/types.js';
import { Logger } from '../src/util.js';

function result(
  title: string,
  provider: SearchProviderName = 'bing',
  url = `https://example.com/${encodeURIComponent(title)}`,
  snippet = title,
): SearchResult {
  return { rank: 1, title, url, snippet, provider };
}

function evidence(source: SearchResult, query: string, text = 'evidence text'): import('../src/types.js').EvidenceChunk {
  return {
    citationId: `cite_${query}`,
    sourceUrl: source.url,
    canonicalUrl: source.url,
    finalUrl: source.url,
    title: source.title,
    text,
    query,
    provider: source.provider,
    rank: source.rank,
    status: 200,
    mimeType: 'text/html',
    retrievedAt: '1970-01-01T00:00:00.000Z',
    contentHash: 'a'.repeat(64),
  };
}

function serviceWithProviderSearch(
  providers: SearchProviderName[],
  providerSearch: (provider: SearchProviderName, query: string, signal: AbortSignal) => Promise<ParsedSearchResult[]>,
  now: () => number = Date.now,
): { service: SearchService; searchWithProvider: ReturnType<typeof vi.fn> } {
  const manager = {
    config: {
      searchProviders: providers,
      maxSessions: 4,
      ...(providers.includes('searxng') ? { searxngUrl: 'https://search.example' } : {}),
      ...(providers.includes('google') ? { googleSearchApiKey: 'key', googleSearchCx: 'cx' } : {}),
    },
  } as unknown as BrowserManager;
  const service = new SearchService(manager, new Logger('error'), new SearchCache(), now);
  const searchWithProvider = vi.fn(async (
    query: string,
    provider: SearchProviderName,
    _maxResults: number,
    _semantics: unknown,
    signal: AbortSignal,
  ) => ({ results: await providerSearch(provider, query, signal), failures: [] }));
  Object.defineProperty(service, 'searchWithProvider', { value: searchWithProvider });
  return { service, searchWithProvider };
}

describe('SearchCache', () => {
  it('normalizes queries, includes semantic options, and expires entries', () => {
    let now = 0;
    const cache = new SearchCache(100, 5 * 60_000, () => now);
    cache.set('  TypeScript   MCP  ', 'bing', [result('cached')], { language: 'en' });

    expect(cache.get('typescript mcp', 'bing', { language: 'en' })).toEqual([result('cached')]);
    expect(cache.get('typescript mcp', 'bing', { language: 'fr' })).toBeUndefined();
    expect(cache.get('typescript mcp', 'duckduckgo', { language: 'en' })).toBeUndefined();

    now = 5 * 60_000;
    expect(cache.get('typescript mcp', 'bing', { language: 'en' })).toBeUndefined();
  });

  it('evicts the least recently used entry and returns defensive copies', () => {
    const cache = new SearchCache(2);
    cache.set('first', 'bing', [result('first')]);
    cache.set('second', 'bing', [result('second')]);
    const first = cache.get('first', 'bing')!;
    first[0]!.title = 'mutated';
    cache.set('third', 'bing', [result('third')]);

    expect(cache.get('first', 'bing')![0]!.title).toBe('first');
    expect(cache.get('second', 'bing')).toBeUndefined();
    expect(cache.get('third', 'bing')).toEqual([result('third')]);
  });
});

describe('SearXNG JSON adapter', () => {
  it('retains scores, engines, dates, and bounded engine failures', () => {
    const parsed = parseSearxngResponse(JSON.stringify({
      results: [{
        title: 'Model Context Protocol specification',
        url: 'https://modelcontextprotocol.io/specification',
        content: 'The official protocol specification.',
        score: 12.5,
        engines: ['google', 'bing'],
        publishedDate: '2026-01-02T03:04:05Z',
      }],
      unresponsive_engines: [['quark', 'crashed'], { engine: 'yacy', error: 'timeout' }],
    }));

    expect(parsed.results[0]).toMatchObject({
      providerScore: 12.5,
      engines: ['google', 'bing'],
      publishedAt: '2026-01-02T03:04:05Z',
    });
    expect(parsed.failures).toEqual([
      expect.objectContaining({ engine: 'quark', kind: 'transport', message: 'crashed' }),
      expect.objectContaining({ engine: 'yacy', kind: 'transport', message: 'timeout' }),
    ]);
  });

  it('uses direct bounded JSON fetch with semantic parameters', async () => {
    const fetchText = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      text: JSON.stringify({ results: [{
        title: 'Official Model Context Protocol specification',
        url: 'https://modelcontextprotocol.io/specification?utm_source=test',
        content: 'Official Model Context Protocol documentation and specification.',
        score: 9,
        engines: ['brave'],
      }] }),
    }));
    const manager = {
      config: { searchProviders: ['searxng'], searxngUrl: 'https://search.example/base', maxSessions: 1 },
      create: vi.fn(async () => ({ id: 'ses_1', fetchText })),
      close: vi.fn(async () => undefined),
    } as unknown as BrowserManager;
    const service = new SearchService(manager, new Logger('error'));

    const response = await service.search({
      query: 'Model Context Protocol official specification',
      language: 'en',
      safeSearch: 1,
      timeRange: 'month',
    });

    const [url, _pageId, options] = fetchText.mock.calls[0]!;
    const parsedUrl = new URL(url as string);
    expect(parsedUrl.pathname).toBe('/base/search');
    expect(Object.fromEntries(parsedUrl.searchParams)).toMatchObject({
      q: 'Model Context Protocol official specification', format: 'json', language: 'en', safesearch: '1', time_range: 'month',
    });
    expect(options).toMatchObject({ maxBytes: 1_000_000, accept: 'application/json' });
    expect(response.results[0]).toMatchObject({
      provider: 'searxng', engines: ['brave'], providerScore: 9,
      url: 'https://modelcontextprotocol.io/specification',
    });
    expect(manager.close).toHaveBeenCalledWith('ses_1');
  });

  it('rejects per-call endpoint overrides', async () => {
    const manager = { config: {
      searchProviders: ['searxng'], searxngUrl: 'https://configured.example', maxSessions: 1,
    } } as unknown as BrowserManager;
    const service = new SearchService(manager, new Logger('error'));

    await expect(service.search({ query: 'endpoint override', searxngUrl: 'https://attacker.example' }))
      .rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });
});

describe('deterministic ranking and provider selection', () => {
  it('weights title matches above snippets and preserves stable rank ties', () => {
    const ranked = rankResults([
      { ...result('Original first'), rank: 1, snippet: 'No relevant terms' },
      { ...result('Browser automation handbook'), rank: 4, snippet: '' },
      { ...result('Snippet match'), rank: 3, snippet: 'A browser automation guide' },
    ], 'browser automation');

    expect(ranked.map((item) => item.title)).toEqual(['Browser automation handbook', 'Snippet match', 'Original first']);
    expect(ranked.map((item) => item.rank)).toEqual([1, 2, 3]);
  });

  it('ranks official MCP properties above lookalikes without trusting generic GitHub URLs', () => {
    const ranked = rankResults([
      { ...result('Model Context Protocol official specification', 'searxng', 'https://modelcontextprotocol.info/specification'), rank: 1 },
      { ...result('Protocol documentation', 'searxng', 'https://github.com/modelcontextprotocol/modelcontextprotocol', 'Model Context Protocol specification'), rank: 8 },
      { ...result('Protocol documentation', 'searxng', 'https://modelcontextprotocol.io/specification', 'Model Context Protocol specification'), rank: 9 },
    ], 'Model Context Protocol official specification');

    expect(ranked.slice(0, 2).every((item) => isOfficialMcpUrl(item.url))).toBe(true);
    expect(ranked[2]!.url).toBe('https://modelcontextprotocol.info/specification');
    expect(isOfficialMcpUrl('https://github.com/example/modelcontextprotocol')).toBe(false);
  });

  it('fuses duplicate URLs and ranks authoritative query coverage first', () => {
    const fused = fuseResults([
      { provider: 'bing', results: [result('Model', 'bing', 'https://example.com/generic', 'fashion model')] },
      { provider: 'searxng', results: [
        result('Official Model Context Protocol specification', 'searxng', 'https://modelcontextprotocol.io/specification?utm_source=x'),
        { ...result('MCP mirror', 'searxng', 'https://example.com/mirror'), rank: 2 },
      ] },
      { provider: 'duckduckgo', results: [result('Model Context Protocol specification', 'duckduckgo', 'https://modelcontextprotocol.io/specification')] },
    ], 'Model Context Protocol official specification', ['searxng', 'duckduckgo', 'bing'], 10);

    expect(fused[0]).toMatchObject({
      url: 'https://modelcontextprotocol.io/specification',
      providers: ['searxng', 'duckduckgo'],
      providerRanks: { searxng: 1, duckduckgo: 1 },
    });
  });

  it('is independent of provider completion latency and rejects the audited irrelevant fixture', async () => {
    const run = async (bingDelay: number, searxDelay: number) => {
      const { service } = serviceWithProviderSearch(['searxng', 'bing'], async (provider) => {
        await new Promise((resolve) => setTimeout(resolve, provider === 'bing' ? bingDelay : searxDelay));
        return provider === 'bing'
          ? [{ title: 'Model', url: 'https://example.com/model', snippet: 'Fashion and product models' }]
          : [{ title: 'Official Model Context Protocol specification', url: 'https://modelcontextprotocol.io/specification', snippet: 'Official MCP protocol specification' }];
      });
      return service.search({ query: 'Model Context Protocol official specification' });
    };

    const fastBing = await run(1, 20);
    const fastSearx = await run(20, 1);
    expect(fastBing.results).toEqual(fastSearx.results);
    expect(fastBing.provider).toBe('searxng');
    expect(fastBing.failures).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'bing', kind: 'irrelevant' })]));
  });

  it('skips providers that are not configured', async () => {
    const manager = { config: { searchProviders: ['searxng', 'google', 'bing'], maxSessions: 2 } } as unknown as BrowserManager;
    const service = new SearchService(manager, new Logger('error'));
    const searchWithProvider = vi.fn(async (_query: string, provider: SearchProviderName) => ({
      results: [{ title: 'Configured query result', url: 'https://example.com/result', snippet: 'Configured query result', provider }],
      failures: [],
    }));
    Object.defineProperty(service, 'searchWithProvider', { value: searchWithProvider });

    const response = await service.search({ query: 'configured query' });

    expect(searchWithProvider).toHaveBeenCalledTimes(1);
    expect(searchWithProvider.mock.calls[0]![1]).toBe('bing');
    expect(response.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'searxng', kind: 'unconfigured' }),
      expect.objectContaining({ provider: 'google', kind: 'unconfigured' }),
    ]));
    expect(service.getProviderHealth('searxng')).toMatchObject({ available: false });
  });
});

describe('provider resilience', () => {
  it('falls back to DuckDuckGo HTML when Instant Answer topics are irrelevant', async () => {
    const fetchText = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify({ RelatedTopics: [{
          Text: 'Mercury - the smallest planet in the Solar System',
          FirstURL: 'https://example.com/mercury',
        }] }),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'text/html' },
        text: '<div class="result"><h2 class="result__title"><a class="result__a" href="https://modelcontextprotocol.io/specification">Protocol documentation</a></h2><div class="result__snippet">Official Model Context Protocol specification</div></div>',
      });
    const manager = {
      config: { searchProviders: ['duckduckgo'], maxSessions: 1 },
      create: vi.fn(async () => ({ id: 'ses_ddg', fetchText })),
      close: vi.fn(async () => undefined),
    } as unknown as BrowserManager;
    const service = new SearchService(manager, new Logger('error'));

    const response = await service.search({ query: 'Model Context Protocol specification', provider: 'duckduckgo' });

    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(fetchText.mock.calls[0]![0]).toContain('api.duckduckgo.com');
    expect(fetchText.mock.calls[1]![0]).toContain('html.duckduckgo.com');
    expect(response.results[0]!.url).toBe('https://modelcontextprotocol.io/specification');
  });

  it('coalesces concurrent identical calls and separates semantic cache identities', async () => {
    const { service, searchWithProvider } = serviceWithProviderSearch(['bing'], async (provider, query) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ title: query, url: `https://example.com/${provider}`, snippet: query }];
    });

    await Promise.all(Array.from({ length: 20 }, () => service.search({ query: 'shared query', language: 'en' })));
    expect(searchWithProvider).toHaveBeenCalledTimes(1);

    await service.search({ query: 'shared query', language: 'en' });
    expect(searchWithProvider).toHaveBeenCalledTimes(1);
    await service.search({ query: 'shared query', language: 'fr' });
    expect(searchWithProvider).toHaveBeenCalledTimes(2);
  });

  it('limits concurrent requests per provider', async () => {
    let active = 0;
    let peak = 0;
    const { service } = serviceWithProviderSearch(['bing'], async (_provider, query) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return [{ title: query, url: `https://example.com/${encodeURIComponent(query)}`, snippet: query }];
    });

    await Promise.all(Array.from({ length: 8 }, (_, index) => service.search({ query: `bounded query ${index}`, provider: 'bing' })));

    expect(peak).toBe(2);
  });

  it('opens after three failures, blocks calls, and recovers through one half-open probe', async () => {
    let now = 0;
    let working = false;
    const { service, searchWithProvider } = serviceWithProviderSearch(['bing'], async (_provider, query, signal) => {
      now += 10;
      if (query === 'cancelled probe') return new Promise<ParsedSearchResult[]>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      if (!working) throw new Error(`offline ${query}`);
      return [{ title: query, url: 'https://example.com/recovered', snippet: query }];
    }, () => now);

    for (const query of ['failure one', 'failure two', 'failure three']) {
      await expect(service.search({ query, provider: 'bing' })).rejects.toMatchObject({ code: 'SEARCH_FAILED' });
    }
    expect(searchWithProvider).toHaveBeenCalledTimes(3);
    await expect(service.search({ query: 'blocked attempt', provider: 'bing' })).rejects.toMatchObject({
      details: { failures: [expect.objectContaining({ kind: 'circuit_open' })] },
    });
    expect(searchWithProvider).toHaveBeenCalledTimes(3);

    now += 30_001;
    const controller = new AbortController();
    const cancelledProbe = service.search({ query: 'cancelled probe', provider: 'bing', signal: controller.signal });
    await vi.waitFor(() => expect(searchWithProvider).toHaveBeenCalledTimes(4));
    controller.abort(new TendrilError('CANCELLED', 'cancel half-open probe'));
    await expect(cancelledProbe).rejects.toMatchObject({ code: 'CANCELLED' });

    working = true;
    const recovered = await service.search({ query: 'recovered query', provider: 'bing' });
    expect(recovered.results[0]!.title).toBe('recovered query');
    expect(searchWithProvider).toHaveBeenCalledTimes(5);
    expect(service.getProviderHealth('bing')).toMatchObject({ available: true, consecutiveFailures: 0 });
  });

  it('parses Retry-After and opens a rate-limit circuit immediately', async () => {
    const fetchText = vi.fn(async () => ({ status: 429, headers: { 'retry-after': '2' }, text: '' }));
    const manager = {
      config: { searchProviders: ['searxng'], searxngUrl: 'https://search.example', maxSessions: 1 },
      create: vi.fn(async () => ({ id: 'ses_rate', fetchText })),
      close: vi.fn(async () => undefined),
    } as unknown as BrowserManager;
    const service = new SearchService(manager, new Logger('error'));

    const first = await service.search({ query: 'rate limited query' });
    const second = service.search({ query: 'another rate limited query' });

    expect(first.rateLimit).toEqual({ provider: 'searxng', retryAfterMs: 2_000 });
    await expect(second).rejects.toMatchObject({
      details: { failures: [expect.objectContaining({ kind: 'circuit_open' })] },
    });
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it('propagates caller cancellation to the shared provider operation', async () => {
    const { service } = serviceWithProviderSearch(['bing'], async (_provider, _query, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = service.search({ query: 'slow cancellable query', signal: controller.signal });
    controller.abort(new TendrilError('CANCELLED', 'stop now', { retryable: true }));

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', message: 'stop now' });
  });

  it('awaits direct-adapter cleanup before returning cancellation', async () => {
    const close = vi.fn(async () => undefined);
    const fetchText = vi.fn(async (_url: string, _pageId: undefined, options: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const manager = {
      config: { searchProviders: ['searxng'], searxngUrl: 'https://search.example', maxSessions: 1 },
      create: vi.fn(async () => ({ id: 'ses_cancel', fetchText })),
      close,
    } as unknown as BrowserManager;
    const service = new SearchService(manager, new Logger('error'));
    const controller = new AbortController();
    const pending = service.search({ query: 'cancel direct adapter', signal: controller.signal });
    await vi.waitFor(() => expect(fetchText).toHaveBeenCalled());
    controller.abort(new TendrilError('CANCELLED', 'client cancelled'));

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(close).toHaveBeenCalledWith('ses_cancel');
  });
});

describe('research allocation and provenance', () => {
  it('balances queries and domains while merging originating queries', () => {
    const allocated = allocateResearchSources([
      { query: 'alpha', results: [
        result('Alpha one', 'bing', 'https://same.example/a'),
        result('Alpha two', 'bing', 'https://alpha.example/b'),
      ] },
      { query: 'beta', results: [
        result('Beta duplicate', 'searxng', 'https://same.example/a'),
        result('Beta two', 'searxng', 'https://beta.example/b'),
      ] },
    ], 2);

    expect(allocated.map((source) => new URL(source.url).hostname)).toEqual(['same.example', 'beta.example']);
    expect(allocated[0]!.queries).toEqual(['alpha', 'beta']);
    expect(allocated[1]!.queries).toEqual(['beta']);
  });

  it('returns citation-ready bounded evidence with stable provenance', async () => {
    const close = vi.fn(async () => undefined);
    const manager = {
      config: { searchProviders: ['bing'], maxSessions: 2 },
      create: vi.fn(async () => ({
        id: `ses_${Math.random()}`,
        navigate: vi.fn(async ({ url }: { url: string }) => ({
          url: `${url}?final=1`, title: `Title for ${url}`, status: 200, mimeType: 'text/html',
        })),
        extract: vi.fn(async () => `# Relevant heading\n\n${'Model Context Protocol evidence '.repeat(20)}\n\n${'Additional supporting paragraph '.repeat(20)}`),
        close,
      })),
      close: vi.fn(async () => undefined),
    } as unknown as BrowserManager;
    const service = new SearchService(manager, new Logger('error'), new SearchCache(), () => 1_800_000_000_000);
    const search = vi.fn(async ({ query }: { query: string }): Promise<SearchResponse> => ({
      query,
      provider: query === 'alpha query' ? 'bing' : 'searxng',
      providers: [query === 'alpha query' ? 'bing' : 'searxng'],
      results: [result(query, query === 'alpha query' ? 'bing' : 'searxng', `https://${query.startsWith('alpha') ? 'alpha' : 'beta'}.example/source`)],
    }));
    Object.defineProperty(service, 'search', { value: search });

    const researched = await service.research({
      queries: ['alpha query', 'beta query'],
      maxSources: 2,
      maxEvidenceChars: 600,
    });

    expect(researched.sources.map((source) => source.queries)).toEqual([['alpha query'], ['beta query']]);
    expect(researched.evidence.reduce((total, chunk) => total + chunk.text.length, 0)).toBeLessThanOrEqual(600);
    expect(researched.evidence[0]).toMatchObject({
      citationId: expect.stringMatching(/^cite_[a-f0-9]{20}$/),
      canonicalUrl: 'https://alpha.example/source',
      finalUrl: 'https://alpha.example/source?final=1',
      query: 'alpha query',
      provider: 'bing',
      status: 200,
      mimeType: 'text/html',
      retrievedAt: '2027-01-15T08:00:00.000Z',
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(researched.failures).toEqual([]);
  });

  it('bounds and sanitizes every string provenance field', async () => {
    const oversized = 'x'.repeat(10_000);
    const sourceUrl = `https://source.example/${oversized}`;
    const manager = {
      config: { searchProviders: ['bing'], maxSessions: 1 },
      create: vi.fn(async () => ({
        id: 'ses_bounded_provenance',
        navigate: vi.fn(async () => ({
          url: `javascript:${oversized}`,
          title: oversized,
          status: 200,
          mimeType: `text/${oversized}\r\nX-Injected: yes`,
        })),
        extract: vi.fn(async () => `# ${oversized}\n\n${'Bounded provenance evidence. '.repeat(10)}`),
        close: vi.fn(async () => undefined),
      })),
      close: vi.fn(async () => undefined),
    } as unknown as BrowserManager;
    const service = new SearchService(manager, new Logger('error'));
    Object.defineProperty(service, 'search', { value: vi.fn(async ({ query }: { query: string }): Promise<SearchResponse> => ({
      query,
      provider: 'bing',
      providers: ['bing'],
      results: [result(oversized, 'bing', sourceUrl, query)],
    })) });

    const researched = await service.research({ queries: ['bounded provenance'], maxSources: 1 });
    const chunk = researched.evidence[0]!;

    expect(chunk.sourceUrl.length).toBeLessThanOrEqual(4_096);
    expect(chunk.canonicalUrl.length).toBeLessThanOrEqual(4_096);
    expect(chunk.finalUrl).toBe(chunk.canonicalUrl);
    expect(chunk.title.length).toBeLessThanOrEqual(500);
    expect(chunk.heading?.length).toBeLessThanOrEqual(300);
    expect(chunk.query.length).toBeLessThanOrEqual(1_000);
    expect(chunk.mimeType.length).toBeLessThanOrEqual(255);
    expect(chunk.mimeType).not.toMatch(/[\r\n\u0000]/);
  });

  it('cancels and drains in-flight evidence sessions before returning', async () => {
    const sessionClose = vi.fn(async () => undefined);
    const managerClose = vi.fn(async () => undefined);
    const navigate = vi.fn(async ({ signal }: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const manager = {
      config: { searchProviders: ['bing'], maxSessions: 1 },
      create: vi.fn(async () => ({ id: 'ses_evidence_cancel', navigate, extract: vi.fn(), close: sessionClose })),
      close: managerClose,
    } as unknown as BrowserManager;
    const service = new SearchService(manager, new Logger('error'));
    Object.defineProperty(service, 'search', { value: vi.fn(async ({ query }: { query: string }): Promise<SearchResponse> => ({
      query, provider: 'bing', providers: ['bing'], results: [result(query, 'bing', 'https://evidence.example/source')],
    })) });
    const controller = new AbortController();
    const pending = service.research({ queries: ['cancel evidence query'], signal: controller.signal });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    controller.abort(new TendrilError('CANCELLED', 'cancel research'));

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sessionClose).toHaveBeenCalledTimes(1);
    expect(managerClose).toHaveBeenCalledWith('ses_evidence_cancel');
  });

  it('stores refinement state in the shared service with expiry and defensive copies', async () => {
    let now = 0;
    const manager = { config: { searchProviders: ['bing'], maxSessions: 1 } } as unknown as BrowserManager;
    const service = new SearchService(manager, new Logger('error'), new SearchCache(), () => now);
    const research = vi.fn(async ({ queries }: { queries: string[] }) => {
      const query = queries[0]!;
      const source = result(query, 'bing', `https://${query}.example/source`);
      source.queries = [query];
      return { queries, sources: [source], evidence: [evidence(source, query, query.repeat(20))], failures: [] };
    });
    Object.defineProperty(service, 'research', { value: research });

    const started = await service.startResearchJob({ queries: ['initial'] });
    started.sources[0]!.title = 'mutated caller copy';
    expect(service.getResearchJob(started.id).sources[0]!.title).toBe('initial');

    now = 1_000;
    const refined = await service.refineResearchJob(started.id, {
      queries: ['followup'], maxSources: 2, maxEvidenceChars: 100,
    });
    expect(refined.queries).toEqual(['initial', 'followup']);
    expect(refined.sources).toHaveLength(2);
    expect(refined.evidence.reduce((total, chunk) => total + chunk.text.length, 0)).toBeLessThanOrEqual(100);

    now += 30 * 60_000 + 1;
    expect(() => service.getResearchJob(started.id)).toThrow('not found or expired');
  });

  it('service close cancels and waits for active search cleanup', async () => {
    const close = vi.fn(async () => undefined);
    const fetchText = vi.fn(async (_url: string, _pageId: undefined, options: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const manager = {
      config: { searchProviders: ['searxng'], searxngUrl: 'https://search.example', maxSessions: 1 },
      create: vi.fn(async () => ({ id: 'ses_shutdown', fetchText })),
      close,
    } as unknown as BrowserManager;
    const service = new SearchService(manager, new Logger('error'));
    const pending = service.search({ query: 'shutdown active search' });
    await vi.waitFor(() => expect(fetchText).toHaveBeenCalled());

    await service.close();

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(close).toHaveBeenCalledWith('ses_shutdown');
    await expect(service.search({ query: 'after shutdown' })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('SearchService evidence safety', () => {
  it('propagates extraction warnings with untrusted evidence chunks', async () => {
    const close = vi.fn(async () => undefined);
    const manager = {
      config: { searchProviders: [] },
      create: vi.fn(async () => ({
        id: 'session_evidence',
        navigate: vi.fn(async () => ({ status: 200 })),
        extractWithSafety: vi.fn(async () => ({
          data: { title: 'Fixture', markdown: `Evidence ${'x'.repeat(100)}` },
          untrustedContent: true,
          warnings: ['Page content contains instruction-override language.'],
        })),
      })),
      close,
    } as unknown as BrowserManager;
    const service = new SearchService(manager, new Logger('error'));

    const evidence = await (service as unknown as {
      fetchEvidence(results: SearchResult[], query: string): Promise<Array<{ warnings?: string[] }>>;
    }).fetchEvidence([result('evidence')], 'safety query');

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.warnings).toContain('Page content contains instruction-override language.');
    expect(close).toHaveBeenCalledWith('session_evidence');
  });
});
