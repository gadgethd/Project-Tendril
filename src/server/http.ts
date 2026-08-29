import http from 'node:http';
import { isIP, type Socket } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import httpProxy from 'http-proxy';
import ipaddr from 'ipaddr.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BrowserManager, SessionLease } from '../browser/manager.js';
import type { SearchService } from '../browser/search.js';
import type { CrawlService } from '../browser/crawl.js';
import { asTendrilError } from '../errors.js';
import { BoundedRateLimiter, type RateLimitDecision } from '../security/rate-limit.js';
import { type Logger } from '../util.js';
import {
  constantTimeTokenEqual,
  createCdpCapability,
  loadOrCreateHttpToken,
  parseBearerAuthorization,
  verifyCdpCapability,
} from '../security/auth.js';
import { createMcpServer } from './mcp.js';
import { DASHBOARD_HTML } from './dashboard.js';

export interface TendrilHttpServer {
  server: http.Server;
  port: number;
  token: string;
  dashboardUrl: string;
  close(): Promise<void>;
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

export function normalizeHostAuthority(authority: string | undefined): string | undefined {
  if (!authority || authority.length > 512 || /[\s/?#@%]/.test(authority)) return undefined;
  try {
    const parsed = new URL(`http://${authority}/`);
    if (parsed.username || parsed.password || parsed.pathname !== '/') return undefined;
    const unbracketed = parsed.hostname.replace(/^\[|\]$/g, '');
    return unbracketed.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

function normalizeConfiguredHost(host: string): string | undefined {
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  return normalizeHostAuthority(authority);
}

export function formatUrlAuthority(host: string, port: number): string {
  const normalized = normalizeConfiguredHost(host) ?? host.toLowerCase();
  return `${isIP(normalized) === 6 ? `[${normalized}]` : normalized}:${port}`;
}

export function advertisedHost(configuredHost: string, requestAuthority?: string): string {
  if (requestAuthority && hostHeaderAllowed(requestAuthority, configuredHost)) {
    return normalizeHostAuthority(requestAuthority)!;
  }
  const configured = normalizeConfiguredHost(configuredHost) ?? configuredHost.toLowerCase();
  if (configured === '0.0.0.0') return '127.0.0.1';
  if (configured === '::') return '::1';
  return configured;
}

function classifyPrivateAddress(host: string): 'ipv4' | 'ipv6' | undefined {
  if (!ipaddr.isValid(host)) return undefined;
  let address = ipaddr.parse(host);
  if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
    address = (address as ipaddr.IPv6).toIPv4Address();
  }
  const range = address.range();
  if (address.kind() === 'ipv4') return range === 'private' ? 'ipv4' : undefined;
  return range === 'uniqueLocal' || range === 'linkLocal' ? 'ipv6' : undefined;
}

export function hostHeaderAllowed(authority: string | undefined, configuredHost: string): boolean {
  const host = normalizeHostAuthority(authority);
  if (!host) return false;
  const configured = normalizeConfiguredHost(configuredHost);
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const isConfiguredHost = configured !== undefined && host === configured;
  const privateAddress = classifyPrivateAddress(host);
  return isLoopback
    || isConfiguredHost
    || (configured === '0.0.0.0' && privateAddress === 'ipv4')
    || (configured === '::' && (privateAddress === 'ipv4' || privateAddress === 'ipv6'));
}

function peerKey(address: string | undefined): string {
  const normalized = address?.startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(normalized ?? '') ? `ip:${normalized!.toLowerCase()}` : 'ip:unknown';
}

function setRateLimitedResponse(response: Response, decision: RateLimitDecision): void {
  response.setHeader('Retry-After', Math.max(1, Math.ceil(decision.retryAfterMs / 1_000)));
  response.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts' } });
}

export async function startHttpServer(services: { manager: BrowserManager; search: SearchService; crawl: CrawlService; logger: Logger }): Promise<TendrilHttpServer> {
  const { manager, search, crawl, logger } = services;
  const token = await loadOrCreateHttpToken({ configuredToken: manager.config.token, dataDir: manager.config.dataDir });
  const authFailures = new BoundedRateLimiter({ limit: 10, windowMs: 60_000, maxKeys: 1_024 });
  const cdpAttempts = new BoundedRateLimiter({ limit: 60, windowMs: 60_000, maxKeys: 1_024 });
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    if (!hostHeaderAllowed(request.headers.host, manager.config.host)) {
      response.status(421).json({ error: { code: 'INVALID_HOST', message: 'Host header is not allowed' } });
      return;
    }
    next();
  });
  const bearerToken = (request: Request | http.IncomingMessage): string | undefined => {
    return parseBearerAuthorization(request.headers.authorization);
  };
  const rejectAuthentication = (request: Request, response: Response, message: string): void => {
    const decision = authFailures.attempt(peerKey(request.socket.remoteAddress));
    if (!decision.allowed) {
      setRateLimitedResponse(response, decision);
      return;
    }
    response.status(401).json({ error: { code: 'UNAUTHORIZED', message } });
  };
  const authenticated = (request: Request, response: Response, next: NextFunction): void => {
    if (!constantTimeTokenEqual(bearerToken(request), token)) {
      rejectAuthentication(request, response, 'Valid Tendril bearer token required');
      return;
    }
    authFailures.reset(peerKey(request.socket.remoteAddress));
    next();
  };

  app.get('/', (_request, response) => response.redirect('/dashboard'));
  app.get('/dashboard', (_request, response) => response.type('html').send(DASHBOARD_HTML));
  app.get('/health', (_request, response) => response.json({ status: 'ok', version: '1.1.0', chromiumSessions: manager.activeCount() }));
  // Every authorization failure below consumes a bounded per-peer bucket, and CDP consumes a separate attempt bucket.
  // lgtm[js/missing-rate-limiting]
  app.use((request, response, next) => {
    const cdpMatch = request.path.match(/^\/cdp\/([^/]+)(?:\/|$)/);
    if (cdpMatch) {
      const peer = peerKey(request.socket.remoteAddress);
      const capability = typeof request.query.capability === 'string' ? request.query.capability : undefined;
      if (constantTimeTokenEqual(bearerToken(request), token) || verifyCdpCapability(capability, token, cdpMatch[1]!)) {
        authFailures.reset(peer);
        cdpAttempts.reset(peer);
        next();
        return;
      }
      const attempt = cdpAttempts.attempt(peer);
      if (!attempt.allowed) {
        setRateLimitedResponse(response, attempt);
        return;
      }
      rejectAuthentication(request, response, 'Valid Tendril CDP capability required');
      return;
    }
    authenticated(request, response, next);
  });
  app.use(express.json({ limit: '10mb' }));
  app.get('/openapi.json', (_request, response) => response.json(openApiDocument(manager.config.port)));
  app.get('/metrics', async (_request, response) => {
    const sessions = await manager.list();
    response.type('text/plain').send(`# HELP tendril_sessions Active Chromium sessions\n# TYPE tendril_sessions gauge\ntendril_sessions ${sessions.length}\n`);
  });

  app.post('/mcp', async (request, response) => {
    const mcp = createMcpServer({ manager, search, crawl });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', () => { void transport.close(); void mcp.close(); });
    try { await mcp.connect(transport); await transport.handleRequest(request, response, request.body); }
    catch (error) { if (!response.headersSent) response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(error) }, id: null }); }
  });
  app.get('/mcp', (_request, response) => response.status(405).json({ error: 'Method not allowed' }));
  app.delete('/mcp', (_request, response) => response.status(405).json({ error: 'Method not allowed' }));

  app.get('/v1/sessions', async (request, response, next) => {
    try { response.json({ sessions: await manager.list((session) => publicCdpUrl(manager, session.id, session.chromium.browserPath, token, request.headers.host)) }); } catch (error) { next(error); }
  });
  app.post('/v1/sessions', async (request, response, next) => {
    try { response.status(201).json(await (await manager.create(request.body)).info()); } catch (error) { next(error); }
  });
  app.get('/v1/sessions/:id', async (request, response, next) => {
    try { response.json(await manager.get(request.params.id!).info(publicCdpUrl(manager, request.params.id!, manager.get(request.params.id!).chromium.browserPath, token, request.headers.host))); } catch (error) { next(error); }
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
  app.get('/v1/sessions/:id/screenshot', async (request, response, next) => {
    try {
      const requestedFormat = request.query.format;
      if (requestedFormat !== undefined && requestedFormat !== 'png' && requestedFormat !== 'jpeg') throw new Error('format must be png or jpeg');
      const format: 'png' | 'jpeg' = requestedFormat === 'jpeg' ? 'jpeg' : 'png';
      const quality = Number(request.query.quality ?? 80);
      if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('quality must be an integer from 1 to 100');
      response.json(await manager.get(request.params.id!).capture({ format, quality }));
    } catch (error) { next(error); }
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
  app.get('/v1/crawl/:id/results', (request, response, next) => {
    try {
      const offset = request.query.offset === undefined ? undefined : Number(request.query.offset);
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      response.json(crawl.results(request.params.id!, { offset, limit }));
    } catch (error) { next(error); }
  });
  app.delete('/v1/crawl/:id', (request, response, next) => { try { response.json(crawl.cancel(request.params.id!)); } catch (error) { next(error); } });

  for (const format of ['snapshot', 'content', 'markdown', 'accessibility-tree', 'links', 'screenshot', 'pdf'] as const) {
    app.post(`/v1/${format}`, async (request, response, next) => {
      let session;
      let lease: SessionLease | undefined;
      let output: { kind: 'json'; body: unknown } | { kind: 'binary'; mimeType: string; body: Buffer } | undefined;
      let operationFailure: unknown;
      try {
        if (request.body.sessionId) session = manager.get(request.body.sessionId);
        else {
          lease = await manager.acquire(request.body.profile ? { profile: request.body.profile } : {});
          session = lease.session;
        }
        if (request.body.html) await session.setContent(request.body.html);
        else if (request.body.url) await session.navigate({ url: request.body.url, waitUntil: request.body.waitUntil ?? 'domcontentloaded' });
        if (format === 'screenshot' || format === 'pdf') {
          const captured = await session.capture({ format: format === 'pdf' ? 'pdf' : request.body.type ?? 'png', fullPage: request.body.fullPage });
          output = { kind: 'binary', mimeType: captured.mimeType, body: Buffer.from(captured.data, 'base64') };
        } else if (format === 'snapshot') {
          const formats: string[] = request.body.formats ?? ['content', 'screenshot'];
          const snapshotOutput: Record<string, unknown> = {};
          if (formats.includes('content')) snapshotOutput.content = await session.extract({ format: 'html' });
          if (formats.includes('markdown')) snapshotOutput.markdown = await session.extract({ format: 'markdown' });
          if (formats.includes('accessibilityTree')) snapshotOutput.accessibilityTree = await session.snapshot({ mode: 'full' });
          if (formats.includes('screenshot')) snapshotOutput.screenshot = await session.capture({ format: 'png', fullPage: request.body.fullPage });
          output = { kind: 'json', body: snapshotOutput };
        } else {
          const mapped = format === 'accessibility-tree' ? await session.snapshot({ mode: 'full' }) : await session.extract({ format: format === 'content' ? 'html' : format });
          output = { kind: 'json', body: { url: request.body.url, [format.replace('-', '')]: mapped, untrustedContent: true } };
        }
      } catch (error) {
        operationFailure = error;
      }

      let cleanupFailure: unknown;
      try {
        await lease?.release();
      } catch (error) {
        cleanupFailure = error;
      }
      if (operationFailure !== undefined || cleanupFailure !== undefined) {
        if (operationFailure !== undefined && cleanupFailure !== undefined) {
          const operationMessage = operationFailure instanceof Error ? operationFailure.message : String(operationFailure);
          const cleanupMessage = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
          next(new AggregateError(
            [operationFailure, cleanupFailure],
            `Quick route operation failed (${operationMessage}) and cleanup failed (${cleanupMessage})`,
          ));
        } else {
          next(operationFailure ?? cleanupFailure);
        }
        return;
      }
      if (!output) {
        next(new Error('Quick route did not produce a response'));
        return;
      }
      if (output.kind === 'binary') response.type(output.mimeType).send(output.body);
      else response.json(output.body);
    });
  }

  const cdpAgent = new http.Agent({ keepAlive: false });
  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: false, agent: cdpAgent });
  proxy.on('error', (error, _request, response) => {
    logger.warn('CDP proxy error', { error: error.message });
    if ('writeHead' in response && typeof response.writeHead === 'function') response.writeHead(502).end();
    else response.destroy();
  });
  app.use('/cdp/:id', (request, response, next) => {
    try {
      const id = String(request.params.id);
      const session = manager.get(id);
      const forwarded = new URL(request.originalUrl, 'http://127.0.0.1');
      forwarded.searchParams.delete('capability');
      request.url = `${forwarded.pathname.replace(`/cdp/${id}`, '') || '/'}${forwarded.search}`;
      delete request.headers.authorization;
      proxy.web(request, response, { target: session.backendCdpHttpUrl() });
    } catch (error) { next(error); }
  });
  app.use(errorHandler(logger));

  const server = http.createServer(app);
  const serverSockets = new Set<Socket>();
  server.on('connection', (socket) => {
    serverSockets.add(socket);
    socket.once('close', () => serverSockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    try {
      if (!hostHeaderAllowed(request.headers.host, manager.config.host)) {
        socket.write('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const match = url.pathname.match(/^\/cdp\/([^/]+)(\/.*)$/);
      const sessionId = match?.[1];
      const peer = peerKey(request.socket.remoteAddress);
      const authorized = sessionId !== undefined && (
        constantTimeTokenEqual(bearerToken(request), token)
        || verifyCdpCapability(url.searchParams.get('capability') ?? undefined, token, sessionId)
      );
      if (!match || !sessionId || !authorized) {
        const attempt = cdpAttempts.attempt(peer);
        if (!attempt.allowed) {
          const retryAfter = Math.max(1, Math.ceil(attempt.retryAfterMs / 1_000));
          socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${retryAfter}\r\nConnection: close\r\n\r\n`);
          socket.destroy();
          return;
        }
        const failure = authFailures.attempt(peer);
        const status = failure.allowed ? '401 Unauthorized' : '429 Too Many Requests';
        const retryAfter = failure.allowed ? '' : `Retry-After: ${Math.max(1, Math.ceil(failure.retryAfterMs / 1_000))}\r\n`;
        socket.write(`HTTP/1.1 ${status}\r\n${retryAfter}Connection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      authFailures.reset(peer);
      cdpAttempts.reset(peer);
      const session = manager.get(sessionId);
      url.searchParams.delete('capability');
      request.url = `${match[2]}${url.search}`;
      delete request.headers.authorization;
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
  const dashboardUrl = `http://${formatUrlAuthority(advertisedHost(manager.config.host), port)}/dashboard#token=${encodeURIComponent(token)}`;
  logger.info('Tendril HTTP server listening', { host: manager.config.host, port });
  let closePromise: Promise<void> | undefined;
  return {
    server, port, token, dashboardUrl,
    async close() {
      if (!closePromise) {
        closePromise = (async () => {
          proxy.close();
          cdpAgent.destroy();
          for (const socket of serverSockets) socket.destroy();
          if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        })();
      }
      return closePromise;
    },
  };
}

function publicCdpUrl(
  manager: BrowserManager,
  sessionId: string,
  browserPath: string,
  token: string,
  requestAuthority?: string,
): string {
  const capability = createCdpCapability(token, sessionId);
  return `ws://${formatUrlAuthority(advertisedHost(manager.config.host, requestAuthority), manager.config.port)}/cdp/${sessionId}${browserPath}?capability=${encodeURIComponent(capability)}`;
}

function openApiDocument(port: number): Record<string, unknown> {
  return {
    openapi: '3.1.0', info: { title: 'Project Tendril API', version: '1.1.0' },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, security: [{ bearerAuth: [] }],
    paths: {
      '/v1/sessions': { get: { summary: 'List browser sessions' }, post: { summary: 'Create browser session' } },
      '/v1/sessions/{id}': { get: { summary: 'Inspect session' }, delete: { summary: 'Close session' } },
      '/v1/sessions/{id}/screenshot': { get: { summary: 'Capture a live session screenshot' } },
      '/v1/snapshot': { post: { summary: 'Capture multiple rendered page formats' } },
      '/v1/content': { post: { summary: 'Extract rendered HTML' } }, '/v1/markdown': { post: { summary: 'Extract Markdown' } },
      '/v1/accessibility-tree': { post: { summary: 'Extract semantic tree' } }, '/v1/links': { post: { summary: 'Extract links' } },
      '/v1/screenshot': { post: { summary: 'Capture screenshot' } }, '/v1/pdf': { post: { summary: 'Generate PDF' } },
      '/v1/search': { post: { summary: 'Search the web with Chromium' } }, '/v1/research': { post: { summary: 'Gather cited web evidence' } },
      '/v1/crawl': { post: { summary: 'Start a bounded crawl' } }, '/mcp': { post: { summary: 'MCP Streamable HTTP endpoint' } },
    },
  };
}
