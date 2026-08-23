import { TendrilError } from '../errors.js';
import type { EvidenceChunk, SearchProviderName, SearchResult } from '../types.js';
import type { Logger } from '../util.js';
import type { BrowserManager } from './manager.js';

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 100;
const MAX_SEARCH_RESULTS = 50;

interface SearchCacheEntry {
  expiresAt: number;
  results: SearchResult[];
}

interface ProviderSearchSuccess {
  ok: true;
  provider: SearchProviderName;
  results: SearchResult[];
}

interface ProviderSearchFailure {
  ok: false;
  provider: SearchProviderName;
  error: string;
}

type ProviderSearchAttempt = ProviderSearchSuccess | ProviderSearchFailure;

export class SearchCache {
  private readonly entries = new Map<string, SearchCacheEntry>();

  constructor(
    private readonly maxEntries = SEARCH_CACHE_MAX_ENTRIES,
    private readonly ttlMs = SEARCH_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(query: string, provider: SearchProviderName): SearchResult[] | undefined {
    const key = this.key(query, provider);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.results.map((result) => ({ ...result }));
  }

  set(query: string, provider: SearchProviderName, results: SearchResult[]): void {
    const key = this.key(query, provider);
    this.entries.delete(key);
    this.entries.set(key, {
      expiresAt: this.now() + this.ttlMs,
      results: results.map((result) => ({ ...result })),
    });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  private key(query: string, provider: SearchProviderName): string {
    const normalizedQuery = query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    return `${provider}:${normalizedQuery}`;
  }
}

function normalizeResultUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.hostname.endsWith('duckduckgo.com') && url.searchParams.has('uddg')) {
      return decodeURIComponent(url.searchParams.get('uddg')!);
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|ved|ei)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function searchUrl(provider: SearchProviderName, query: string, searxngUrl?: string): string {
  const encoded = encodeURIComponent(query);
  if (provider === 'duckduckgo') return `https://html.duckduckgo.com/html/?q=${encoded}`;
  // Bing's RSS representation is still rendered by Chromium, is compact, and is substantially
  // more stable for an agent than presentation-layer CSS selectors.
  if (provider === 'bing') return `https://www.bing.com/search?format=rss&q=${encoded}`;
  if (provider === 'google') return `https://www.google.com/search?q=${encoded}`;
  if (!searxngUrl) throw new TendrilError('CONFIGURATION_ERROR', 'searxngUrl is required for the SearXNG provider');
  return `${searxngUrl.replace(/\/$/, '')}/search?q=${encoded}`;
}

export class SearchService {
  constructor(
    private readonly manager: BrowserManager,
    private readonly logger: Logger,
    private readonly cache = new SearchCache(),
  ) {}

  async search(options: { query: string; provider?: SearchProviderName; maxResults?: number; fetchTop?: number }): Promise<{ query: string; provider: SearchProviderName; results: SearchResult[]; evidence?: EvidenceChunk[] }> {
    const providers = options.provider ? [options.provider] : this.manager.config.searchProviders;
    const maxResults = Math.min(options.maxResults ?? 10, MAX_SEARCH_RESULTS);
    const errors: string[] = [];
    let success: ProviderSearchSuccess | undefined;
    let remainingProviders = providers;

    if (!options.provider && providers.length >= 2) {
      const pending = new Map(
        providers.slice(0, 2).map((provider, index) => [
          index,
          this.tryProvider(options.query, provider, maxResults).then((attempt) => ({ ...attempt, index })),
        ]),
      );
      while (pending.size > 0) {
        const attempt = await Promise.race(pending.values());
        pending.delete(attempt.index);
        if (attempt.ok) {
          success = attempt;
          break;
        }
        errors.push(`${attempt.provider}: ${attempt.error}`);
      }
      remainingProviders = providers.slice(2);
    }

    for (const provider of remainingProviders) {
      if (success) break;
      const attempt = await this.tryProvider(options.query, provider, maxResults);
      if (attempt.ok) {
        success = attempt;
      } else {
        errors.push(`${attempt.provider}: ${attempt.error}`);
      }
    }

    if (!success) {
      throw new TendrilError('SEARCH_FAILED', `All search providers failed: ${errors.join('; ')}`, { retryable: true });
    }
    const output: { query: string; provider: SearchProviderName; results: SearchResult[]; evidence?: EvidenceChunk[] } = {
      query: options.query,
      provider: success.provider,
      results: success.results,
    };
    if ((options.fetchTop ?? 0) > 0) {
      output.evidence = await this.fetchEvidence(success.results.slice(0, Math.min(options.fetchTop!, 10)), options.query);
    }
    return output;
  }

