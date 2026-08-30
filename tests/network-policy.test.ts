import { describe, expect, it, vi } from 'vitest';
import { isPrivateAddress, NetworkPolicy } from '../src/security/network-policy.js';

describe('NetworkPolicy', () => {
  it('classifies non-public addresses', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.2.3.4')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('blocks localhost unless explicitly allowed', async () => {
    const blocked = new NetworkPolicy({ blockPrivateNetworks: true, allowedHosts: [], blockedHosts: [] });
    await expect(blocked.resolve('http://127.0.0.1/')).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });
    const allowed = new NetworkPolicy({ blockPrivateNetworks: true, allowedHosts: ['localhost', '127.0.0.1'], blockedHosts: [] });
    await expect(allowed.resolve('http://127.0.0.1/')).resolves.toMatchObject({ address: '127.0.0.1', explicitlyAllowed: true });
  });

  it('applies blocklists before allowlists', async () => {
    const policy = new NetworkPolicy({ blockPrivateNetworks: false, allowedHosts: ['*.example.com'], blockedHosts: ['admin.example.com'] });
    await expect(policy.resolveHost('admin.example.com')).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });
  });

  it('retains a usable address family when the parallel family has a transient DNS failure', async () => {
    const policy = new NetworkPolicy(
      { blockPrivateNetworks: false, allowedHosts: [], blockedHosts: [] },
      {
        createResolver: () => ({
          resolve4: async () => ['203.0.113.10'],
          resolve6: async () => {
            throw Object.assign(new Error('temporary AAAA failure'), { code: 'ESERVFAIL' });
          },
          cancel: () => undefined,
        }),
      },
    );
    await expect(policy.resolveHost('single-family.example')).resolves.toMatchObject({
      address: '203.0.113.10',
      family: 4,
    });
  });

  it('cancels and joins a never-settling per-operation resolver on abort and close', async () => {
    const cancel = vi.fn();
    const resolve4 = vi.fn(() => new Promise<string[]>(() => {}));
    const resolve6 = vi.fn(() => new Promise<string[]>(() => {}));
    const policy = new NetworkPolicy(
      { blockPrivateNetworks: false, allowedHosts: [], blockedHosts: [] },
      { createResolver: () => ({ resolve4, resolve6, cancel }), lookupTimeoutMs: 10_000 },
    );
    const controller = new AbortController();
    const lookup = policy.resolveHost('never-settles.invalid', controller.signal);
    await vi.waitFor(() => expect(resolve4).toHaveBeenCalledOnce());
    controller.abort();
    await expect(lookup).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cancel).toHaveBeenCalledOnce();

    const second = policy.resolveHost('also-never-settles.invalid');
    await vi.waitFor(() => expect(resolve4).toHaveBeenCalledTimes(2));
    await policy.close();
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('closes abort races that occur while a resolver is being registered', async () => {
    const external = new AbortController();
    const externalCancel = vi.fn();
    const externalPolicy = new NetworkPolicy(
      { blockPrivateNetworks: false, allowedHosts: [], blockedHosts: [] },
      {
        createResolver: () => {
          external.abort();
          return {
            resolve4: () => new Promise<string[]>(() => {}),
            resolve6: () => new Promise<string[]>(() => {}),
            cancel: externalCancel,
          };
        },
      },
    );
    await expect(externalPolicy.resolveHost('registration-race.invalid', external.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(externalCancel).toHaveBeenCalledOnce();

    let policy!: NetworkPolicy;
    let closing!: Promise<void>;
    const closeCancel = vi.fn();
    policy = new NetworkPolicy(
      { blockPrivateNetworks: false, allowedHosts: [], blockedHosts: [] },
      {
        createResolver: () => {
          closing = policy.close();
          return {
            resolve4: () => new Promise<string[]>(() => {}),
            resolve6: () => new Promise<string[]>(() => {}),
            cancel: closeCancel,
          };
        },
      },
    );
    await expect(policy.resolveHost('close-registration-race.invalid')).rejects.toMatchObject({ code: 'CANCELLED' });
    await closing;
    expect(closeCancel).toHaveBeenCalledOnce();
  });

  it('preserves authoritative cancellation and timeout codes when resolver.cancel rejects c-ares work', async () => {
    const makeResolver = () => {
      const rejectors: Array<(error: Error) => void> = [];
      const pending = () =>
        new Promise<string[]>((_resolve, reject) => {
          rejectors.push(reject);
        });
      return {
        resolve4: pending,
        resolve6: pending,
        cancel: () => {
          const error = Object.assign(new Error('query cancelled'), { code: 'ECANCELLED' });
          for (const reject of rejectors) reject(error);
        },
      };
    };
    const controller = new AbortController();
    const cancelled = new NetworkPolicy({ blockPrivateNetworks: false, allowedHosts: [], blockedHosts: [] }, { createResolver: makeResolver });
    const external = cancelled.resolveHost('cancel-code.invalid', controller.signal);
    controller.abort();
    await expect(external).rejects.toMatchObject({ code: 'CANCELLED' });

    vi.useFakeTimers();
    try {
      const timed = new NetworkPolicy(
        { blockPrivateNetworks: false, allowedHosts: [], blockedHosts: [] },
        { createResolver: makeResolver, lookupTimeoutMs: 100 },
      );
      const lookup = timed.resolveHost('timeout-code.invalid');
      const expectation = expect(lookup).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(101);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
