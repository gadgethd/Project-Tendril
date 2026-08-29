import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { runDoctor } from '../src/doctor.js';

describe('runtime doctor', () => {
  it('reports the no-sandbox override as a failed production readiness check', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-doctor-'));
    try {
      const config = await loadConfig({
        overrides: {
          executablePath: process.execPath,
          dataDir: path.join(root, 'data'),
          runtimeDir: path.join(root, 'run'),
          searchProviders: ['bing'],
        },
      });
      const checks = await runDoctor(config, { TENDRIL_ALLOW_NO_SANDBOX: 'true' });
      expect(checks.find((check) => check.check === 'Chromium binary')).toMatchObject({ ok: true });
      expect(checks.find((check) => check.check === 'Search providers')).toMatchObject({ ok: true });
      expect(checks.find((check) => check.check === 'Chromium sandbox launch')).toMatchObject({
        ok: false,
        detail: expect.stringContaining('not production-ready'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
