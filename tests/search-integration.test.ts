import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRuntime } from '../src/runtime.js';
import { createMcpServer } from '../src/server/mcp.js';
import { startHttpServer } from '../src/server/http.js';

it('serves MCP and REST search without a browser installation, with transient recovery and actionable errors', async () => {
  let attempts = 0;
  const provider = http.createServer((_req, res) => {
    attempts += 1;
    if (attempts === 1) {
      res.writeHead(503);
      res.end('Temporary outage');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Reliable web search', url: 'https://example.com/evidence', content: 'Web search evidence' }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-search-integration-'));
  const runtime = await createRuntime(
    await loadConfig({
      overrides: {
        port: 0,
        token: 'test-token-for-search-integration-12345',
        dataDir: path.join(root, 'data'),
        runtimeDir: path.join(root, 'run'),
        browserBackend: 'obscura',
        obscuraExecutablePath: path.join(root, 'not-installed'),
        maxSessions: 1,
        searchProviders: ['searxng'],
        searxngUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`,
        allowedHosts: ['127.0.0.1'],
        logLevel: 'error',
      },
    }),
  );
  const create = vi.spyOn(runtime.manager, 'create');
  const mcp = createMcpServer(runtime);
  const client = new Client({ name: 'search-agent', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
  const server = await startHttpServer(runtime);
  try {
    const searched = await client.callTool({ name: 'browser_search', arguments: { query: 'reliable web search' } });
    expect(searched.isError).not.toBe(true);
    expect(searched.structuredContent).toMatchObject({ untrustedContent: true, results: [{ url: 'https://example.com/evidence' }] });
    expect(attempts).toBe(2);
    expect(create).not.toHaveBeenCalled();
    const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
    const cached = await fetch(`http://127.0.0.1:${server.port}/v1/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: 'reliable web search' }),
    });
    expect(cached.status).toBe(200);
    expect(await cached.json()).toMatchObject({ results: [{ url: 'https://example.com/evidence' }] });
    expect(attempts).toBe(2);
    const invalid = await fetch(`http://127.0.0.1:${server.port}/v1/search`, { method: 'POST', headers, body: JSON.stringify({ query: { wrong: 'type' } }) });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'INVALID_ARGUMENT', recovery: expect.any(String), details: { issues: [{ path: 'query' }] } } });
    const malformed = await fetch(`http://127.0.0.1:${server.port}/v1/search`, { method: 'POST', headers, body: '{"query":' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'INVALID_ARGUMENT', message: 'Request body must be valid JSON' } });
    const missingQuery = await client.callTool({ name: 'browser_search', arguments: {} });
    expect(missingQuery.isError).toBe(true);
    expect(missingQuery.structuredContent).toMatchObject({ error: { code: 'INVALID_ARGUMENT', recovery: expect.any(String) } });
  } finally {
    await client.close();
    await mcp.close();
    await server.close();
    await runtime.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
