import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRuntime, type TendrilRuntime } from '../src/runtime.js';

let runtime: TendrilRuntime | undefined;
afterEach(async () => { await runtime?.close(); runtime = undefined; });

describe('TendrilSession', () => {
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
});
