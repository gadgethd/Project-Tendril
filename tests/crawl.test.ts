import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrawlService } from '../src/browser/crawl.js';
import type { BrowserManager } from '../src/browser/manager.js';
import type { TendrilSession } from '../src/browser/session.js';
import { loadConfig } from '../src/config.js';
import { createRuntime, type TendrilRuntime } from '../src/runtime.js';
import { Logger } from '../src/util.js';

let runtime: TendrilRuntime | undefined;
let fixture: http.Server | undefined;
afterEach(async () => {
  await runtime?.close();
  if (fixture) await new Promise<void>((resolve) => fixture!.close(() => resolve()));
  runtime = undefined;
  fixture = undefined;
});

describe('CrawlService', () => {
  it('rejects unsafe URLs and non-finite crawl bounds without echoing credentials', () => {
    const service = new CrawlService({} as BrowserManager, new Logger('error'));
    expect(() => service.start({ url: 'ftp://example.com/file' })).toThrow('credential-free HTTP(S)');
    let credentialError = '';
    try {
      service.start({ url: 'https://user:do-not-echo@example.com/' });
    } catch (error) {
      credentialError = error instanceof Error ? error.message : String(error);
    }
    expect(credentialError).toContain('credential-free HTTP(S)');
    expect(credentialError).not.toContain('do-not-echo');
    expect(() => service.start({ url: 'https://example.com/', maxPages: Number.NaN })).toThrow('finite integer');
    expect(() => service.start({ url: 'https://example.com/', maxDepth: Number.POSITIVE_INFINITY })).toThrow('finite integer');
  });

  it('starts follow-up jobs with validated parent lineage', () => {
    const service = new CrawlService({} as BrowserManager, new Logger('error'));
    const run = vi.fn(async () => undefined);
    Object.defineProperty(service, 'run', { value: run });

    const parent = service.start({ url: 'https://example.com/root' });
    const child = service.followUp(parent.id, { url: 'https://example.com/detail', maxPages: 3 });

    expect(parent.parentJobId).toBeUndefined();
    expect(child.parentJobId).toBe(parent.id);
    expect(service.get(child.id).parentJobId).toBe(parent.id);
    expect(child.id).not.toBe(parent.id);
    expect(run).toHaveBeenCalledTimes(2);
    expect(() => service.followUp('missing', { url: 'https://example.com' })).toThrow('Crawl job not found: missing');
  });

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
    runtime = await createRuntime(
      await loadConfig({
        overrides: {
          dataDir: path.join(root, 'data'),
          runtimeDir: path.join(root, 'run'),
          maxSessions: 1,
          blockPrivateNetworks: false,
          logLevel: 'error',
        },
      }),
    );
    const job = runtime.crawl.start({ url: `http://127.0.0.1:${port}/`, maxPages: 5, maxDepth: 2 });
    let current = runtime.crawl.get(job.id);
    const deadline = Date.now() + 20_000;
    while (current.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      current = runtime.crawl.get(job.id);
    }
    expect(current.status).toBe('completed');
    expect(current).not.toHaveProperty('results');
    const page = runtime.crawl.results(job.id, { limit: 2 });
    const remaining = page.nextOffset === undefined ? { results: [] } : runtime.crawl.results(job.id, { offset: page.nextOffset, limit: 2 });
    const results = [...page.results, ...remaining.results];
    const diagnostics = JSON.stringify({ privateRequests, results });
    expect(results.find((item) => item.url.endsWith('/page'))?.markdown, diagnostics).toContain('Allowed page');
    const privateResult = results.find((item) => item.url.endsWith('/private'));
    expect(privateResult?.error, diagnostics).toBe('Blocked by robots.txt');
    expect(privateRequests).toBe(0);
    expect(await runtime.manager.list()).toHaveLength(0);
  });

  it('cancels active work, keeps status non-terminal until cleanup, and bounds retained jobs', async () => {
    let now = 0;
    let sequence = 0;
    const sessions = new Map<string, TendrilSession>();
    const manager = {
      create: vi.fn(async () => {
        sequence += 1;
        const id = `fake-${sequence}`;
        const session = {
          id,
          fetchText: vi.fn(async () => {
            throw new Error('no robots fixture');
          }),
          navigate: vi.fn(async () => ({ status: 200 })),
          extract: vi.fn(async () => ({ title: id, markdown: `body ${id}`, links: [] })),
        } as unknown as TendrilSession;
        sessions.set(id, session);
        return session;
      }),
      close: vi.fn(async (id: string) => {
        sessions.delete(id);
      }),
    } as unknown as BrowserManager;
    const service = new CrawlService(manager, new Logger('error'), { maxJobs: 2, retentionMs: 1_000, now: () => now });

    const first = service.start({ url: 'https://example.com/one', respectRobots: false });
    const second = service.start({ url: 'https://example.com/two', respectRobots: false });
    await vi.waitFor(() => {
      expect(service.get(first.id).status).toBe('completed');
      expect(service.get(second.id).status).toBe('completed');
    });
    expect(service.results(first.id, { limit: 1 })).toMatchObject({ offset: 0, limit: 1, total: 1 });

    const third = service.start({ url: 'https://example.com/three', respectRobots: false });
    await vi.waitFor(() => expect(service.get(third.id).status).toBe('completed'));
    expect(() => service.get(first.id)).toThrow(`Crawl job not found: ${first.id}`);
    now = 2_000;
    expect(() => service.get(second.id)).toThrow(`Crawl job not found: ${second.id}`);
    await service.close();
  });

  it('publishes terminal cancellation only after the active session is closed', async () => {
    let rejectNavigation!: (error: Error) => void;
    const navigation = new Promise<never>((_resolve, reject) => {
      rejectNavigation = reject;
    });
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const session = {
      id: 'fake-active',
      navigate: vi.fn(() => navigation),
      extract: vi.fn(),
    } as unknown as TendrilSession;
    let closePromise: Promise<void> | undefined;
    const manager = {
      create: vi.fn(async () => session),
      close: vi.fn(() => {
        if (!closePromise) {
          rejectNavigation(new Error('session closed'));
          closePromise = cleanup;
        }
        return closePromise;
      }),
    } as unknown as BrowserManager;
    const service = new CrawlService(manager, new Logger('error'));
    const job = service.start({ url: 'https://example.com/slow', respectRobots: false });
    await vi.waitFor(() => expect(session.navigate).toHaveBeenCalled());
    const closing = service.close();
    expect(service.get(job.id).status).toBe('running');
    releaseCleanup();
    await closing;
    expect(service.get(job.id).status).toBe('cancelled');
    expect(manager.close).toHaveBeenCalled();
  });

  it('publishes cancellation cleanup failure instead of swallowing the first close rejection', async () => {
    let rejectNavigation!: (error: Error) => void;
    const navigation = new Promise<never>((_resolve, reject) => {
      rejectNavigation = reject;
    });
    let rejectCleanup!: (error: Error) => void;
    const cleanup = new Promise<void>((_resolve, reject) => {
      rejectCleanup = reject;
    });
    const session = {
      id: 'cleanup-failure-session',
      navigate: vi.fn(() => navigation),
      extract: vi.fn(),
    } as unknown as TendrilSession;
    const manager = {
      create: vi.fn(async () => session),
      close: vi
        .fn()
        .mockImplementationOnce(() => cleanup)
        .mockResolvedValue(undefined),
    } as unknown as BrowserManager;
    const service = new CrawlService(manager, new Logger('error'));
    const job = service.start({ url: 'https://example.com/slow-cleanup', respectRobots: false });
    await vi.waitFor(() => expect(session.navigate).toHaveBeenCalled());

    expect(service.cancel(job.id).status).toBe('running');
    rejectNavigation(new Error('navigation interrupted by cancellation'));
    await Promise.resolve();
    rejectCleanup(new Error('injected close cleanup failure'));

    await vi.waitFor(() =>
      expect(service.get(job.id)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('injected close cleanup failure'),
      }),
    );
    expect(manager.close).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it('cancels a crawl stuck before navigation and settles close after manager cleanup', async () => {
    const fetchText = vi.fn(() => new Promise<{ status: number | null; text: string }>(() => {}));
    const session = {
      id: 'stuck-robots-session',
      fetchText,
      navigate: vi.fn(),
      extract: vi.fn(),
    } as unknown as TendrilSession;
    const manager = {
      create: vi.fn(async () => session),
      close: vi.fn(async () => undefined),
    } as unknown as BrowserManager;
    const service = new CrawlService(manager, new Logger('error'), { jobTimeoutMs: 10_000 });
    const job = service.start({ url: 'https://example.com/stuck-robots' });
    await vi.waitFor(() => expect(fetchText).toHaveBeenCalledOnce());
    service.cancel(job.id);
    const started = Date.now();
    await service.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(service.get(job.id).status).toBe('cancelled');
    expect(manager.close).toHaveBeenCalledOnce();
    expect(session.navigate).not.toHaveBeenCalled();
  });

  it('keeps cancellation non-terminal until a pending creation is closed and surfaces late cleanup failure', async () => {
    let resolveCreation!: (session: TendrilSession) => void;
    const creation = new Promise<TendrilSession>((resolve) => {
      resolveCreation = resolve;
    });
    let releaseClose!: () => void;
    const close = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const session = { id: 'late-created-session' } as TendrilSession;
    const manager = {
      create: vi.fn(() => creation),
      close: vi.fn(() => close),
    } as unknown as BrowserManager;
    const service = new CrawlService(manager, new Logger('error'), { creationCleanupTimeoutMs: 1_000 });
    const job = service.start({ url: 'https://example.com/pending-create', respectRobots: false });
    service.cancel(job.id);
    expect(service.get(job.id).status).toBe('running');
    resolveCreation(session);
    await vi.waitFor(() => expect(manager.close).toHaveBeenCalledWith(session.id));
    expect(service.get(job.id).status).toBe('running');
    releaseClose();
    await vi.waitFor(() => expect(service.get(job.id).status).toBe('cancelled'));
    await service.close();

    let resolveFailedCreation!: (created: TendrilSession) => void;
    const failedCreation = new Promise<TendrilSession>((resolve) => {
      resolveFailedCreation = resolve;
    });
    const failedManager = {
      create: vi.fn(() => failedCreation),
      close: vi.fn(async () => {
        throw new Error('late close failed');
      }),
    } as unknown as BrowserManager;
    const failedService = new CrawlService(failedManager, new Logger('error'), { creationCleanupTimeoutMs: 1_000 });
    const failedJob = failedService.start({ url: 'https://example.com/pending-failure', respectRobots: false });
    failedService.cancel(failedJob.id);
    resolveFailedCreation({ id: 'late-failed-session' } as TendrilSession);
    await vi.waitFor(() =>
      expect(failedService.get(failedJob.id)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('late close failed'),
      }),
    );
    await failedService.close();
  });

  it('reports a job deadline as failed instead of swallowing it into a completed page result', async () => {
    const session = {
      id: 'deadline-session',
      navigate: vi.fn(() => new Promise(() => {})),
      extract: vi.fn(),
    } as unknown as TendrilSession;
    const manager = {
      create: vi.fn(async () => session),
      close: vi.fn(async () => undefined),
    } as unknown as BrowserManager;
    const service = new CrawlService(manager, new Logger('error'), { jobTimeoutMs: 100 });
    const job = service.start({ url: 'https://example.com/deadline', respectRobots: false });
    await vi.waitFor(() => expect(service.get(job.id).status).toBe('failed'));
    expect(service.get(job.id).error).toContain('execution deadline');
    expect(service.results(job.id).results).toHaveLength(0);
    expect(manager.close).toHaveBeenCalledOnce();
    await service.close();
  });

  it('checks redirect destinations against robots and records requested/final provenance before extraction', async () => {
    const fetchText = vi.fn(async (url: string) => ({
      status: 200,
      text: url.startsWith('https://destination.example/') ? 'User-agent: *\nDisallow: /private\n' : 'User-agent: *\nAllow: /\n',
    }));
    const session = {
      id: 'redirect-robots-session',
      fetchText,
      navigate: vi.fn(async () => ({
        url: 'https://destination.example/private?secret=destination-secret',
        title: 'private',
        status: 200,
      })),
      extract: vi.fn(async () => ({ title: 'must not extract', markdown: 'secret', links: [] })),
    } as unknown as TendrilSession;
    const manager = {
      create: vi.fn(async () => session),
      close: vi.fn(async () => undefined),
    } as unknown as BrowserManager;
    const service = new CrawlService(manager, new Logger('error'));
    const job = service.start({ url: 'https://source.example/start?token=source-secret', sameOrigin: false });
    await vi.waitFor(() => expect(service.get(job.id).status).toBe('completed'));
    const redirected = service.results(job.id).results[0]!;
    expect(redirected).toMatchObject({
      error: 'Blocked by robots.txt after redirect',
    });
    expect(new URL(redirected.requestedUrl).searchParams.get('token')).toBe('[redacted]');
    expect(new URL(redirected.finalUrl).searchParams.get('secret')).toBe('[redacted]');
    expect(JSON.stringify(redirected)).not.toContain('source-secret');
    expect(JSON.stringify(redirected)).not.toContain('destination-secret');
    expect(fetchText).toHaveBeenCalledWith('https://destination.example/robots.txt', undefined, expect.any(AbortSignal));
    expect(session.extract).not.toHaveBeenCalled();
    await service.close();
  });

  it('rejects a cross-origin final URL under same-origin mode and redacts bounded page errors', async () => {
    const extract = vi.fn();
    const session = {
      id: 'redirect-origin-session',
      navigate: vi
        .fn()
        .mockResolvedValueOnce({ url: 'https://other.example/page', status: 200 })
        .mockRejectedValueOnce(new Error(`navigation failed https://example.com/path?opaque=do-not-echo ${'x'.repeat(3_000)}`)),
      extract,
    } as unknown as TendrilSession;
    const manager = {
      create: vi.fn(async () => session),
      close: vi.fn(async () => undefined),
    } as unknown as BrowserManager;
    const service = new CrawlService(manager, new Logger('error'));
    const crossOrigin = service.start({ url: 'https://example.com/start', respectRobots: false });
    await vi.waitFor(() => expect(service.get(crossOrigin.id).status).toBe('completed'));
    expect(service.results(crossOrigin.id).results[0]?.error).toBe('Navigation redirected outside the allowed origin');
    expect(extract).not.toHaveBeenCalled();

    const failed = service.start({ url: 'https://example.com/fail', respectRobots: false });
    await vi.waitFor(() => expect(service.get(failed.id).status).toBe('completed'));
    const message = service.results(failed.id).results[0]!.error!;
    expect(message).not.toContain('do-not-echo');
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(2_048);
    await service.close();
  });

  it('evicts completed jobs on an unrefed expiry timer and clears timers on close', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const session = {
        id: 'expiry-session',
        navigate: vi.fn(async () => ({ status: 200 })),
        extract: vi.fn(async () => ({ title: 'done', markdown: 'done', links: [] })),
      } as unknown as TendrilSession;
      const manager = {
        create: vi.fn(async () => session),
        close: vi.fn(async () => undefined),
      } as unknown as BrowserManager;
      const service = new CrawlService(manager, new Logger('error'), { retentionMs: 1_000 });
      const job = service.start({ url: 'https://example.com/expiry', respectRobots: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.get(job.id).status).toBe('completed');
      const jobs = (service as unknown as { jobs: Map<string, unknown> }).jobs;
      expect(jobs.has(job.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(jobs.has(job.id)).toBe(false);
      await service.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds UTF-8 markdown bytes per result and across a retained job', async () => {
    let page = 0;
    const session = {
      id: 'bounded-session',
      navigate: vi.fn(async () => ({ status: 200 })),
      extract: vi.fn(async () => {
        page += 1;
        return {
          title: `page-${page}`,
          markdown: '💥'.repeat(100),
          links: page === 1 ? [{ url: 'https://example.com/second' }] : [],
        };
      }),
    } as unknown as TendrilSession;
    const manager = {
      create: vi.fn(async () => session),
      close: vi.fn(async () => undefined),
    } as unknown as BrowserManager;
    const service = new CrawlService(manager, new Logger('error'), {
      maxResultMarkdownBytes: 80,
      maxJobMarkdownBytes: 120,
    });
    const job = service.start({
      url: 'https://example.com/first',
      maxPages: 2,
      maxDepth: 1,
      respectRobots: false,
    });
    await vi.waitFor(() => expect(service.get(job.id).status).toBe('completed'));
    const results = service.results(job.id, { limit: 10 }).results;
    expect(results).toHaveLength(2);
    expect(results.every((result) => Buffer.byteLength(result.markdown ?? '') <= 80)).toBe(true);
    expect(results.reduce((total, result) => total + Buffer.byteLength(result.markdown ?? ''), 0)).toBeLessThanOrEqual(120);
    expect(results.every((result) => !(result.markdown ?? '').includes('�'))).toBe(true);
    await service.close();
  });

  it('bounds retained titles and links by count and bytes with truncation metadata', async () => {
    const session = {
      id: 'bounded-links-session',
      navigate: vi.fn(async () => ({ url: 'https://example.com/root', status: 200 })),
      extract: vi.fn(async () => ({
        title: '💥'.repeat(1_000),
        markdown: 'body',
        links: Array.from({ length: 5_000 }, (_value, index) => ({
          url: `https://example.com/page-${index}?secret=${'x'.repeat(4_000)}`,
        })),
      })),
    } as unknown as TendrilSession;
    const manager = {
      create: vi.fn(async () => session),
      close: vi.fn(async () => undefined),
    } as unknown as BrowserManager;
    const service = new CrawlService(manager, new Logger('error'), {
      maxResultLinks: 10,
      maxJobLinks: 12,
      maxResultLinkBytes: 600,
      maxJobLinkBytes: 800,
      maxResultTitleBytes: 20,
      maxJobTitleBytes: 20,
    });
    const job = service.start({ url: 'https://example.com/root', maxDepth: 0, respectRobots: false });
    await vi.waitFor(() => expect(service.get(job.id).status).toBe('completed'));
    const result = service.results(job.id).results[0]!;
    expect(Buffer.byteLength(result.title ?? '')).toBeLessThanOrEqual(20);
    expect(result.links.length).toBeLessThanOrEqual(10);
    expect(result.links.reduce((total, link) => total + Buffer.byteLength(link), 0)).toBeLessThanOrEqual(600);
    expect(result.truncated).toMatchObject({ title: true, links: true });
    expect(JSON.stringify(result)).not.toContain('x'.repeat(100));
    await service.close();
  });
});
