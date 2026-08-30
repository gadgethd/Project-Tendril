import { describe, expect, it, vi } from 'vitest';
import type { BrowserManager } from '../src/browser/manager.js';
import { SearchCache, SearchService } from '../src/browser/search.js';
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

function serviceWithProviderSearch(
  providers: SearchProviderName[],
  providerSearch: (provider: SearchProviderName, query: string) => Promise<SearchResult[]>,
  now: () => number = Date.now,
): SearchService {
  const manager = { config: { searchProviders: providers } } as unknown as BrowserManager;
  const service = new SearchService(manager, new Logger('error'), new SearchCache(), now);
  Object.defineProperty(service, 'searchWithProvider', {
    value: vi.fn((query: string, provider: SearchProviderName) => providerSearch(provider, query)),
  });
  return service;
}

describe('SearchService provider health', () => {
  it('tracks availability, failures, timestamps, and average latency per provider', async () => {
    let now = 0;
    const service = serviceWithProviderSearch(
      ['bing'],
      async (provider, query) => {
        now += query === 'working' ? 20 : 40;
        if (query === 'failing') throw new Error('provider unavailable');
        return [result('working', provider)];
      },
      () => now,
    );

    await service.search({ query: 'working' });
    await expect(service.search({ query: 'failing' })).rejects.toThrow('All search providers failed');

    const health = service.getProviderHealth('bing');
    expect(health).toEqual({
      provider: 'bing',
      available: false,
      lastSuccess: '1970-01-01T00:00:00.020Z',
      lastFailure: '1970-01-01T00:00:00.060Z',
      averageLatencyMs: 30,
      errorCount: 1,
    });
    expect(service.getProviderHealth()).toEqual([health]);
  });

  it('returns structured rate-limit metadata when a provider responds with 429', async () => {
    const service = serviceWithProviderSearch(['bing'], async () => {
      throw Object.assign(new Error('Bing returned HTTP 429'), {
        rateLimit: { retryAfterMs: 2_500, remaining: 0, limit: 100 },
      });
    });

    const response = await service.search({ query: 'limited' });

    expect(response).toEqual({
      query: 'limited',
      provider: 'bing',
      results: [],
      rateLimit: { provider: 'bing', retryAfterMs: 2_500, remaining: 0, limit: 100 },
    });
    expect(service.getProviderHealth('bing')).toMatchObject({ available: false, errorCount: 1 });
  });

  it('includes an earlier provider rate limit when a fallback succeeds', async () => {
    const service = serviceWithProviderSearch(['bing', 'duckduckgo'], async (provider) => {
      if (provider === 'bing') throw Object.assign(new Error('rate limited'), { status: 429 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [result('fallback', provider)];
    });

    const response = await service.search({ query: 'fallback after limit' });

    expect(response.provider).toBe('duckduckgo');
    expect(response.rateLimit).toEqual({ provider: 'bing' });
  });
});

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
