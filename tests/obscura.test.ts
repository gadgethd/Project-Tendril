import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRuntime, type TendrilRuntime } from '../src/runtime.js';
import { createMcpServer } from '../src/server/mcp.js';

const obscuraPath = process.env.TENDRIL_OBSCURA_PATH;
let runtime: TendrilRuntime | undefined;
let fixture: http.Server | undefined;
afterEach(async () => {
  await runtime?.close();
  if (fixture) await new Promise<void>((resolve) => fixture!.close(() => resolve()));
  runtime = undefined;
  fixture = undefined;
});

describe.skipIf(!obscuraPath)('Obscura backend', () => {
  it('runs Tendril semantic actions and captures through the Rust engine', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-obscura-'));
    runtime = await createRuntime(
      await loadConfig({
        overrides: {
          browserBackend: 'obscura',
          obscuraExecutablePath: obscuraPath,
          obscuraStealth: true,
          dataDir: path.join(root, 'data'),
          runtimeDir: path.join(root, 'run'),
          blockPrivateNetworks: false,
          maxSessions: 1,
          logLevel: 'error',
        },
      }),
    );
    const session = await runtime.manager.create();
    expect(await session.info()).toMatchObject({ backend: 'obscura', headless: true });
    expect(session.supportsSharedCdpGateway()).toBe(false);

    fixture = http.createServer((_request, response) => response.end('<title>Network fixture</title><h1>Loaded through Tendril proxy</h1>'));
    await new Promise<void>((resolve) => fixture!.listen(0, '127.0.0.1', resolve));
    const port = (fixture.address() as AddressInfo).port;
    await session.navigate({ url: `http://127.0.0.1:${port}/` });
    expect((await session.snapshot({ mode: 'full' })).content).toContain('Loaded through Tendril proxy');

    await session.setContent(
      '<title>Obscura fixture</title><main><h1 id="result">Empty</h1><label>Name <input id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Save</button></main>',
    );
    const page = session.browserProcess.context.pages()[0]!;
    expect(await page.evaluate(() => ({ value: 42 }))).toEqual({ value: 42 });
    expect(await page.locator('#name').evaluate((element) => ({ tag: element.tagName.toLowerCase() }))).toEqual({ tag: 'input' });
    const snapshot = await session.snapshot({ mode: 'interactive' });
    const inputRef = snapshot.content.match(/textbox[^\n]*\[ref=([^\]]+)\]/)?.[1];
    await session.act({ action: 'fill', ref: inputRef, text: 'Tendril on Rust' });
    const refreshed = await session.snapshot({ mode: 'interactive' });
    const buttonRef = refreshed.content.match(/button[^\n]*\[ref=([^\]]+)\]/)?.[1];
    await session.act({ action: 'click', ref: buttonRef });
    expect((await session.snapshot({ mode: 'full' })).content).toContain('Tendril on Rust');
    await expect(session.fillForm({ '#name': 'Bulk fill' })).resolves.toMatchObject({ filled: ['#name'] });
    expect((await session.snapshot({ mode: 'full' })).content).toContain('Bulk fill');
    const capture = await session.capture({ format: 'png' });
    expect(Buffer.byteLength(capture.data, 'base64')).toBeGreaterThan(1000);
    await expect(session.configure({ timezoneId: 'Europe/London' })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });

    await runtime.manager.close(session.id);
    const persistent = await runtime.manager.create({ profile: 'obscura-profile' });
    await persistent.navigate({ url: `http://127.0.0.1:${port}/` });
    await persistent.storage({ action: 'set_cookies', cookies: [{ name: 'tendril', value: 'persisted', domain: '127.0.0.1', path: '/' }] });
    await runtime.manager.close(persistent.id);
    const reopened = await runtime.manager.create({ profile: 'obscura-profile' });
    await reopened.navigate({ url: `http://127.0.0.1:${port}/` });
    const stored = (await reopened.storage({ action: 'get' })) as { cookies: Array<{ name: string; value: string }> };
    expect(stored.cookies).toContainEqual(expect.objectContaining({ name: 'tendril', value: 'persisted' }));
  });

  it('lets an MCP agent navigate and snapshot through Obscura', async () => {
    fixture = http.createServer((_request, response) => response.end('<title>Agent fixture</title><main><h1>Agent browsed with Obscura</h1></main>'));
    await new Promise<void>((resolve) => fixture!.listen(0, '127.0.0.1', resolve));
    const port = (fixture.address() as AddressInfo).port;
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-obscura-mcp-'));
    runtime = await createRuntime(
      await loadConfig({
        overrides: {
          browserBackend: 'obscura',
          obscuraExecutablePath: obscuraPath,
          dataDir: path.join(root, 'data'),
          runtimeDir: path.join(root, 'run'),
          blockPrivateNetworks: false,
          maxSessions: 1,
          logLevel: 'error',
        },
      }),
    );
    const server = createMcpServer(runtime);
    const client = new Client({ name: 'obscura-agent-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const created = await client.callTool({ name: 'browser_session', arguments: { action: 'create' } });
      const sessionId = (created.structuredContent as { id: string }).id;
      const navigation = await client.callTool({ name: 'browser_navigate', arguments: { sessionId, url: `http://127.0.0.1:${port}/` } });
      expect(navigation.isError).not.toBe(true);
      const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: { sessionId, mode: 'full' } });
      expect(JSON.stringify(snapshot.structuredContent)).toContain('Agent browsed with Obscura');
      await client.callTool({ name: 'browser_session', arguments: { action: 'close', sessionId } });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
