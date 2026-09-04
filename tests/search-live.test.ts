import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { isOfficialMcpUrl, SearchService } from '../src/browser/search.js';
import { BrowserManager } from '../src/browser/manager.js';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { createRuntime, type TendrilRuntime } from '../src/runtime.js';
import { Logger } from '../src/util.js';

const endpoint = process.env.TENDRIL_LIVE_SEARXNG_URL;

it.skipIf(process.env.TENDRIL_LIVE_SEARCH !== 'true')(
  'smokes public providers without browser processes',
  async () => {
    const logger = new Logger('error');
    const manager = new BrowserManager({ ...DEFAULT_CONFIG, searchProviders: ['duckduckgo', 'bing'] }, logger);
    const search = new SearchService(manager, logger);
    try {
      for (const query of ['TypeScript handbook', 'Node.js HTTP documentation', 'Model Context Protocol specification']) {
        const started = Date.now();
        const response = await search.search({ query, maxResults: 5, timeoutMs: 12_000 });
        expect(response.results.length).toBeGreaterThan(0);
        expect(response.results.every((result) => /^https?:\/\//.test(result.url) && result.title.length > 0)).toBe(true);
        expect(manager.activeCount()).toBe(0);
        console.info(
          JSON.stringify({
            query,
            elapsedMs: Date.now() - started,
            providers: response.providers,
            resultCount: response.results.length,
            partial: response.partial ?? false,
          }),
        );
      }
    } finally {
      await search.close();
      await manager.closeAll();
    }
  },
  40_000,
);

it.skipIf(!endpoint)(
  'smokes the configured SearXNG endpoint with deterministic quality provenance',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-live-searx-'));
    let runtime: TendrilRuntime | undefined;
    try {
      runtime = await createRuntime(
        await loadConfig({
          overrides: {
            dataDir: path.join(root, 'data'),
            runtimeDir: path.join(root, 'run'),
            searchProviders: ['searxng'],
            searxngUrl: endpoint,
            blockPrivateNetworks: false,
            maxSessions: 1,
            logLevel: 'error',
          },
        }),
      );
      const response = await runtime.search.search({
        query: 'Model Context Protocol official specification',
        maxResults: 5,
        timeoutMs: 20_000,
      });

      expect(response.provider).toBe('searxng');
      expect(isOfficialMcpUrl(response.results[0]!.url)).toBe(true);
      expect(response.results[0]).toEqual(
        expect.objectContaining({
          provider: 'searxng',
          providerScore: expect.any(Number),
          engines: expect.any(Array),
        }),
      );
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
