import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRuntime, type TendrilRuntime } from '../src/runtime.js';
import { createMcpServer } from '../src/server/mcp.js';

let runtime: TendrilRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe('MCP server', () => {
  it('lists the complete tool surface and controls Chromium', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-mcp-'));
    runtime = await createRuntime(
      await loadConfig({ overrides: { dataDir: path.join(root, 'data'), runtimeDir: path.join(root, 'run'), maxSessions: 1, logLevel: 'error' } }),
    );
    const server = createMcpServer(runtime);
    const client = new Client({ name: 'tendril-tests', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['browser_session', 'browser_snapshot', 'browser_act', 'browser_search', 'browser_research', 'browser_crawl', 'browser_capture']),
    );
    const created = await client.callTool({ name: 'browser_session', arguments: { action: 'create' } });
    expect(created.isError).not.toBe(true);
    const sessionId = (created.structuredContent as { id: string }).id;
    const listed = await client.callTool({ name: 'browser_page', arguments: { action: 'list', sessionId } });
    expect((listed.structuredContent as { pages: unknown[] }).pages).toHaveLength(1);
    await client.callTool({ name: 'browser_session', arguments: { action: 'close', sessionId } });
    await client.close();
    await server.close();
  });
});
