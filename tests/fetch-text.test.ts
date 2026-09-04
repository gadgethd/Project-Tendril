import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TendrilError } from '../src/errors.js';
import { fetchTextWithPolicy } from '../src/security/fetch-text.js';
import { NetworkPolicy } from '../src/security/network-policy.js';

const servers: http.Server[] = [];
const policies: NetworkPolicy[] = [];
async function fixture(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function policy(): NetworkPolicy {
  const result = new NetworkPolicy({ blockPrivateNetworks: true, allowedHosts: ['127.0.0.1'], blockedHosts: [] });
  policies.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(policies.splice(0).map((item) => item.close()));
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe('bounded policy-aware text transport', () => {
  it.each([
    ['gzip', gzipSync],
    ['br', brotliCompressSync],
    ['deflate', deflateSync],
  ] as const)('decodes %s and enforces decoded byte limits', async (encoding, compress) => {
    const url = await fixture((_req, res) => {
      res.writeHead(200, { 'content-encoding': encoding });
      res.end(compress('search evidence '.repeat(500)));
    });
    await expect(fetchTextWithPolicy(policy(), url)).resolves.toMatchObject({ status: 200, text: 'search evidence '.repeat(500) });
    await expect(fetchTextWithPolicy(policy(), url, { maxBytes: 1_000 })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  });

  it('enforces one absolute deadline while a server continuously sends bytes', async () => {
    let closed = false;
    const url = await fixture((_req, res) => {
      const timer = setInterval(() => res.write('x'), 5);
      res.on('close', () => {
        clearInterval(timer);
        closed = true;
      });
    });
    const started = Date.now();
    await expect(fetchTextWithPolicy(policy(), url, { timeoutMs: 80 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(1_000);
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('closes endless redirect bodies, resolves relative locations, and stops loops', async () => {
    const url = await fixture((req, res) => {
      if (req.url === '/final') {
        res.end('finished');
        return;
      }
      res.writeHead(302, { location: req.url === '/loop' ? '/loop' : '/final' });
      res.flushHeaders();
    });
    await expect(fetchTextWithPolicy(policy(), url)).resolves.toMatchObject({ text: 'finished', url: `${url}/final` });
    await expect(fetchTextWithPolicy(policy(), `${url}/loop`)).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'Redirect loop detected' });
  });

  it.each(['http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'http://user:secret@127.0.0.1/'])(
    'validates every redirect destination: %s',
    async (location) => {
      const url = await fixture((_req, res) => {
        res.writeHead(302, { location });
        res.end();
      });
      await expect(fetchTextWithPolicy(policy(), url)).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });
    },
  );

  it('retries a transient GET failure once and respects Retry-After responses', async () => {
    let attempts = 0;
    const url = await fixture((req, res) => {
      attempts += 1;
      if (req.url === '/limited') {
        res.writeHead(429, { 'retry-after': '10' });
        res.end();
      } else if (attempts === 1) req.socket.destroy();
      else res.end('recovered');
    });
    await expect(fetchTextWithPolicy(policy(), url)).resolves.toMatchObject({ text: 'recovered' });
    expect(attempts).toBe(2);
    await expect(fetchTextWithPolicy(policy(), `${url}/limited`)).resolves.toMatchObject({ status: 429 });
    expect(attempts).toBe(3);
  });

  it('fails closed on truncated bodies and never returns incomplete evidence', async () => {
    const url = await fixture((_req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('partial');
      setImmediate(() => res.destroy());
    });
    await expect(fetchTextWithPolicy(policy(), url)).rejects.toBeInstanceOf(Error);
  });

  it('cancels DNS within the operation deadline and preserves the timeout reason', async () => {
    const cancel = vi.fn();
    const network = new NetworkPolicy(
      { blockPrivateNetworks: true, allowedHosts: [], blockedHosts: [] },
      {
        createResolver: () => ({ resolve4: () => new Promise(() => {}), resolve6: () => new Promise(() => {}), cancel }),
        lookupTimeoutMs: 10_000,
      },
    );
    policies.push(network);
    await expect(fetchTextWithPolicy(network, 'https://slow.invalid', { timeoutMs: 50 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('honors cancellation before starting a request', async () => {
    const handler = vi.fn((_req: http.IncomingMessage, res: http.ServerResponse) => res.end('unexpected'));
    const url = await fixture(handler);
    const controller = new AbortController();
    controller.abort(new TendrilError('CANCELLED', 'user stopped'));
    await expect(fetchTextWithPolicy(policy(), url, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(handler).not.toHaveBeenCalled();
  });
});
