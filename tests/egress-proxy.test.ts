import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { EgressProxy } from '../src/security/egress-proxy.js';
import { NetworkPolicy } from '../src/security/network-policy.js';
import { Logger } from '../src/util.js';

describe('EgressProxy lifecycle', () => {
  async function connectResponse(port: number, authority: string): Promise<string> {
    const client = net.connect(port, '127.0.0.1');
    client.on('error', () => undefined);
    await new Promise<void>((resolve) => client.once('connect', resolve));
    client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const response = await new Promise<string>((resolve) => client.once('data', (chunk) => resolve(chunk.toString('utf8'))));
    client.destroy();
    return response;
  }

  it('destroys both sides of active CONNECT tunnels when stopped', async () => {
    const accepted = new Set<net.Socket>();
    const destination = net.createServer((socket) => {
      accepted.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => accepted.delete(socket));
    });
    await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
    const destinationPort = (destination.address() as AddressInfo).port;
    const proxy = new EgressProxy(
      new NetworkPolicy({ blockPrivateNetworks: false, allowedHosts: [], blockedHosts: [] }),
      new Logger('error'),
    );
    const proxyPort = await proxy.start();
    const client = net.connect(proxyPort, '127.0.0.1');
    client.on('error', () => undefined);
    try {
      await new Promise<void>((resolve) => client.once('connect', resolve));
      client.write(`CONNECT 127.0.0.1:${destinationPort} HTTP/1.1\r\nHost: 127.0.0.1:${destinationPort}\r\n\r\n`);
      const response = await new Promise<string>((resolve) => client.once('data', (chunk) => resolve(chunk.toString('utf8'))));
      expect(response).toContain('200 Connection Established');
      await vi.waitFor(() => expect(accepted.size).toBe(1));
      await Promise.all([proxy.stop(), proxy.stop()]);
      await vi.waitFor(() => {
        expect(client.destroyed).toBe(true);
        expect(accepted.size).toBe(0);
      });
    } finally {
      client.destroy();
      await proxy.stop();
      for (const socket of accepted) socket.destroy();
      if (destination.listening) await new Promise<void>((resolve) => destination.close(() => resolve()));
    }
  });

  it('cancels in-flight DNS resolution before proxy stop settles', async () => {
    const cancel = vi.fn();
    const resolve4 = vi.fn(() => new Promise<string[]>(() => {}));
    const policy = new NetworkPolicy(
      { blockPrivateNetworks: false, allowedHosts: [], blockedHosts: [] },
      { createResolver: () => ({ resolve4, resolve6: () => new Promise<string[]>(() => {}), cancel }), lookupTimeoutMs: 10_000 },
    );
    const proxy = new EgressProxy(policy, new Logger('error'));
    const port = await proxy.start();
    const request = http.request({ hostname: '127.0.0.1', port, path: 'http://never-settles.invalid/', method: 'GET' });
    request.on('error', () => undefined);
    request.end();
    await vi.waitFor(() => expect(resolve4).toHaveBeenCalledOnce());
    const started = Date.now();
    await proxy.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects credentialed or path-bearing CONNECT targets before resolution', async () => {
    const resolveHost = vi.fn();
    const policy = { resolveHost, close: vi.fn(async () => undefined) } as unknown as NetworkPolicy;
    const proxy = new EgressProxy(policy, new Logger('error'));
    const port = await proxy.start();
    try {
      expect(await connectResponse(port, 'user:do-not-log@example.com:443')).toContain('403 Forbidden');
      expect(await connectResponse(port, 'example.com:443/path')).toContain('403 Forbidden');
      expect(resolveHost).not.toHaveBeenCalled();
    } finally {
      await proxy.stop();
    }
  });
});
