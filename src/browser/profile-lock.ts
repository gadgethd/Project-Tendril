import { randomBytes } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import { TendrilError } from '../errors.js';
import { ensureDir, pathWithinOwnedRoot } from '../util.js';
import { validateProfileName } from './profile-name.js';

interface LockRecord {
  version: 1;
  pid: number;
  hostname: string;
  token: string;
  createdAt: string;
}

interface ProfileLockDependencies {
  link?: typeof link;
  open?: typeof open;
  readFile?: typeof readFile;
  unlink?: typeof unlink;
}

export interface ProfileFileLock {
  readonly path: string;
  release(): Promise<void>;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

async function readLock(lockPath: string, dependencies: ProfileLockDependencies): Promise<LockRecord | undefined> {
  try {
    // lockPath is constructed from a validated portable basename beneath .profile-locks.
    // lgtm[js/path-injection]
    const parsed = JSON.parse(await (dependencies.readFile ?? readFile)(lockPath, 'utf8')) as Partial<LockRecord>;
    if (
      parsed.version !== 1
      || typeof parsed.pid !== 'number'
      || typeof parsed.hostname !== 'string'
      || typeof parsed.token !== 'string'
      || typeof parsed.createdAt !== 'string'
    ) {
      throw new Error('invalid lock record');
    }
    return parsed as LockRecord;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new TendrilError(
      'PROFILE_IN_USE',
      `Profile lock is unreadable or corrupt: ${lockPath}. Verify no Tendril process owns the profile before explicit operator recovery.`,
      { cause: error, retryable: true },
    );
  }
}

async function removeOwnedLock(
  lockPath: string,
  token: string,
  dependencies: ProfileLockDependencies,
): Promise<void> {
  const current = await readLock(lockPath, dependencies);
  if (!current) return;
  if (current.token !== token) {
    throw new TendrilError('PROFILE_IN_USE', `Profile lock ownership changed before release: ${lockPath}`, { retryable: true });
  }
  try {
    // The exact path was verified against this lock capability immediately above.
    // lgtm[js/path-injection]
    await (dependencies.unlink ?? unlink)(lockPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const after = await readLock(lockPath, dependencies);
  if (after?.token === token) throw new Error(`Profile lock still exists after release: ${lockPath}`);
}

async function publishLock(
  lockPath: string,
  record: LockRecord,
  dependencies: ProfileLockDependencies,
): Promise<boolean> {
  const temporaryPath = `${lockPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  let published = false;
  let result = false;
  let operationFailure: unknown;
  try {
    // temporaryPath appends only the numeric PID and cryptographic random bytes to an owned lock path.
    // lgtm[js/path-injection]
    handle = await (dependencies.open ?? open)(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      // Both paths are children of the same operator-owned .profile-locks directory.
      // lgtm[js/path-injection]
      await (dependencies.link ?? link)(temporaryPath, lockPath);
      published = true;
      result = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  } catch (error) {
    operationFailure = error;
  }

  const cleanupFailures: unknown[] = [];
  if (handle) {
    try { await handle.close(); } catch (error) { cleanupFailures.push(error); }
  }
  if (temporaryCreated) {
    try {
      // temporaryPath is the exact exclusively-created file above, not request data.
      // lgtm[js/path-injection]
      await (dependencies.unlink ?? unlink)(temporaryPath);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) cleanupFailures.push(error);
    }
  }
  if (published && cleanupFailures.length) {
    try { await removeOwnedLock(lockPath, record.token, dependencies); }
    catch (error) { cleanupFailures.push(error); }
  }
  if (temporaryCreated && cleanupFailures.length) {
    try { await (dependencies.unlink ?? unlink)(temporaryPath); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) cleanupFailures.push(error);
    }
  }
  if (operationFailure !== undefined || cleanupFailures.length) {
    throw new AggregateError(
      [...(operationFailure === undefined ? [] : [operationFailure]), ...cleanupFailures],
      published ? 'Profile lock publication cleanup failed' : 'Profile lock creation failed',
    );
  }
  return result;
}

export async function acquireProfileFileLock(
  dataDir: string,
  profile: string,
  dependencies: ProfileLockDependencies = {},
): Promise<ProfileFileLock> {
  const portableProfile = validateProfileName(profile);
  const lockDirectory = pathWithinOwnedRoot(dataDir, '.profile-locks');
  await ensureDir(lockDirectory);
  const lockPath = pathWithinOwnedRoot(lockDirectory, `${portableProfile}.lock`);
  const record: LockRecord = {
    version: 1,
    pid: process.pid,
    hostname: os.hostname(),
    token: randomBytes(24).toString('base64url'),
    createdAt: new Date().toISOString(),
  };

  if (await publishLock(lockPath, record, dependencies)) {
    let released = false;
    return {
      path: lockPath,
      async release() {
        if (released) return;
        await removeOwnedLock(lockPath, record.token, dependencies);
        released = true;
      },
    };
  }

  const existing = await readLock(lockPath, dependencies);
  const ownedByLiveLocalProcess = existing
    && existing.hostname === os.hostname()
    && processIsAlive(existing.pid);
  if (ownedByLiveLocalProcess) {
    throw new TendrilError('PROFILE_IN_USE', `Profile is already active: ${profile}`, { retryable: true });
  }
  throw new TendrilError(
    'PROFILE_IN_USE',
    `Profile lock may be stale or unverifiable: ${lockPath}. After verifying no Tendril process owns the profile, an operator must remove this lock explicitly.`,
    { retryable: true },
  );
}
