import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrowserManager } from '../src/browser/manager.js';
import type { TendrilSession } from '../src/browser/session.js';
import { loadConfig } from '../src/config.js';
import { TendrilError } from '../src/errors.js';
import type { SessionCreateOptions } from '../src/types.js';
import { Logger } from '../src/util.js';

interface FactoryOptions {
  id?: string;
  profile?: string;
  userDataDir: string;
  createOptions: SessionCreateOptions;
}

function deferred<T = undefined>() {
  let resolve!: (value: T | void) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise as (value: T | void) => void;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeSession(options: FactoryOptions, close = vi.fn(async () => undefined)): TendrilSession {
  return {
    id: options.id!,
    profile: options.profile,
    ephemeral: options.profile === undefined,
    createOptions: structuredClone(options.createOptions),
    lastActivityAt: new Date(),
    close,
    info: vi.fn(async () => ({
      id: options.id!,
      ...(options.profile ? { profile: options.profile } : {}),
      ephemeral: options.profile === undefined,
      headless: true,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      pages: [],
    })),
  } as unknown as TendrilSession;
}

async function managerFor(root: string, maxSessions: number, factory: (options: FactoryOptions) => Promise<TendrilSession>): Promise<BrowserManager> {
  const config = await loadConfig({
    overrides: {
      dataDir: path.join(root, 'data'),
      runtimeDir: path.join(root, 'run'),
      maxSessions,
      logLevel: 'error',
    },
  });
  const manager = new BrowserManager(config, new Logger('error'), factory);
  await manager.start();
  return manager;
}

describe('BrowserManager lifecycle', () => {
  it.each(['foo.', 'CON', 'nul.txt', 'COM1', 'lPt9.backup'])('rejects the non-portable profile name %s before touching the filesystem', async (profile) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-manager-profile-name-'));
    const factory = vi.fn(async (options: FactoryOptions) => fakeSession(options));
    const manager = await managerFor(root, 1, factory);
    await expect(manager.create({ profile })).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(factory).not.toHaveBeenCalled();
    await manager.closeAll();
  });

  it('reserves capacity before asynchronous launch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-manager-limit-'));
    const launch = deferred<void>();
    const factory = vi.fn(async (options: FactoryOptions) => {
      await launch.promise;
      return fakeSession(options);
    });
    const manager = await managerFor(root, 1, factory);
    const first = manager.create();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    const attempts = [first, ...Array.from({ length: 7 }, () => manager.create())];
    launch.resolve();
    const results = await Promise.allSettled(attempts);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(7);
    expect(factory).toHaveBeenCalledTimes(1);
    await manager.closeAll();
  });

  it('keeps a shared in-flight profile session alive until every lease releases it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-manager-profile-'));
    const launch = deferred<void>();
    const close = vi.fn(async () => undefined);
    const factory = vi.fn(async (options: FactoryOptions) => {
      await launch.promise;
      return fakeSession(options, close);
    });
    const manager = await managerFor(root, 2, factory);
    const first = manager.acquire({ profile: 'shared' });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    const second = manager.acquire({ profile: 'shared' });
    launch.resolve();
    const [creatorLease, joinedLease] = await Promise.all([first, second]);
    expect(joinedLease.session).toBe(creatorLease.session);
    expect(factory).toHaveBeenCalledTimes(1);
    await creatorLease.release();
    expect(close).not.toHaveBeenCalled();
    expect(manager.activeCount()).toBe(1);
    await joinedLease.release();
    await joinedLease.release();
    expect(close).toHaveBeenCalledTimes(1);
    expect(manager.activeCount()).toBe(0);
    await manager.closeAll();
  });

  it('does not close an explicitly owned session when a borrowed lease releases', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-manager-borrow-'));
    const close = vi.fn(async () => undefined);
    const manager = await managerFor(root, 1, async (options) => fakeSession(options, close));
    const session = await manager.create({ profile: 'owned' });
    const lease = await manager.acquire({ profile: 'owned' });
    expect(lease.session).toBe(session);
    await lease.release();
    expect(close).not.toHaveBeenCalled();
    expect(manager.activeCount()).toBe(1);
    await manager.closeAll();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('uses a filesystem lease across manager instances and releases it after close', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-manager-lock-'));
    const factory = async (options: FactoryOptions) => fakeSession(options);
    const firstManager = await managerFor(root, 1, factory);
    const secondManager = await managerFor(root, 1, factory);
    const first = await firstManager.create({ profile: 'exclusive' });
    await expect(secondManager.create({ profile: 'exclusive' })).rejects.toMatchObject({ code: 'PROFILE_IN_USE' });
    await firstManager.close(first.id);
    await expect(secondManager.create({ profile: 'exclusive' })).resolves.toMatchObject({ profile: 'exclusive' });
    await Promise.all([firstManager.closeAll(), secondManager.closeAll()]);
  });

  it('never removes a persistent profile when creation fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-manager-persist-'));
    const profileDir = path.join(root, 'data', 'profiles', 'durable');
    const manager = await managerFor(root, 1, async () => {
      throw new Error('injected launch failure');
    });
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'sentinel'), 'keep me');
    await expect(manager.create({ profile: 'durable' })).rejects.toThrow('injected launch failure');
    expect(await readFile(path.join(profileDir, 'sentinel'), 'utf8')).toBe('keep me');
    await manager.closeAll();
  });

  it('retains capacity and reports shutdown failure when launch termination is unverified', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-manager-unverified-launch-'));
    const manager = await managerFor(root, 1, async () => {
      throw new TendrilError('BROWSER_LAUNCH_FAILED', 'injected unverified termination', {
        details: { browserTerminationVerified: false },
      });
    });
    await expect(manager.create()).rejects.toThrow('injected unverified termination');
    await expect(manager.create()).rejects.toMatchObject({ code: 'SESSION_LIMIT_REACHED' });
    await expect(manager.closeAll()).rejects.toThrow('failed to close completely');
  });

  it('aggregates creation cleanup failure and retains capacity when its profile lock cannot be verified', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-manager-create-cleanup-'));
    const manager = await managerFor(root, 1, async () => {
      await writeFile(path.join(root, 'data', '.profile-locks', 'cleanup-failure.lock'), '{corrupt', 'utf8');
      throw new Error('injected creation failure');
    });
    await expect(manager.create({ profile: 'cleanup-failure' })).rejects.toThrow('cleanup was incomplete');
    await expect(manager.create()).rejects.toMatchObject({ code: 'SESSION_LIMIT_REACHED' });
    await expect(manager.closeAll()).rejects.toThrow('failed to close completely');
  });

  it('fails closed and preserves a stale profile lock for explicit operator recovery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-manager-stale-lock-'));
    const manager = await managerFor(root, 1, async (options) => fakeSession(options));
    const lockDirectory = path.join(root, 'data', '.profile-locks');
    const lockPath = path.join(lockDirectory, 'stale.lock');
    const staleRecord = `${JSON.stringify({
      version: 1,
      pid: 0,
      hostname: os.hostname(),
      token: 'stale-owner-token',
      createdAt: '2020-01-01T00:00:00.000Z',
    })}\n`;
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(lockPath, staleRecord, { mode: 0o600 });

    await expect(manager.create({ profile: 'stale' })).rejects.toMatchObject({
      code: 'PROFILE_IN_USE',
      message: expect.stringContaining(lockPath),
    });
    expect(await readFile(lockPath, 'utf8')).toBe(staleRecord);
    await manager.closeAll();
  });

  it('makes close and shutdown joinable while creation is in flight', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-manager-close-'));
    const launch = deferred<undefined>();
    const cleanup = deferred<undefined>();
    const close = vi.fn(() => cleanup.promise);
    const factory = vi.fn(async (options: FactoryOptions) => {
      await launch.promise;
      return fakeSession(options, close);
    });
    const manager = await managerFor(root, 1, factory);
    const creating = manager.create();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    const shutdown = manager.closeAll();
    launch.resolve();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    cleanup.resolve();
    await expect(creating).rejects.toThrow('closed while the session was starting');
    await Promise.all([shutdown, manager.closeAll()]);
    expect(manager.activeCount()).toBe(0);
    await expect(manager.create()).rejects.toThrow('Browser manager is closing');
  });

  it('coalesces concurrent close calls into one cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-manager-join-'));
    const cleanup = deferred<undefined>();
    const close = vi.fn(() => cleanup.promise);
    const manager = await managerFor(root, 1, async (options) => fakeSession(options, close));
    const session = await manager.create();
    const first = manager.close(session.id);
    const second = manager.close(session.id);
    expect(close).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await Promise.all([first, second]);
    expect(close).toHaveBeenCalledTimes(1);
    await manager.closeAll();
  });

  it('counts a closing session against capacity until cleanup settles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-manager-closing-capacity-'));
    const cleanup = deferred<undefined>();
    const close = vi.fn(() => cleanup.promise);
    const manager = await managerFor(root, 1, async (options) => fakeSession(options, close));
    const session = await manager.create();
    const closing = manager.close(session.id);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await expect(manager.create()).rejects.toMatchObject({ code: 'SESSION_LIMIT_REACHED' });
    cleanup.resolve();
    await closing;
    await expect(manager.create()).resolves.toBeDefined();
    await manager.closeAll();
  });

  it('retains a named-profile lock when session cleanup cannot be verified', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-manager-retained-lock-'));
    const firstManager = await managerFor(root, 1, async (options) =>
      fakeSession(
        options,
        vi.fn(async () => {
          throw new Error('injected termination failure');
        }),
      ),
    );
    const secondManager = await managerFor(root, 1, async (options) => fakeSession(options));
    const session = await firstManager.create({ profile: 'retained' });
    await expect(firstManager.close(session.id)).rejects.toThrow('injected termination failure');
    await expect(firstManager.close(session.id)).rejects.toThrow('injected termination failure');
    await expect(firstManager.create()).rejects.toMatchObject({ code: 'SESSION_LIMIT_REACHED' });
    await expect(secondManager.create({ profile: 'retained' })).rejects.toMatchObject({ code: 'PROFILE_IN_USE' });
    await expect(firstManager.closeAll()).rejects.toThrow('failed to close completely');
    await secondManager.closeAll();
  });
});