  private async tryProvider(query: string, provider: SearchProviderName, maxResults: number): Promise<ProviderSearchAttempt> {
    try {
      const results = await this.getSearchResults(query, provider, maxResults);
      if (results.length === 0) throw new Error('Provider returned no recognizable results');
      return { ok: true, provider, results };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Search provider failed', { provider, error: message });
      return { ok: false, provider, error: message };
    }
  }

  private async getSearchResults(query: string, provider: SearchProviderName, maxResults: number): Promise<SearchResult[]> {
    const cached = this.cache.get(query, provider);
    if (cached) {
      this.logger.debug('Search cache hit', { provider, query });
      return cached.slice(0, maxResults);
    }
    this.logger.debug('Search cache miss', { provider, query });
    const results = await this.searchWithProvider(query, provider, MAX_SEARCH_RESULTS);
    if (results.length > 0) this.cache.set(query, provider, results);
    return results.slice(0, maxResults);
  }

  private async searchWithProvider(query: string, provider: SearchProviderName, maxResults: number): Promise<SearchResult[]> {
    const session = await this.manager.create();
    try {
      await session.navigate({ url: searchUrl(provider, query, this.manager.config.searxngUrl), waitUntil: 'domcontentloaded' });
      await session.wait({ delayMs: 500 });
      const pageInfo = (await session.listPages()).find((page) => page.selected);
      if (!pageInfo) return [];
      const page = session.chromium.context.pages().find((item) => item.url() === pageInfo.url) ?? session.chromium.context.pages()[0]!;
      let parsed: Array<{ title: string; url: string; snippet: string }> = [];
      if (provider === 'duckduckgo') {
        parsed = await page.locator('.result').evaluateAll((nodes) => nodes.map((node) => ({
          title: node.querySelector('.result__title')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          url: (node.querySelector('a.result__a') as HTMLAnchorElement | null)?.href ?? '',
          snippet: node.querySelector('.result__snippet')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        })));
      } else if (provider === 'bing') {
        parsed = await page.locator('item').evaluateAll((nodes) => nodes.map((node) => ({
          title: node.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          url: node.querySelector('link')?.textContent?.trim() ?? '',
          snippet: node.querySelector('description')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        })));
      } else if (provider === 'searxng') {
        parsed = await page.locator('.result').evaluateAll((nodes) => nodes.map((node) => ({
          title: node.querySelector('h3, h4')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          url: (node.querySelector('a') as HTMLAnchorElement | null)?.href ?? '',
          snippet: node.querySelector('.content, p')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        })));
      } else {
        parsed = await page.locator('a:has(h3)').evaluateAll((nodes) => nodes.map((node) => ({
          title: node.querySelector('h3')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          url: (node as HTMLAnchorElement).href,
          snippet: node.parentElement?.parentElement?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 500) ?? '',
        })));
      }
      const seen = new Set<string>();
      const results: SearchResult[] = [];
      for (const item of parsed) {
        const url = normalizeResultUrl(item.url);
        if (!url || !item.title || seen.has(url)) continue;
        seen.add(url);
        results.push({ rank: results.length + 1, title: item.title, url, snippet: item.snippet, provider });
        if (results.length >= maxResults) break;
      }
      return results;
    } finally {
      await this.manager.close(session.id);
    }
  }

  async research(options: { queries: string[]; maxResultsPerQuery?: number; maxSources?: number }): Promise<{ queries: string[]; sources: SearchResult[]; evidence: EvidenceChunk[] }> {
    const allResults: SearchResult[] = [];
    for (const query of options.queries.slice(0, 10)) {
      const searched = await this.search({ query, maxResults: options.maxResultsPerQuery ?? 5 });
      allResults.push(...searched.results);
    }
    const deduplicated = [...new Map(allResults.map((item) => [normalizeResultUrl(item.url) ?? item.url, item])).values()]
      .slice(0, Math.min(options.maxSources ?? 10, 30));
    const evidence = await this.fetchEvidence(deduplicated, options.queries.join(' | '));
    return { queries: options.queries, sources: deduplicated, evidence };
  }

  private async fetchEvidence(results: SearchResult[], query: string): Promise<EvidenceChunk[]> {
    const evidence: EvidenceChunk[] = [];
    for (const result of results) {
      let session;
      try {
        session = await this.manager.create();
        await session.navigate({ url: result.url, waitUntil: 'domcontentloaded' });
        const extracted = await session.extract({ format: 'all' }) as { title: string; markdown: string };
        const chunks = extracted.markdown.split(/\n{2,}/).map((text) => text.trim()).filter((text) => text.length >= 80);
        for (const text of chunks.slice(0, 5)) {
          evidence.push({ sourceUrl: result.url, title: extracted.title || result.title, text: text.slice(0, 2500), query });
        }
      } catch (error) {
        this.logger.warn('Evidence retrieval failed', { url: result.url, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (session) await this.manager.close(session.id);
      }
    }
    return evidence;
  }
}
