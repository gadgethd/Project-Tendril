import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import httpProxy from 'http-proxy';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BrowserManager } from '../browser/manager.js';
import type { SearchService } from '../browser/search.js';
import type { CrawlService } from '../browser/crawl.js';
import { asTendrilError } from '../errors.js';
import { ensureDir, randomToken, type Logger } from '../util.js';
import { createMcpServer } from './mcp.js';
import { DASHBOARD_HTML } from './dashboard.js';

export interface TendrilHttpServer {
  server: http.Server;
  port: number;
  token: string;
  dashboardUrl: string;
  close(): Promise<void>;
}

async function loadOrCreateToken(manager: BrowserManager): Promise<string> {
  if (manager.config.token) return manager.config.token;
  await ensureDir(manager.config.dataDir);
  const tokenPath = path.join(manager.config.dataDir, 'http-token');
  try { return (await readFile(tokenPath, 'utf8')).trim(); }
  catch {
    const token = randomToken();
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    return token;
  }
}

function errorHandler(logger: Logger) {
  return (error: unknown, _request: Request, response: Response, _next: NextFunction): void => {
    const tendril = asTendrilError(error);
    logger.warn('HTTP request failed', { code: tendril.code, error: tendril.message });
    const status = tendril.code === 'SESSION_NOT_FOUND' || tendril.code === 'PAGE_NOT_FOUND' ? 404
      : tendril.code === 'NETWORK_BLOCKED' || tendril.code === 'FILE_ACCESS_DENIED' ? 403
        : tendril.code === 'SESSION_LIMIT_REACHED' ? 429 : 400;
    response.status(status).json({ error: { code: tendril.code, message: tendril.message, retryable: tendril.retryable, details: tendril.details } });
  };
}

