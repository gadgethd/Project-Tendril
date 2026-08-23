import { describe, expect, it } from 'vitest';
import { SearchCache } from '../src/browser/search.js';
import type { SearchResult } from '../src/types.js';

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
