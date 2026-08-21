import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRuntime, type TendrilRuntime } from '../src/runtime.js';
import { startHttpServer, type TendrilHttpServer } from '../src/server/http.js';

let runtime: TendrilRuntime | undefined;
let httpServer: TendrilHttpServer | undefined;
afterEach(async () => { await httpServer?.close(); await runtime?.close(); httpServer = undefined; runtime = undefined; });

describe('HTTP and CDP interfaces', () => {
  it('serves REST quick actions and an authenticated raw CDP endpoint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-http-'));
    runtime = await createRuntime(await loadConfig({ overrides: { port: 0, dataDir: path.join(root, 'data'), runtimeDir: path.join(root, 'run'), maxSessions: 1, logLevel: 'error' } }));
    httpServer = await startHttpServer({ ...runtime });
    const base = `http://127.0.0.1:${httpServer.port}`;
    const auth = { authorization: `Bearer ${httpServer.token}`, 'content-type': 'application/json' };
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/v1/sessions`)).status).toBe(401);
    const createdResponse = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: auth, body: '{}' });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string };
    await fetch(`${base}/v1/sessions/${created.id}/content`, { method: 'POST', headers: auth, body: JSON.stringify({ html: '<title>CDP fixture</title><h1>Hello CDP</h1>' }) });
    const sessions = await (await fetch(`${base}/v1/sessions`, { headers: auth })).json() as { sessions: Array<{ cdpUrl: string }> };
    const browser = await chromium.connectOverCDP(sessions.sessions[0]!.cdpUrl!);
    expect(await browser.contexts()[0]!.pages()[0]!.title()).toBe('CDP fixture');
    await browser.close();
    const snapshot = await (await fetch(`${base}/v1/sessions/${created.id}/snapshot`, { method: 'POST', headers: auth, body: JSON.stringify({ mode: 'full' }) })).json() as { content: string };
    expect(snapshot.content).toContain('Hello CDP');
  });
});
