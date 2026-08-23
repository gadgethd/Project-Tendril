import { describe, expect, it, vi } from 'vitest';
import { rankResults, SearchCache, SearchService } from '../src/browser/search.js';
import type { BrowserManager } from '../src/browser/manager.js';
import type { SearchProviderName, SearchResult } from '../src/types.js';
import { Logger } from '../src/util.js';

function result(title: string, provider: SearchResult['provider'] = 'bing'): SearchResult {
  return { rank: 1, title, url: `https://example.com/${title}`, snippet: title, provider };
}

describe('SearchCache', () => {
  it('normalizes queries and expires entries after five minutes', () => {
    let now = 0;
    const cache = new SearchCache(100, 5 * 60 * 1000, () => now);
    cache.set('  TypeScript   MCP  ', 'bing', [result('cached')]);

    expect(cache.get('typescript mcp', 'bing')).toEqual([result('cached')]);
    expect(cache.get('typescript mcp', 'duckduckgo')).toBeUndefined();

    now = 5 * 60 * 1000;
    expect(cache.get('typescript mcp', 'bing')).toBeUndefined();
  });

  it('evicts the least recently used entry', () => {
    const cache = new SearchCache(2);
    cache.set('first', 'bing', [result('first')]);
    cache.set('second', 'bing', [result('second')]);
    cache.get('first', 'bing');
    cache.set('third', 'bing', [result('third')]);

    expect(cache.get('first', 'bing')).toEqual([result('first')]);
    expect(cache.get('second', 'bing')).toBeUndefined();
    expect(cache.get('third', 'bing')).toEqual([result('third')]);
  });
});

describe('rankResults', () => {
  it('weights title matches above snippets and authoritative URLs', () => {
    const ranked = rankResults([
      { ...result('Original first'), rank: 1, url: 'https://example.com/first', snippet: 'No relevant terms' },
      { ...result('Browser automation handbook'), rank: 4, url: 'https://example.com/title', snippet: '' },
      { ...result('Snippet match'), rank: 3, url: 'https://example.com/snippet', snippet: 'A browser automation guide' },
      { ...result('Authoritative reference'), rank: 2, url: 'https://docs.github.com/reference', snippet: '' },
    ], 'browser automation');

    expect(ranked.map((item) => item.title)).toEqual([
      'Browser automation handbook',
      'Snippet match',
      'Authoritative reference',
      'Original first',
    ]);
    expect(ranked.map((item) => item.rank)).toEqual([1, 2, 3, 4]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score ?? 0);
  });

  it('uses original provider rank to break equal scores', () => {
    const ranked = rankResults([
      { ...result('Second'), rank: 2, snippet: '' },
      { ...result('First'), rank: 1, snippet: '' },
    ], 'unmatched query');

    expect(ranked.map((item) => item.title)).toEqual(['First', 'Second']);
  });
});

function serviceWithProviderSearch(
  providers: SearchProviderName[],
  providerSearch: (provider: SearchProviderName) => Promise<SearchResult[]>,
): SearchService {
  const manager = { config: { searchProviders: providers } } as unknown as BrowserManager;
  const service = new SearchService(manager, new Logger('error'));
  Object.defineProperty(service, 'searchWithProvider', {
    value: vi.fn((_query: string, provider: SearchProviderName) => providerSearch(provider)),
  });
  return service;
}

describe('SearchService provider concurrency', () => {
  it('returns the faster successful provider from the first pair', async () => {
    const searched: SearchProviderName[] = [];
    const service = serviceWithProviderSearch(['bing', 'duckduckgo', 'google'], async (provider) => {
      searched.push(provider);
      await new Promise((resolve) => setTimeout(resolve, provider === 'bing' ? 30 : 5));
      return [result(provider, provider)];
    });

    const response = await service.search({ query: 'parallel search' });

    expect(response.provider).toBe('duckduckgo');
    expect(searched).toEqual(['bing', 'duckduckgo']);
  });

  it('does not let an early provider failure win the race', async () => {
    const service = serviceWithProviderSearch(['bing', 'duckduckgo'], async (provider) => {
      await new Promise((resolve) => setTimeout(resolve, provider === 'bing' ? 1 : 10));
      if (provider === 'bing') throw new Error('blocked');
      return [result('fallback', provider)];
    });

    const response = await service.search({ query: 'resilient search' });

    expect(response.provider).toBe('duckduckgo');
  });

  it('tries later providers after both raced providers fail', async () => {
    const searched: SearchProviderName[] = [];
    const service = serviceWithProviderSearch(['bing', 'duckduckgo', 'google'], async (provider) => {
      searched.push(provider);
      if (provider !== 'google') throw new Error('unavailable');
      return [result('third provider', provider)];
    });

    const response = await service.search({ query: 'fallback search' });

    expect(response.provider).toBe('google');
    expect(searched).toEqual(['bing', 'duckduckgo', 'google']);
  });
});
