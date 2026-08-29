import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  assertStableTokenFileIdentity,
  constantTimeTokenEqual,
  createCdpCapability,
  loadOrCreateHttpToken,
  parseBearerAuthorization,
  readHttpTokenFromHandle,
  validateHttpToken,
  verifyCdpCapability,
} from '../src/security/auth.js';

describe('HTTP authentication primitives', () => {
  const execFileAsync = promisify(execFile);
  it('compares bearer tokens and rejects weak configured credentials', () => {
    const token = 'a'.repeat(32);
    expect(constantTimeTokenEqual(token, token)).toBe(true);
    expect(constantTimeTokenEqual(`${token}x`, token)).toBe(false);
    expect(constantTimeTokenEqual(undefined, token)).toBe(false);
    expect(() => validateHttpToken('too-short')).toThrow('between 32 and 4096 bytes');
    expect(() => validateHttpToken(` ${token}`)).toThrow('without surrounding whitespace');
    expect(() => validateHttpToken(`${'a'.repeat(16)} ${'b'.repeat(16)}`)).toThrow('ASCII RFC 6750');
    expect(() => validateHttpToken(`${'a'.repeat(16)}\t${'b'.repeat(16)}`)).toThrow('ASCII RFC 6750');
    expect(() => validateHttpToken(`${'a'.repeat(31)}é`)).toThrow('ASCII RFC 6750');
    expect(validateHttpToken('url_safe-token.with~symbols_123456')).toBe('url_safe-token.with~symbols_123456');
    expect(validateHttpToken('standard+/token.with-padding======')).toBe('standard+/token.with-padding======');
    expect(parseBearerAuthorization(`Bearer ${token}`)).toBe(token);
    expect(parseBearerAuthorization(`Bearer ${'a'.repeat(16)} ${'b'.repeat(16)}`)).toBeUndefined();
  });

  it('creates one secure token atomically for concurrent servers', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tendril-auth-'));
    const tokens = await Promise.all(Array.from({ length: 12 }, () => loadOrCreateHttpToken({ dataDir })));
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toHaveLength(43);
    expect((await readFile(path.join(dataDir, 'http-token'), 'utf8')).trim()).toBe(tokens[0]);
    if (process.platform !== 'win32') {
      expect((await lstat(path.join(dataDir, 'http-token'))).mode & 0o777).toBe(0o600);
    }
  });

  it('fails closed for permissive or non-regular token files', async () => {
    const permissiveDir = await mkdtemp(path.join(os.tmpdir(), 'tendril-auth-mode-'));
    const tokenPath = path.join(permissiveDir, 'http-token');
    await writeFile(tokenPath, `${'b'.repeat(32)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') {
      await chmod(tokenPath, 0o644);
      await expect(loadOrCreateHttpToken({ dataDir: permissiveDir })).rejects.toThrow('must not be accessible');
    }

    const nonRegularDir = await mkdtemp(path.join(os.tmpdir(), 'tendril-auth-directory-'));
    await mkdir(path.join(nonRegularDir, 'http-token'));
    await expect(loadOrCreateHttpToken({ dataDir: nonRegularDir })).rejects.toThrow('must be a regular file');

    if (process.platform !== 'win32') {
      const symlinkDir = await mkdtemp(path.join(os.tmpdir(), 'tendril-auth-link-'));
      const target = path.join(symlinkDir, 'target');
      await writeFile(target, `${'c'.repeat(32)}\n`, { mode: 0o600 });
      await symlink(target, path.join(symlinkDir, 'http-token'));
      await expect(loadOrCreateHttpToken({ dataDir: symlinkDir })).rejects.toThrow('must be a regular file');
    }
  });

  it.skipIf(process.platform === 'win32')('opens token paths nonblocking and promptly rejects a FIFO', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tendril-auth-fifo-'));
    await execFileAsync('mkfifo', [path.join(dataDir, 'http-token')]);
    const started = Date.now();
    await expect(loadOrCreateHttpToken({ dataDir })).rejects.toThrow('must be a regular file');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('rolls back token publication when temporary-link cleanup fails', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tendril-auth-cleanup-'));
    let injected = false;
    await expect(loadOrCreateHttpToken({
      dataDir,
      fileOperations: {
        unlink: async (filePath) => {
          if (!injected && filePath.endsWith('.tmp')) {
            injected = true;
            throw Object.assign(new Error('injected temporary unlink failure'), { code: 'EPERM' });
          }
          await unlink(filePath);
        },
      },
    })).rejects.toThrow('Unable to create token file');
    expect(injected).toBe(true);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('reads the opened token inode when the path is atomically replaced by a symlink', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tendril-auth-swap-'));
    const tokenPath = path.join(dataDir, 'http-token');
    const originalPath = path.join(dataDir, 'original-token');
    const attackerPath = path.join(dataDir, 'attacker-token');
    const originalToken = 'o'.repeat(32);
    const attackerToken = 'x'.repeat(32);
    await writeFile(tokenPath, `${originalToken}\n`, { mode: 0o600 });
    await writeFile(attackerPath, `${attackerToken}\n`, { mode: 0o600 });
    const handle = await open(tokenPath, 'r');
    try {
      await rename(tokenPath, originalPath);
      await symlink(attackerPath, tokenPath);
      await expect(readHttpTokenFromHandle(handle, tokenPath)).resolves.toBe(originalToken);
    } finally {
      await handle.close();
    }
  });

  it('detects a regular-file identity swap with Windows-compatible bigint metadata', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tendril-auth-identity-'));
    const tokenPath = path.join(dataDir, 'http-token');
    const originalPath = path.join(dataDir, 'original-token');
    await writeFile(tokenPath, `${'o'.repeat(32)}\n`, { mode: 0o600 });
    const before = await lstat(tokenPath, { bigint: true });
    const handle = await open(tokenPath, 'r');
    try {
      const opened = await handle.stat({ bigint: true });
      const unchanged = await lstat(tokenPath, { bigint: true });
      expect(() => assertStableTokenFileIdentity(before, opened, unchanged, tokenPath)).not.toThrow();

      await rename(tokenPath, originalPath);
      await writeFile(tokenPath, `${'x'.repeat(32)}\n`, { mode: 0o600 });
      const replacement = await lstat(tokenPath, { bigint: true });
      expect(() => assertStableTokenFileIdentity(before, opened, replacement, tokenPath)).toThrow('changed while it was being opened');
    } finally {
      await handle.close();
    }
  });

  it('issues expiring capabilities bound to exactly one session', () => {
    const master = 'master-token-with-at-least-thirty-two-bytes';
    const now = 1_000_000;
    const capability = createCdpCapability(master, 'session-a', { now, ttlMs: 5_000 });
    expect(capability).not.toContain(master);
    expect(verifyCdpCapability(capability, master, 'session-a', now + 4_999)).toBe(true);
    expect(verifyCdpCapability(capability, master, 'session-b', now + 1)).toBe(false);
    expect(verifyCdpCapability(capability, master, 'session-a', now + 5_000)).toBe(false);
    expect(verifyCdpCapability(`${capability}x`, master, 'session-a', now + 1)).toBe(false);
  });
});
