import { TendrilError } from '../errors.js';
import type { EvidenceChunk, SearchProviderName, SearchResult } from '../types.js';
import type { Logger } from '../util.js';
import type { BrowserManager } from './manager.js';
import type { TendrilSession } from './session.js';

interface ParsedSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchOptions {
  query: string;
  provider?: SearchProviderName;
  maxResults?: number;
  fetchTop?: number;
  searxngUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key].trim() : '';
}

function parseDuckDuckGoResponse(text: string): ParsedSearchResult[] {
  const payload: unknown = JSON.parse(text);
  if (!isRecord(payload)) throw new Error('DuckDuckGo API returned an invalid response');

  const parsed: ParsedSearchResult[] = [];
  const abstract = stringField(payload, 'AbstractText');
  const abstractUrl = stringField(payload, 'AbstractURL');
  if (abstract && abstractUrl) {
    parsed.push({
      title: stringField(payload, 'Heading') || abstract.slice(0, 120),
      url: abstractUrl,
      snippet: abstract,
    });
  }

  const collectTopics = (topics: unknown): void => {
    if (!Array.isArray(topics)) return;
    for (const topic of topics) {
      if (!isRecord(topic)) continue;
      collectTopics(topic.Topics);
      const snippet = stringField(topic, 'Text');
      const url = stringField(topic, 'FirstURL');
      if (!snippet || !url) continue;
      parsed.push({ title: snippet.split(' - ', 1)[0] ?? snippet, url, snippet });
    }
  };
  collectTopics(payload.Results);
  collectTopics(payload.RelatedTopics);
  return parsed;
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
  if (provider === 'google') throw new TendrilError('CONFIGURATION_ERROR', 'Google search must use the Custom Search JSON API');
  if (!searxngUrl) throw new TendrilError('CONFIGURATION_ERROR', 'searxngUrl is required for the SearXNG provider');
  return `${searxngUrl.replace(/\/$/, '')}/search?q=${encoded}`;
}

export class SearchService {
  private readonly googleConfigured: boolean;

  constructor(private readonly manager: BrowserManager, private readonly logger: Logger) {
    this.googleConfigured = Boolean(manager.config.googleSearchApiKey && manager.config.googleSearchCx);
    if (!this.googleConfigured) {
      this.logger.warn('Google search provider disabled; GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX are required');
    }
  }

  async search(options: SearchOptions): Promise<{ query: string; provider: SearchProviderName; results: SearchResult[]; evidence?: EvidenceChunk[] }> {
    const providers = options.provider ? [options.provider] : this.manager.config.searchProviders;
    const errors: string[] = [];
    for (const provider of providers) {
      if (provider === 'google' && !this.googleConfigured) {
        errors.push('google: provider disabled because GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX are not configured');
        continue;
      }
      try {
        const results = await this.searchWithProvider(options.query, provider, Math.min(options.maxResults ?? 10, 50), options.searxngUrl);
        if (results.length === 0) throw new Error('Provider returned no recognizable results');
        const output: { query: string; provider: SearchProviderName; results: SearchResult[]; evidence?: EvidenceChunk[] } = { query: options.query, provider, results };
        if ((options.fetchTop ?? 0) > 0) {
          output.evidence = await this.fetchEvidence(results.slice(0, Math.min(options.fetchTop!, 10)), options.query);
        }
        return output;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${provider}: ${message}`);
        this.logger.warn('Search provider failed', { provider, error: message });
      }
    }
    throw new TendrilError('SEARCH_FAILED', `All search providers failed: ${errors.join('; ')}`, { retryable: true });
  }

  private async searchWithProvider(query: string, provider: SearchProviderName, maxResults: number, searxngUrl?: string): Promise<SearchResult[]> {
    const session = await this.manager.create();
    try {
      let parsed: ParsedSearchResult[];
      if (provider === 'duckduckgo') parsed = await this.searchDuckDuckGo(session, query);
      else if (provider === 'google') parsed = await this.searchGoogle(session, query, maxResults);
      else {
        await session.navigate({ url: searchUrl(provider, query, searxngUrl ?? this.manager.config.searxngUrl), waitUntil: 'domcontentloaded' });
        await session.wait({ delayMs: 500 });
        const pageInfo = (await session.listPages()).find((page) => page.selected);
        if (!pageInfo) return [];
        const page = session.chromium.context.pages().find((item) => item.url() === pageInfo.url) ?? session.chromium.context.pages()[0]!;
        if (provider === 'bing') {
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

  private async searchDuckDuckGo(session: TendrilSession, query: string): Promise<ParsedSearchResult[]> {
    const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    try {
      const response = await session.fetchText(apiUrl);
      if (response.status === null || response.status < 200 || response.status >= 300) {
        throw new Error(`DuckDuckGo API returned HTTP ${response.status ?? 'unknown'}`);
      }
      const parsed = parseDuckDuckGoResponse(response.text);
      if (parsed.length === 0) throw new Error('DuckDuckGo API returned no recognizable results');
      return parsed;
    } catch (error) {
      this.logger.warn('DuckDuckGo API failed; falling back to HTML search', {
        error: error instanceof Error ? error.message : String(error),
      });
      await session.navigate({ url: searchUrl('duckduckgo', query), waitUntil: 'domcontentloaded' });
      await session.wait({ delayMs: 500 });
      const pageInfo = (await session.listPages()).find((page) => page.selected);
      if (!pageInfo) return [];
      const page = session.chromium.context.pages().find((item) => item.url() === pageInfo.url) ?? session.chromium.context.pages()[0]!;
      return page.locator('.result').evaluateAll((nodes) => nodes.map((node) => ({
        title: node.querySelector('.result__title')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        url: (node.querySelector('a.result__a') as HTMLAnchorElement | null)?.href ?? '',
        snippet: node.querySelector('.result__snippet')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      })));
    }
  }

  private async searchGoogle(session: TendrilSession, query: string, maxResults: number): Promise<ParsedSearchResult[]> {
    const key = this.manager.config.googleSearchApiKey;
    const cx = this.manager.config.googleSearchCx;
    if (!key || !cx) throw new TendrilError('CONFIGURATION_ERROR', 'Google search provider is not configured');

    const parsed: ParsedSearchResult[] = [];
    while (parsed.length < maxResults) {
      const count = Math.min(maxResults - parsed.length, 10);
      const url = new URL('https://www.googleapis.com/customsearch/v1');
      url.searchParams.set('key', key);
      url.searchParams.set('cx', cx);
      url.searchParams.set('q', query);
      url.searchParams.set('num', String(count));
      url.searchParams.set('start', String(parsed.length + 1));
      const response = await session.fetchText(url.toString());
      let payload: unknown;
      try { payload = JSON.parse(response.text) as unknown; }
      catch (error) { throw new Error('Google Custom Search API returned invalid JSON', { cause: error }); }
      if (!isRecord(payload)) throw new Error('Google Custom Search API returned an invalid response');
      if (response.status === null || response.status < 200 || response.status >= 300) {
        const apiError = isRecord(payload.error) ? stringField(payload.error, 'message') : '';
        throw new Error(apiError || `Google Custom Search API returned HTTP ${response.status ?? 'unknown'}`);
      }
      if (!Array.isArray(payload.items)) break;
      const previousLength = parsed.length;
      for (const item of payload.items) {
        if (!isRecord(item)) continue;
        const title = stringField(item, 'title');
        const itemUrl = stringField(item, 'link');
        if (!title || !itemUrl) continue;
        parsed.push({ title, url: itemUrl, snippet: stringField(item, 'snippet') });
      }
      if (parsed.length - previousLength < count) break;
    }
    return parsed;
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
