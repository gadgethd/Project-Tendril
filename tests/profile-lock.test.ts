import { access, mkdtemp, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireProfileFileLock } from '../src/browser/profile-lock.js';

function fsError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe('profile filesystem locks', () => {
  it('retries release after a transient unlink failure and marks released only after removal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-profile-lock-release-'));
    let failLockUnlink = true;
    const lock = await acquireProfileFileLock(root, 'transient', {
      unlink: async (...args: Parameters<typeof unlink>) => {
        if (String(args[0]).endsWith('transient.lock') && failLockUnlink) {
          throw fsError('EACCES', 'injected lock unlink failure');
        }
        return unlink(...args);
      },
    });
    await expect(lock.release()).rejects.toThrow('injected lock unlink failure');
    await expect(access(lock.path)).resolves.toBeUndefined();
    failLockUnlink = false;
    await expect(lock.release()).resolves.toBeUndefined();
    await expect(access(lock.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on unreadable or corrupt lock records', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-profile-lock-read-'));
    let failRead = false;
    const unreadable = await acquireProfileFileLock(root, 'unreadable', {
      readFile: async (...args: Parameters<typeof readFile>) => {
        if (failRead && String(args[0]).endsWith('unreadable.lock')) throw fsError('EIO', 'injected read failure');
        return readFile(...args);
      },
    });
    failRead = true;
    await expect(unreadable.release()).rejects.toThrow('unreadable or corrupt');
    failRead = false;
    await unreadable.release();

    const corrupt = await acquireProfileFileLock(root, 'corrupt');
    await writeFile(corrupt.path, '{not-json', 'utf8');
    await expect(corrupt.release()).rejects.toThrow('unreadable or corrupt');
  });

  it('rolls back a published lock when temporary-link cleanup fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-profile-lock-publish-'));
    let failedTemporaryUnlink = false;
    await expect(acquireProfileFileLock(root, 'rollback', {
      unlink: async (...args: Parameters<typeof unlink>) => {
        if (String(args[0]).endsWith('.tmp') && !failedTemporaryUnlink) {
          failedTemporaryUnlink = true;
          throw fsError('EACCES', 'injected temporary unlink failure');
        }
        return unlink(...args);
      },
    })).rejects.toThrow('publication cleanup failed');
    await expect(access(path.join(root, '.profile-locks', 'rollback.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(path.join(root, '.profile-locks'))).toEqual([]);
  });

  it('fails acquisition and leaves no published lock when handle close fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-profile-lock-close-'));
    let failedClose = false;
    await expect(acquireProfileFileLock(root, 'close-failure', {
      open: async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'close') return async () => {
              if (!failedClose) {
                failedClose = true;
                throw new Error('injected handle close failure');
              }
              return target.close();
            };
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    })).rejects.toThrow('Profile lock creation failed');
    await expect(access(path.join(root, '.profile-locks', 'close-failure.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
