import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { TendrilError } from '../src/errors.js';
import { createRuntime, type TendrilRuntime } from '../src/runtime.js';

let runtime: TendrilRuntime | undefined;
afterEach(async () => { await runtime?.close(); runtime = undefined; });

describe('TendrilSession', () => {
  it('flushes a named-profile cookie before close and restores it after reopening', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-profile-reopen-'));
    runtime = await createRuntime(await loadConfig({ overrides: {
      dataDir: path.join(root, 'data'), runtimeDir: path.join(root, 'run'), maxSessions: 1, logLevel: 'error',
    } }));
    const first = await runtime.manager.create({ profile: 'cookie-reopen' });
    await first.importCookies([{ name: 'persisted', value: 'yes', url: 'https://example.test/' }]);
    await runtime.manager.close(first.id);

    const reopened = await runtime.manager.create({ profile: 'cookie-reopen' });
    expect(await reopened.exportCookies()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'persisted', value: 'yes', domain: 'example.test' }),
    ]));
  });

  it('drives a semantic snapshot and element refs in real Chromium', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-test-'));
    const config = await loadConfig({ overrides: { dataDir: path.join(root, 'data'), runtimeDir: path.join(root, 'run'), maxSessions: 1, logLevel: 'error' } });
    runtime = await createRuntime(config);
    const session = await runtime.manager.create();
    await session.setContent(`<!doctype html><title>Fixture</title><main><h1>Test form</h1><label>Name <input id="name"></label><button id="save" onclick="document.querySelector('h1').textContent='Saved '+document.querySelector('#name').value">Save</button></main>`);
    const snapshot = await session.snapshot({ mode: 'interactive' });
    expect(snapshot.content).toContain('textbox');
    expect(snapshot.content).toContain('button');
    const inputRef = snapshot.content.match(/textbox[^\n]*\[ref=(e\d+)\]/)?.[1];
    const buttonRef = snapshot.content.match(/button[^\n]*\[ref=(e\d+)\]/)?.[1];
    expect(inputRef).toBeTruthy();
    expect(buttonRef).toBeTruthy();
    await session.act({ action: 'fill', ref: inputRef, text: 'Tendril' });
    const refreshed = await session.snapshot({ mode: 'interactive' });
    const refreshedButton = refreshed.content.match(/button[^\n]*\[ref=(e\d+)\]/)?.[1];
    await session.act({ action: 'click', ref: refreshedButton });
    expect(await session.extract({ format: 'text' })).toContain('Saved Tendril');
    const capture = await session.capture({ format: 'png' });
    expect(capture.mimeType).toBe('image/png');
    expect(Buffer.byteLength(capture.data, 'base64')).toBeGreaterThan(1000);
    expect(session.getActivityLog().map((entry) => entry.type)).toEqual([
      'snapshot', 'act', 'snapshot', 'act', 'extract', 'capture',
    ]);
    const pages = await session.listPagesWithContext();
    expect(pages[0]?.lastSnapshot).toHaveLength(Math.min(500, refreshed.content.length));

    await session.setContent('<title>Just a moment...</title><div class="cf-turnstile">Verify you are human</div>');
    const challenge = await session.detectChallenge();
    expect(challenge).toMatchObject({ detected: true, provider: 'turnstile', kind: 'widget', headed: false });
  });

  it('rejects non-http navigation protocols', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-test-'));
    runtime = await createRuntime(await loadConfig({ overrides: { dataDir: path.join(root, 'data'), runtimeDir: path.join(root, 'run'), maxSessions: 1, logLevel: 'error' } }));
    const session = await runtime.manager.create();
    await expect(session.navigate({ url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });
  });

  it('enforces fetch body limits, deadlines, and cancellation during streaming I/O', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-fetch-'));
    const server = http.createServer((request, response) => {
      if (request.url === '/large') {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2048' });
        response.end('x'.repeat(2048));
        return;
      }
      const timer = setTimeout(() => { response.writeHead(200); response.end('late'); }, 1_000);
      timer.unref();
      request.once('close', () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      runtime = await createRuntime(await loadConfig({ overrides: {
        dataDir: path.join(root, 'data'), runtimeDir: path.join(root, 'run'), maxSessions: 1,
        maxResponseBodyBytes: 1024, blockPrivateNetworks: false, logLevel: 'error',
      } }));
      const session = await runtime.manager.create();
      await expect(session.fetchText(`${base}/large`)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
      for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        await expect(session.fetchText(`${base}/large`, undefined, { maxBytes }))
          .rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
      }
      await expect(session.fetchText(`${base}/slow`, undefined, { deadlineMs: Date.now() + 30 }))
        .rejects.toMatchObject({ code: 'TIMEOUT' });

      const controller = new AbortController();
      const startedAt = Date.now();
      const pending = session.fetchText(`${base}/slow`, undefined, { signal: controller.signal });
      setTimeout(() => controller.abort(new TendrilError('CANCELLED', 'cancel test')), 20).unref();
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', message: 'cancel test' });
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('exports session state, reports health, and saves downloads inside workspace roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-test-'));
    const server = http.createServer((request, response) => {
      if (request.url === '/file') {
        response.writeHead(200, {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="fixture.txt"',
        });
        response.end('download body');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>State</title><a href="/file" download>Download fixture</a>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
    const url = `http://127.0.0.1:${address.port}/`;

    try {
      const config = await loadConfig({
        overrides: {
          dataDir: path.join(root, 'data'), runtimeDir: path.join(root, 'run'), workspaceRoots: [root],
          maxSessions: 1, logLevel: 'error',
        },
      });
      runtime = await createRuntime(config);
      const session = await runtime.manager.create({ allowPrivateNetwork: true, viewport: { width: 900, height: 700 } });
      await session.navigate({ url });
      await session.evaluate("localStorage.setItem('theme', 'dark')");
      await session.importCookies([{ name: 'session', value: 'cookie-value', url }]);

      const exported = await session.exportSession();
      expect(exported).toMatchObject({ version: 1, url, localStorage: { theme: 'dark' } });
      expect(exported.viewport?.width).toBeGreaterThan(0);
      expect(exported.viewport?.height).toBeGreaterThan(0);
      expect(exported.cookies).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'session', value: 'cookie-value' })]));

      await session.evaluate('localStorage.clear()');
      await session.storage({ action: 'clear' });
      await session.importSession({ ...exported, viewport: { width: 800, height: 600 } });
      expect(await session.evaluate("localStorage.getItem('theme')")).toBe('dark');
      expect(await session.exportCookies()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'session', value: 'cookie-value' })]));
      expect((await session.exportSession()).viewport).toEqual({ width: 800, height: 600 });

      const snapshot = await session.snapshot({ mode: 'interactive' });
      const downloadRef = snapshot.content.match(/link[^\n]*Download fixture[^\n]*\[ref=(e\d+)\]/)?.[1]
        ?? snapshot.content.match(/link[^\n]*\[ref=(e\d+)\][^\n]*Download fixture/)?.[1];
      expect(downloadRef).toBeTruthy();
      await session.act({ action: 'click', ref: downloadRef });

      let download: { id: string; path?: string; failure?: string } | undefined;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        download = (session.inspect({ kind: 'downloads' }) as Array<typeof download>)[0];
        if (download?.path || download?.failure) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(download?.failure).toBeUndefined();
      expect(download?.path).toBeTruthy();
      const destination = path.join(root, 'saved-download.txt');
      await expect(session.saveDownload(download!.id, path.join(os.tmpdir(), 'outside-workspace.txt')))
        .rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
      const saved = await session.saveDownload(download!.id, destination);
      expect(saved).toEqual({ path: await realpath(destination), bytes: 13 });
      expect(await readFile(destination, 'utf8')).toBe('download body');

      const health = await session.health();
      expect(health).toMatchObject({ alive: true, pid: session.chromium.child.pid, pageCount: 1 });
      expect(health.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(health.lastActivityAt).toBe(session.lastActivityAt.toISOString());
      expect(session.getActivityLog().map((entry) => entry.type)).toEqual(expect.arrayContaining(['navigate', 'evaluate', 'snapshot', 'act']));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
