import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { NetworkPolicy } from './network-policy.js';
import type { Logger } from '../util.js';
import { redactUrl } from '../util.js';

const HOP_HEADERS = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export class EgressProxy {
  private readonly server: http.Server;
  private readonly clientSockets = new Set<net.Socket>();
  private readonly upstreamSockets = new Set<net.Socket>();
  private readonly httpAgent = new http.Agent({ keepAlive: false });
  private readonly httpsAgent = new https.Agent({ keepAlive: false });
  private readonly closingController = new AbortController();
  private stopPromise?: Promise<void>;
  private stopping = false;
  private port?: number;

  constructor(private readonly policy: NetworkPolicy, private readonly logger: Logger) {
    this.server = http.createServer((request, response) => void this.handleRequest(request, response));
    this.server.on('connect', (request, socket, head) => void this.handleConnect(request, socket as net.Socket, head));
    this.server.on('connection', (socket) => {
      this.clientSockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => this.clientSockets.delete(socket));
    });
  }

  async start(): Promise<number> {
    if (this.stopping) throw new Error('Egress proxy is stopping');
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  url(): string {
    if (!this.port) throw new Error('Egress proxy has not started');
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.httpAgent.destroy();
      this.httpsAgent.destroy();
      this.closingController.abort();
      for (const socket of [...this.clientSockets, ...this.upstreamSockets]) socket.destroy();
      const policyClose = this.policy.close();
      if (this.server.listening) {
        this.server.closeAllConnections();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
      }
      await policyClose;
    })();
    return this.stopPromise;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const rawUrl = request.url ?? '';
    try {
      if (this.stopping) throw new Error('Egress proxy is stopping');
      const url = new URL(rawUrl);
      const destination = await this.policy.resolve(url.toString(), this.closingController.signal);
      if (this.stopping) throw new Error('Egress proxy is stopping');
      const headers = Object.fromEntries(
        Object.entries(request.headers).filter(([key]) => !HOP_HEADERS.has(key.toLowerCase())),
      );
      headers.host = url.host;
      const transport = url.protocol === 'https:' ? https : http;
      const upstream = transport.request({
        protocol: url.protocol,
        hostname: destination.address,
        family: destination.family,
        servername: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        agent: url.protocol === 'https:' ? this.httpsAgent : this.httpAgent,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', (error) => {
        this.logger.warn('Proxy upstream request failed', { url: redactUrl(rawUrl), error: error.message });
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
        response.end('Bad Gateway');
      });
      upstream.once('socket', (socket) => this.trackUpstream(socket));
      request.once('aborted', () => upstream.destroy());
      response.once('close', () => { if (!response.writableEnded) upstream.destroy(); });
      request.pipe(upstream);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Proxy request blocked', { url: redactUrl(rawUrl), error: message });
      if (!response.destroyed) {
        response.writeHead(403, { 'content-type': 'text/plain', 'x-tendril-blocked': 'true' });
        response.end(`Blocked by Tendril network policy: ${message}`);
      }
    }
  }

  private async handleConnect(request: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): Promise<void> {
    const authority = request.url ?? '';
    let loggedAuthority = '[invalid CONNECT authority]';
    clientSocket.on('error', () => undefined);
    try {
      if (this.stopping) throw new Error('Egress proxy is stopping');
      const parsed = new URL(`https://${authority}`);
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error('CONNECT target must be a credential-free host and port authority');
      }
      loggedAuthority = parsed.host;
      const destination = await this.policy.resolveHost(parsed.hostname, this.closingController.signal);
      if (this.stopping) throw new Error('Egress proxy is stopping');
      const port = Number(parsed.port || 443);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CONNECT port');
      const upstream = net.connect({ host: destination.address, port, family: destination.family });
      this.trackUpstream(upstream);
      clientSocket.once('close', () => upstream.destroy());
      upstream.once('close', () => clientSocket.destroy());
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.once('error', (error) => {
        this.logger.warn('Proxy tunnel failed', { host: parsed.hostname, error: error.message });
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Proxy tunnel blocked', { authority: loggedAuthority, error: message });
      if (!clientSocket.destroyed) clientSocket.end(`HTTP/1.1 403 Forbidden\r\nX-Tendril-Blocked: true\r\nContent-Length: 0\r\n\r\n`);
    }
  }

  private trackUpstream(socket: net.Socket): void {
    if (this.stopping) {
      socket.destroy();
      return;
    }
    this.upstreamSockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => this.upstreamSockets.delete(socket));
  }
}
