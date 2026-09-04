import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { BrowserManager } from '../src/browser/manager.js';
import type { TendrilSession } from '../src/browser/session.js';
import { loadConfig } from '../src/config.js';
import { createRuntime, type TendrilRuntime } from '../src/runtime.js';
import { advertisedHost, formatUrlAuthority, hostHeaderAllowed, normalizeHostAuthority, startHttpServer, type TendrilHttpServer } from '../src/server/http.js';
import { Logger } from '../src/util.js';

let runtime: TendrilRuntime | undefined;
let testManager: BrowserManager | undefined;
let httpServer: TendrilHttpServer | undefined;
afterEach(async () => {
  await httpServer?.close();
  await runtime?.close();
  await testManager?.closeAll();
  httpServer = undefined;
  runtime = undefined;
  testManager = undefined;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('HTTP and CDP interfaces', () => {
  it('normalizes bracketed IPv6 and case-insensitive Host authorities', () => {
    expect(normalizeHostAuthority('[::1]:3210')).toBe('::1');
    expect(normalizeHostAuthority('LOCALHOST:3210')).toBe('localhost');
    expect(normalizeHostAuthority('Example.COM.')).toBe('example.com');
    expect(normalizeHostAuthority('::1:3210')).toBeUndefined();
    expect(normalizeHostAuthority('attacker@example.com')).toBeUndefined();
    expect(normalizeHostAuthority('[fe80::1%25eth0]:3210')).toBeUndefined();
    expect(formatUrlAuthority('::1', 3210)).toBe('[::1]:3210');
    expect(advertisedHost('0.0.0.0')).toBe('127.0.0.1');
    expect(advertisedHost('::')).toBe('::1');
    expect(formatUrlAuthority(advertisedHost('::', '[fd12:3456::1]:3210'), 3210)).toBe('[fd12:3456::1]:3210');
  });

  it('allows only private numeric IPv6 authorities for an IPv6 wildcard listener', () => {
    expect(hostHeaderAllowed('[fc00::1]:3210', '::')).toBe(true);
    expect(hostHeaderAllowed('[fd12:3456::1]:3210', '::')).toBe(true);
    expect(hostHeaderAllowed('[fe80::1]:3210', '::')).toBe(true);
    expect(hostHeaderAllowed('[febf::1]:3210', '::')).toBe(true);
    expect(hostHeaderAllowed('[fec0::1]:3210', '::')).toBe(false);
    expect(hostHeaderAllowed('[2001:4860:4860::8888]:3210', '::')).toBe(false);
    expect(hostHeaderAllowed('private.example:3210', '::')).toBe(false);
    expect(hostHeaderAllowed('[fd12:3456::1]:3210', '127.0.0.1')).toBe(false);
    expect(hostHeaderAllowed('192.168.1.2:3210', '::')).toBe(true);
    expect(hostHeaderAllowed('[::ffff:192.168.1.2]:3210', '::')).toBe(true);
    expect(hostHeaderAllowed('10.evil:3210', '::')).toBe(false);
    expect(hostHeaderAllowed('172.16.evil:3210', '0.0.0.0')).toBe(false);
    expect(hostHeaderAllowed('192.168.attacker.test:3210', '0.0.0.0')).toBe(false);
  });

  it('strips the master Authorization header before proxying CDP HTTP and WebSocket traffic', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-http-cdp-redaction-'));
    const token = 'm'.repeat(32);
    const httpAuthorization = deferred<string | undefined>();
    const wsAuthorization = deferred<string | undefined>();
    const backend = http.createServer((request, response) => {
      httpAuthorization.resolve(request.headers.authorization);
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    });
    backend.on('upgrade', (request, socket) => {
      wsAuthorization.resolve(request.headers.authorization);
      socket.destroy();
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    const backendPort = (backend.address() as AddressInfo).port;
    const config = await loadConfig({
      overrides: {
        port: 0,
        token,
        dataDir: path.join(root, 'data'),
        runtimeDir: path.join(root, 'run'),
        logLevel: 'error',
      },
    });
    const manager = {
      config,
      activeCount: () => 0,
      list: vi.fn(async () => []),
      get: vi.fn(() => ({
        backendCdpHttpUrl: () => `http://127.0.0.1:${backendPort}`,
        supportsSharedCdpGateway: () => true,
      })),
    } as unknown as BrowserManager;
    const logger = new Logger('error');
    try {
      httpServer = await startHttpServer({ manager, search: {} as never, crawl: {} as never, logger });
      const authorization = `Bearer ${token}`;
      const response = await fetch(`http://127.0.0.1:${httpServer.port}/cdp/session/json/version`, {
        headers: { authorization },
      });
      expect(response.status).toBe(200);
      await expect(httpAuthorization.promise).resolves.toBeUndefined();

      const socket = new WebSocket(`ws://127.0.0.1:${httpServer.port}/cdp/session/devtools/browser/test`, {
        headers: { authorization },
      });
      socket.on('error', () => undefined);
      await expect(wsAuthorization.promise).resolves.toBeUndefined();
      socket.terminate();
    } finally {
      await httpServer?.close();
      httpServer = undefined;
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
  });

  it('awaits quick-route lease cleanup before committing success and aggregates dual failures', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-http-quick-cleanup-'));
    const token = 'q'.repeat(32);
    const config = await loadConfig({
      overrides: {
        port: 0,
        token,
        dataDir: path.join(root, 'data'),
        runtimeDir: path.join(root, 'run'),
        logLevel: 'error',
      },
    });
    let mode: 'success' | 'cleanup-failure' | 'dual-failure' = 'success';
    const release = vi.fn(async () => {
      if (mode !== 'success') throw new Error('injected lease cleanup failure');
    });
    const session = {
      setContent: vi.fn(async () => {
        if (mode === 'dual-failure') throw new Error('injected quick operation failure');
      }),
      extract: vi.fn(async () => '<main>quick output</main>'),
    } as unknown as TendrilSession;
    const manager = {
      config,
      activeCount: () => 0,
      list: vi.fn(async () => []),
      acquire: vi.fn(async () => ({ session, release })),
    } as unknown as BrowserManager;
    httpServer = await startHttpServer({ manager, search: {} as never, crawl: {} as never, logger: new Logger('error') });
    const endpoint = `http://127.0.0.1:${httpServer.port}/v1/content`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const success = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ html: '<p>ok</p>' }) });
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ content: '<main>quick output</main>' });
    expect(release).toHaveBeenCalledTimes(1);

    mode = 'cleanup-failure';
    const cleanupFailure = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ html: '<p>ok</p>' }) });
    expect(cleanupFailure.status).toBe(500);
    expect(await cleanupFailure.text()).toContain('injected lease cleanup failure');

    mode = 'dual-failure';
    const dualFailure = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ html: '<p>fail</p>' }) });
    expect(dualFailure.status).toBe(500);
    const dualBody = await dualFailure.text();
    expect(dualBody).toContain('injected quick operation failure');
    expect(dualBody).toContain('injected lease cleanup failure');
    expect(release).toHaveBeenCalledTimes(3);
  });

  it('accepts an IPv6 loopback Host authority and bounds repeated authentication failures', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-http-auth-limit-'));
    runtime = await createRuntime(
      await loadConfig({
        overrides: {
          port: 0,
          dataDir: path.join(root, 'data'),
          runtimeDir: path.join(root, 'run'),
          logLevel: 'error',
        },
      }),
    );
    httpServer = await startHttpServer({ ...runtime });
    const base = `http://127.0.0.1:${httpServer.port}`;
    expect((await fetch(`${base}/health`, { headers: { host: `[::1]:${httpServer.port}` } })).status).toBe(200);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await fetch(`${base}/v1/sessions`)).status).toBe(401);
    }
    expect((await fetch(`${base}/v1/sessions`)).status).toBe(429);
    expect(
      (
        await fetch(`${base}/v1/sessions`, {
          headers: { authorization: `Bearer ${httpServer.token}` },
        })
      ).status,
    ).toBe(200);
    expect((await fetch(`${base}/v1/sessions`)).status).toBe(401);

    for (let attempt = 0; attempt < 75; attempt += 1) {
      expect(
        (
          await fetch(`${base}/cdp/missing/json/version`, {
            headers: { authorization: `Bearer ${httpServer.token}` },
          })
        ).status,
      ).toBe(404);
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await fetch(`${base}/cdp/missing/json/version`)).status).toBe(401);
    }
    expect((await fetch(`${base}/cdp/missing/json/version`)).status).toBe(429);
    expect(
      (
        await fetch(`${base}/cdp/missing/json/version`, {
          headers: { authorization: `Bearer ${httpServer.token}` },
        })
      ).status,
    ).toBe(404);
    expect((await fetch(`${base}/cdp/missing/json/version`)).status).toBe(401);
  });

  it('advertises validated request hosts while wildcard listener URLs remain connectable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-http-advertised-host-'));
    const token = 'a'.repeat(32);
    const config = await loadConfig({
      overrides: {
        host: '0.0.0.0',
        port: 0,
        token,
        dataDir: path.join(root, 'data'),
        runtimeDir: path.join(root, 'run'),
        logLevel: 'error',
      },
    });
    const session = {
      id: 'ses_advertised',
      browserProcess: { browserPath: '/devtools/browser/id' },
      supportsSharedCdpGateway: () => true,
    } as unknown as { id: string };
    const manager = {
      config,
      activeCount: () => 1,
      list: vi.fn(async (cdpUrlFor?: (value: typeof session) => string) => [
        {
          id: session.id,
          cdpUrl: cdpUrlFor?.(session),
        },
      ]),
    } as unknown as BrowserManager;
    httpServer = await startHttpServer({ manager, search: {} as never, crawl: {} as never, logger: new Logger('error') });
    expect(new URL(httpServer.dashboardUrl).hostname).toBe('127.0.0.1');
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.get(
        {
          hostname: '127.0.0.1',
          port: httpServer!.port,
          path: '/v1/sessions',
          headers: { host: `192.168.1.20:${httpServer!.port}`, authorization: `Bearer ${token}` },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      request.once('error', reject);
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { sessions: Array<{ cdpUrl: string }> };
    expect(new URL(body.sessions[0]!.cdpUrl).hostname).toBe('192.168.1.20');
  });

  it('serves REST quick actions and an authenticated raw CDP endpoint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-http-'));
    runtime = await createRuntime(
      await loadConfig({ overrides: { port: 0, dataDir: path.join(root, 'data'), runtimeDir: path.join(root, 'run'), maxSessions: 1, logLevel: 'error' } }),
    );
    httpServer = await startHttpServer({ ...runtime });
    const base = `http://127.0.0.1:${httpServer.port}`;
    const auth = { authorization: `Bearer ${httpServer.token}`, 'content-type': 'application/json' };
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/dashboard`)).status).toBe(200);
    expect((await fetch(`${base}/openapi.json`)).status).toBe(401);
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        })
      ).status,
    ).toBe(401);
    expect((await fetch(`${base}/v1/sessions`)).status).toBe(401);
    expect((await fetch(`${base}/v1/sessions`, { headers: { authorization: 'Bearer invalid-token' } })).status).toBe(401);
    const createdResponse = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ profile: 'quick-route-profile' }) });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { id: string };
    await fetch(`${base}/v1/sessions/${created.id}/content`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ html: '<title>CDP fixture</title><h1>Hello CDP</h1>' }),
    });
    const sessions = (await (await fetch(`${base}/v1/sessions`, { headers: auth })).json()) as { sessions: Array<{ cdpUrl: string }> };
    expect(sessions.sessions[0]!.cdpUrl).not.toContain(httpServer.token);
    expect(new URL(sessions.sessions[0]!.cdpUrl!).searchParams.has('capability')).toBe(true);
    const unprivilegedCdpUrl = new URL(sessions.sessions[0]!.cdpUrl!);
    unprivilegedCdpUrl.protocol = 'http:';
    unprivilegedCdpUrl.search = '';
    expect((await fetch(unprivilegedCdpUrl)).status).toBe(401);
    const browser = await chromium.connectOverCDP(sessions.sessions[0]!.cdpUrl!);
    expect(await browser.contexts()[0]!.pages()[0]!.title()).toBe('CDP fixture');
    await browser.close();
    const snapshot = (await (
      await fetch(`${base}/v1/sessions/${created.id}/snapshot`, { method: 'POST', headers: auth, body: JSON.stringify({ mode: 'full' }) })
    ).json()) as { content: string };
    expect(snapshot.content).toContain('Hello CDP');

    const quick = await fetch(`${base}/v1/content`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ profile: 'quick-route-profile', html: '<h1>Borrowed profile</h1>' }),
    });
    expect(quick.status).toBe(200);
    expect((await runtime.manager.list()).map((session) => session.id)).toEqual([created.id]);
  });

  it('keeps a pending-profile quick session alive until concurrent borrowers finish', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-http-lease-'));
    const launch = deferred<void>();
    const borrowerStarted = deferred<void>();
    const finishBorrower = deferred<void>();
    const close = vi.fn(async () => undefined);
    const logger = new Logger('error');
    const config = await loadConfig({
      overrides: {
        port: 0,
        dataDir: path.join(root, 'data'),
        runtimeDir: path.join(root, 'run'),
        maxSessions: 1,
        logLevel: 'error',
      },
    });
    const factory = vi.fn(async (options: Parameters<typeof TendrilSession.create>[0]) => {
      await launch.promise;
      return {
        id: options.id,
        profile: options.profile,
        ephemeral: options.profile === undefined,
        createOptions: structuredClone(options.createOptions),
        lastActivityAt: new Date(),
        close,
        setContent: vi.fn(async (html: string) => {
          if (html.includes('borrower')) {
            borrowerStarted.resolve();
            await finishBorrower.promise;
          }
        }),
        extract: vi.fn(async () => '<main>content</main>'),
        info: vi.fn(async () => ({
          id: options.id,
          ...(options.profile ? { profile: options.profile } : {}),
          ephemeral: options.profile === undefined,
          headless: true,
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          pages: [],
        })),
      } as unknown as TendrilSession;
    });
    testManager = new BrowserManager(config, logger, factory);
    await testManager.start();
    httpServer = await startHttpServer({ manager: testManager, search: {} as never, crawl: {} as never, logger });
    const base = `http://127.0.0.1:${httpServer.port}`;
    const headers = { authorization: `Bearer ${httpServer.token}`, 'content-type': 'application/json' };
    const acquire = vi.spyOn(testManager, 'acquire');

    const creatorRequest = fetch(`${base}/v1/content`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ profile: 'shared', html: '<p>creator</p>' }),
    });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    const borrowerRequest = fetch(`${base}/v1/content`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ profile: 'shared', html: '<p>borrower</p>' }),
    });
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
    launch.resolve();
    await borrowerStarted.promise;

    expect((await creatorRequest).status).toBe(200);
    expect(close).not.toHaveBeenCalled();
    expect(testManager.activeCount()).toBe(1);

    finishBorrower.resolve();
    expect((await borrowerRequest).status).toBe(200);
    expect(close).toHaveBeenCalledTimes(1);
    expect(testManager.activeCount()).toBe(0);
  });
});
