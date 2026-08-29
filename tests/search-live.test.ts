import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRuntime, type TendrilRuntime } from '../src/runtime.js';
import { isOfficialMcpUrl } from '../src/browser/search.js';

const endpoint = process.env.TENDRIL_LIVE_SEARXNG_URL;

it.skipIf(!endpoint)('smokes the configured SearXNG endpoint with deterministic quality provenance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-live-searx-'));
  let runtime: TendrilRuntime | undefined;
  try {
    runtime = await createRuntime(await loadConfig({ overrides: {
      dataDir: path.join(root, 'data'),
      runtimeDir: path.join(root, 'run'),
      searchProviders: ['searxng'],
      searxngUrl: endpoint,
      blockPrivateNetworks: false,
      maxSessions: 1,
      logLevel: 'error',
    } }));
    const response = await runtime.search.search({
      query: 'Model Context Protocol official specification',
      maxResults: 5,
      timeoutMs: 20_000,
    });

    expect(response.provider).toBe('searxng');
    expect(isOfficialMcpUrl(response.results[0]!.url)).toBe(true);
    expect(response.results[0]).toEqual(expect.objectContaining({
      provider: 'searxng',
      providerScore: expect.any(Number),
      engines: expect.any(Array),
    }));
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