export async function startHttpServer(services: { manager: BrowserManager; search: SearchService; crawl: CrawlService; logger: Logger }): Promise<TendrilHttpServer> {
  const { manager, search, crawl, logger } = services;
  const token = await loadOrCreateToken(manager);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));
  app.use((request, response, next) => {
    const host = request.headers.host?.split(':')[0]?.replace(/^\[/, '').replace(/\]$/, '') ?? '';
    const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
    const isConfiguredHost = host === manager.config.host;
    const isPrivateNetwork = /^10\.|^172\.(1[6-9]|2[0-9]|3[01])\.|^192\.168\./.test(host) || host === '0.0.0.0';
    const hostAllowed = isLoopback || isConfiguredHost || (manager.config.host === '0.0.0.0' && isPrivateNetwork);
    if (!hostAllowed) {
      response.status(421).json({ error: { code: 'INVALID_HOST', message: 'Host header is not allowed' } });
      return;
    }
    next();
  });
  const isLocalRequest = (request: Request): boolean => {
    const ip = request.ip ?? request.socket.remoteAddress ?? '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || /^10\.|^172\.(1[6-9]|2[0-9]|3[01])\.|^192\.168\./.test(ip);
  };
  const authenticated = (request: Request, response: Response, next: NextFunction): void => {
    if (isLocalRequest(request)) { next(); return; }
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (bearer !== token) { response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Valid Tendril bearer token required' } }); return; }
    next();
  };

  app.get('/', (_request, response) => response.redirect('/dashboard'));
  app.get('/dashboard', (_request, response) => response.type('html').send(DASHBOARD_HTML));
  app.get('/health', (_request, response) => response.json({ status: 'ok', version: '1.0.0', chromiumSessions: manager.config.maxSessions }));
  app.get('/openapi.json', (_request, response) => response.json(openApiDocument(manager.config.port)));
  app.get('/metrics', authenticated, async (_request, response) => {
    const sessions = await manager.list();
    response.type('text/plain').send(`# HELP tendril_sessions Active Chromium sessions\n# TYPE tendril_sessions gauge\ntendril_sessions ${sessions.length}\n`);
  });

  app.post('/mcp', authenticated, async (request, response) => {
    const mcp = createMcpServer({ manager, search, crawl });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', () => { void transport.close(); void mcp.close(); });
    try { await mcp.connect(transport); await transport.handleRequest(request, response, request.body); }
    catch (error) { if (!response.headersSent) response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(error) }, id: null }); }
  });
  app.get('/mcp', authenticated, (_request, response) => response.status(405).json({ error: 'Method not allowed' }));
  app.delete('/mcp', authenticated, (_request, response) => response.status(405).json({ error: 'Method not allowed' }));

  app.use('/v1', authenticated);
  app.get('/v1/sessions', async (_request, response, next) => {
    try { response.json({ sessions: await manager.list((session) => publicCdpUrl(manager, session.id, session.chromium.browserPath, token)) }); } catch (error) { next(error); }
  });
  app.post('/v1/sessions', async (request, response, next) => {
    try { response.status(201).json(await (await manager.create(request.body)).info()); } catch (error) { next(error); }
  });
  app.get('/v1/sessions/:id', async (request, response, next) => {
    try { response.json(await manager.get(request.params.id!).info(publicCdpUrl(manager, request.params.id!, manager.get(request.params.id!).chromium.browserPath, token))); } catch (error) { next(error); }
  });
  app.delete('/v1/sessions/:id', async (request, response, next) => {
    try { await manager.close(request.params.id!); response.status(204).end(); } catch (error) { next(error); }
  });
  app.post('/v1/sessions/:id/pages', async (request, response, next) => {
    try { response.status(201).json(await manager.get(request.params.id!).openPage(request.body.url)); } catch (error) { next(error); }
  });
  app.get('/v1/sessions/:id/pages', async (request, response, next) => {
    try { response.json({ pages: await manager.get(request.params.id!).listPages() }); } catch (error) { next(error); }
  });
  app.post('/v1/sessions/:id/navigate', async (request, response, next) => {
    try { response.json(await manager.get(request.params.id!).navigate(request.body)); } catch (error) { next(error); }
  });
  app.post('/v1/sessions/:id/content', async (request, response, next) => {
    try { response.json(await manager.get(request.params.id!).setContent(request.body.html, request.body.pageId)); } catch (error) { next(error); }
  });
  app.post('/v1/sessions/:id/snapshot', async (request, response, next) => {
    try { response.json(await manager.get(request.params.id!).snapshot(request.body)); } catch (error) { next(error); }
  });
  app.post('/v1/sessions/:id/act', async (request, response, next) => {
    try { response.json(await manager.get(request.params.id!).act(request.body)); } catch (error) { next(error); }
  });
  app.post('/v1/sessions/:id/extract', async (request, response, next) => {
    try { response.json({ untrustedContent: true, data: await manager.get(request.params.id!).extract(request.body) }); } catch (error) { next(error); }
  });
  app.post('/v1/sessions/:id/capture', async (request, response, next) => {
    try { response.json(await manager.get(request.params.id!).capture(request.body)); } catch (error) { next(error); }
  });
  app.get('/v1/sessions/:id/inspect/:kind', async (request, response, next) => {
    try { response.json({ entries: manager.get(request.params.id!).inspect({ kind: request.params.kind as 'console' | 'network' | 'downloads' }) }); } catch (error) { next(error); }
  });
  app.get('/v1/sessions/:id/challenge', async (request, response, next) => {
    try { response.json(await manager.get(request.params.id!).detectChallenge(request.query.pageId as string | undefined)); } catch (error) { next(error); }
  });
  app.post('/v1/sessions/:id/challenge', async (request, response, next) => {
    try {
      const session = manager.get(request.params.id!);
      response.json(request.body.action === 'wait' ? await session.waitForChallenge(request.body) : await session.focusForHandoff(request.body.pageId));
    } catch (error) { next(error); }
  });
  app.post('/v1/search', async (request, response, next) => { try { response.json(await search.search(request.body)); } catch (error) { next(error); } });
  app.post('/v1/research', async (request, response, next) => { try { response.json(await search.research(request.body)); } catch (error) { next(error); } });
  app.post('/v1/crawl', (request, response, next) => { try { response.status(202).json(crawl.start(request.body)); } catch (error) { next(error); } });
  app.get('/v1/crawl/:id', (request, response, next) => { try { response.json(crawl.get(request.params.id!)); } catch (error) { next(error); } });
  app.delete('/v1/crawl/:id', (request, response, next) => { try { response.json(crawl.cancel(request.params.id!)); } catch (error) { next(error); } });

  for (const format of ['snapshot', 'content', 'markdown', 'accessibility-tree', 'links', 'screenshot', 'pdf'] as const) {
    app.post(`/v1/${format}`, async (request, response, next) => {
      let session;
      try {
        session = request.body.sessionId ? manager.get(request.body.sessionId) : await manager.create(request.body.profile ? { profile: request.body.profile } : {});
        if (request.body.html) await session.setContent(request.body.html);
        else if (request.body.url) await session.navigate({ url: request.body.url, waitUntil: request.body.waitUntil ?? 'domcontentloaded' });
        if (format === 'screenshot' || format === 'pdf') {
          const captured = await session.capture({ format: format === 'pdf' ? 'pdf' : request.body.type ?? 'png', fullPage: request.body.fullPage });
          response.type(captured.mimeType).send(Buffer.from(captured.data, 'base64'));
        } else if (format === 'snapshot') {
          const formats: string[] = request.body.formats ?? ['content', 'screenshot'];
          const output: Record<string, unknown> = {};
          if (formats.includes('content')) output.content = await session.extract({ format: 'html' });
          if (formats.includes('markdown')) output.markdown = await session.extract({ format: 'markdown' });
          if (formats.includes('accessibilityTree')) output.accessibilityTree = await session.snapshot({ mode: 'full' });
          if (formats.includes('screenshot')) output.screenshot = await session.capture({ format: 'png', fullPage: request.body.fullPage });
          response.json(output);
        } else {
          const mapped = format === 'accessibility-tree' ? await session.snapshot({ mode: 'full' }) : await session.extract({ format: format === 'content' ? 'html' : format });
          response.json({ url: request.body.url, [format.replace('-', '')]: mapped, untrustedContent: true });
        }
      } catch (error) { next(error); }
      finally { if (session && !request.body.sessionId) await manager.close(session.id).catch(() => undefined); }
    });
  }

  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: false });
  proxy.on('error', (error, _request, response) => {
    logger.warn('CDP proxy error', { error: error.message });
    if ('writeHead' in response && typeof response.writeHead === 'function') response.writeHead(502).end();
    else response.destroy();
  });
  app.use('/cdp/:id', authenticated, (request, response, next) => {
    try {
      const id = String(request.params.id);
      const session = manager.get(id);
      request.url = request.originalUrl.replace(`/cdp/${id}`, '') || '/';
      proxy.web(request, response, { target: session.backendCdpHttpUrl() });
    } catch (error) { next(error); }
  });
  app.use(errorHandler(logger));

  const server = http.createServer(app);
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const match = url.pathname.match(/^\/cdp\/([^/]+)(\/.*)$/);
      const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('token');
      const remoteIp = request.socket?.remoteAddress ?? '';
      const wsLocal = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1' || /^10\.|^172\.(1[6-9]|2[0-9]|3[01])\.|^192\.168\./.test(remoteIp);
      if (!match || (!wsLocal && bearer !== token)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      const session = manager.get(match[1]!);
      request.url = `${match[2]}${url.search}`;
      proxy.ws(request, socket, head, { target: session.backendCdpHttpUrl().replace('http:', 'ws:') });
    } catch { socket.destroy(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(manager.config.port, manager.config.host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : manager.config.port;
  manager.config.port = port;
  const dashboardUrl = `http://${manager.config.host}:${port}/dashboard#token=${encodeURIComponent(token)}`;
  logger.info('Tendril HTTP server listening', { host: manager.config.host, port });
  return {
    server, port, token, dashboardUrl,
    async close() { proxy.close(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

function publicCdpUrl(manager: BrowserManager, sessionId: string, browserPath: string, token: string): string {
  return `ws://${manager.config.host}:${manager.config.port}/cdp/${sessionId}${browserPath}?token=${encodeURIComponent(token)}`;
}

function openApiDocument(port: number): Record<string, unknown> {
  return {
    openapi: '3.1.0', info: { title: 'Project Tendril API', version: '1.0.0' },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, security: [{ bearerAuth: [] }],
    paths: {
      '/v1/sessions': { get: { summary: 'List browser sessions' }, post: { summary: 'Create browser session' } },
      '/v1/sessions/{id}': { get: { summary: 'Inspect session' }, delete: { summary: 'Close session' } },
      '/v1/snapshot': { post: { summary: 'Capture multiple rendered page formats' } },
      '/v1/content': { post: { summary: 'Extract rendered HTML' } }, '/v1/markdown': { post: { summary: 'Extract Markdown' } },
      '/v1/accessibility-tree': { post: { summary: 'Extract semantic tree' } }, '/v1/links': { post: { summary: 'Extract links' } },
      '/v1/screenshot': { post: { summary: 'Capture screenshot' } }, '/v1/pdf': { post: { summary: 'Generate PDF' } },
      '/v1/search': { post: { summary: 'Search the web with Chromium' } }, '/v1/research': { post: { summary: 'Gather cited web evidence' } },
      '/v1/crawl': { post: { summary: 'Start a bounded crawl' } }, '/mcp': { post: { summary: 'MCP Streamable HTTP endpoint' } },
    },
  };
}
