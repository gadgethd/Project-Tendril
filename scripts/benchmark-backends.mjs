import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, loadConfig } from '../dist/index.js';

const requestedRuns = Number(process.argv.find((value) => value.startsWith('--runs='))?.split('=')[1] ?? 5);
const runs = Number.isInteger(requestedRuns) && requestedRuns > 0 ? requestedRuns : 5;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(values) {
  return {
    median: Math.round(median(values) * 10) / 10,
    mean: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10,
  };
}

async function rssMiB(pid) {
  if (process.platform !== 'linux' || !pid) return undefined;
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const kib = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]);
    return Number.isFinite(kib) ? kib / 1024 : undefined;
  } catch {
    return undefined;
  }
}

async function benchmark(backend, url) {
  const root = await mkdtemp(path.join(os.tmpdir(), `tendril-benchmark-${backend}-`));
  const runtime = await createRuntime(
    await loadConfig({
      overrides: {
        browserBackend: backend,
        obscuraExecutablePath: process.env.TENDRIL_OBSCURA_PATH,
        dataDir: path.join(root, 'data'),
        runtimeDir: path.join(root, 'run'),
        blockPrivateNetworks: false,
        maxSessions: 1,
        logLevel: 'error',
      },
    }),
  );
  const samples = [];
  try {
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      const session = await runtime.manager.create();
      const created = performance.now();
      await session.navigate({ url, waitUntil: 'domcontentloaded' });
      const navigated = performance.now();
      await session.snapshot({ mode: 'interactive' });
      const snapshotted = performance.now();
      samples.push({
        startupMs: created - started,
        navigationMs: navigated - created,
        snapshotMs: snapshotted - navigated,
        totalMs: snapshotted - started,
        rssMiB: await rssMiB(session.browserProcess.child.pid),
      });
      await runtime.manager.close(session.id);
    }
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
  const numeric = (key) => samples.map((sample) => sample[key]).filter((value) => value !== undefined);
  return {
    backend,
    runs,
    startupMs: summarize(numeric('startupMs')),
    navigationMs: summarize(numeric('navigationMs')),
    snapshotMs: summarize(numeric('snapshotMs')),
    totalMs: summarize(numeric('totalMs')),
    rssMiB: numeric('rssMiB').length ? summarize(numeric('rssMiB')) : undefined,
  };
}

const fixture = http.createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>Benchmark</title><main><h1>Tendril</h1><label>Query <input id="query"></label><button>Search</button></main>');
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const address = fixture.address();
const url = `http://127.0.0.1:${address.port}/`;

try {
  const results = [];
  for (const backend of ['obscura', 'chromium']) results.push(await benchmark(backend, url));
  console.log(JSON.stringify({ fixture: 'local deterministic HTML', results }, null, 2));
} finally {
  await new Promise((resolve, reject) => fixture.close((error) => (error ? reject(error) : resolve())));
}
