import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRuntime, type TendrilRuntime } from '../src/runtime.js';

let runtime: TendrilRuntime | undefined;
let fixture: http.Server | undefined;
afterEach(async () => {
  await runtime?.close();
  if (fixture) await new Promise<void>((resolve) => fixture!.close(() => resolve()));
  runtime = undefined;
  fixture = undefined;
});

describe('CrawlService', () => {
  it('uses Chromium and respects robots.txt', async () => {
    let privateRequests = 0;
    fixture = http.createServer((request, response) => {
      if (request.url === '/robots.txt') {
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        return void response.end('User-agent: *\nDisallow: /private\n');
      }
      response.setHeader('content-type', 'text/html');
      if (request.url === '/') return void response.end('<title>Root</title><main><h1>Root</h1><a href="/page">Page</a><a href="/private">Private</a></main>');
      if (request.url === '/page') return void response.end('<title>Page</title><main><h1>Allowed page</h1></main>');
      if (request.url === '/private') privateRequests += 1;
      response.end('<title>Private</title><main>Should not be crawled</main>');
    });
    await new Promise<void>((resolve) => fixture!.listen(0, '127.0.0.1', () => resolve()));
    const port = (fixture.address() as AddressInfo).port;
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-crawl-'));
    runtime = await createRuntime(await loadConfig({ overrides: {
      dataDir: path.join(root, 'data'), runtimeDir: path.join(root, 'run'), maxSessions: 1,
      blockPrivateNetworks: false, logLevel: 'error',
    } }));
    const job = runtime.crawl.start({ url: `http://127.0.0.1:${port}/`, maxPages: 5, maxDepth: 2 });
    let current = runtime.crawl.get(job.id);
    const deadline = Date.now() + 20_000;
    while (current.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      current = runtime.crawl.get(job.id);
    }
    expect(current.status).toBe('completed');
    const diagnostics = JSON.stringify({ privateRequests, results: current.results });
    expect(current.results.find((item) => item.url.endsWith('/page'))?.markdown, diagnostics).toContain('Allowed page');
    const privateResult = current.results.find((item) => item.url.endsWith('/private'));
    expect(privateResult?.error, diagnostics).toBe('Blocked by robots.txt');
    expect(privateRequests).toBe(0);
  });
});
