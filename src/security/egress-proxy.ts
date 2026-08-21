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
  private readonly sockets = new Set<net.Socket>();
  private port?: number;

  constructor(private readonly policy: NetworkPolicy, private readonly logger: Logger) {
    this.server = http.createServer((request, response) => void this.handleRequest(request, response));
    this.server.on('connect', (request, socket, head) => void this.handleConnect(request, socket as net.Socket, head));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<number> {
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
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const rawUrl = request.url ?? '';
    try {
      const url = new URL(rawUrl);
      const destination = await this.policy.resolve(url.toString());
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
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', (error) => {
        this.logger.warn('Proxy upstream request failed', { url: redactUrl(rawUrl), error: error.message });
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
        response.end('Bad Gateway');
      });
      request.pipe(upstream);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Proxy request blocked', { url: redactUrl(rawUrl), error: message });
      response.writeHead(403, { 'content-type': 'text/plain', 'x-tendril-blocked': 'true' });
      response.end(`Blocked by Tendril network policy: ${message}`);
    }
  }

  private async handleConnect(request: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): Promise<void> {
    const authority = request.url ?? '';
    clientSocket.on('error', () => undefined);
    try {
      const parsed = new URL(`https://${authority}`);
      const destination = await this.policy.resolveHost(parsed.hostname);
      const port = Number(parsed.port || 443);
      const upstream = net.connect({ host: destination.address, port, family: destination.family });
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
      this.logger.warn('Proxy tunnel blocked', { authority, error: message });
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\nX-Tendril-Blocked: true\r\nContent-Length: 0\r\n\r\n`);
    }
  }
}
