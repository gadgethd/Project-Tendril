import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { TendrilError } from '../errors.js';
import { ensureDir, pathWithinOwnedRoot, randomToken } from '../util.js';

const MIN_TOKEN_BYTES = 32;
const MAX_TOKEN_BYTES = 4096;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+={0,}$/;
export const CDP_CAPABILITY_TTL_MS = 5 * 60_000;

function configurationError(message: string, cause?: unknown): TendrilError {
  return new TendrilError('CONFIGURATION_ERROR', message, cause === undefined ? {} : { cause });
}

export function constantTimeTokenEqual(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false;
  const candidateDigest = createHash('sha256').update(candidate).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  const equalDigest = timingSafeEqual(candidateDigest, expectedDigest);
  return equalDigest && Buffer.byteLength(candidate) === Buffer.byteLength(expected);
}

export function validateHttpToken(value: string, source = 'Tendril HTTP token'): string {
  if (value !== value.trim() || /[\0\r\n]/.test(value)) {
    throw configurationError(`${source} must be a single token without surrounding whitespace`);
  }
  const bytes = Buffer.byteLength(value);
  if (bytes < MIN_TOKEN_BYTES || bytes > MAX_TOKEN_BYTES) {
    throw configurationError(`${source} must be between ${MIN_TOKEN_BYTES} and ${MAX_TOKEN_BYTES} bytes`);
  }
  if (!BEARER_TOKEN.test(value)) {
    throw configurationError(`${source} must use the ASCII RFC 6750 bearer-token character set`);
  }
  return value;
}

export function parseBearerAuthorization(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^Bearer (.+)$/i.exec(value);
  return match?.[1] && BEARER_TOKEN.test(match[1]) ? match[1] : undefined;
}

function tokenFromFile(raw: string, tokenPath: string): string {
  const withoutNewline = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  return validateHttpToken(withoutNewline, `Token file ${tokenPath}`);
}

async function readSecureTokenFile(tokenPath: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let windowsIdentityBefore: BigIntStats | undefined;
  if (process.platform === 'win32') {
    try {
      windowsIdentityBefore = await lstat(tokenPath, { bigint: true });
      if (!windowsIdentityBefore.isFile() || windowsIdentityBefore.isSymbolicLink()) {
        throw configurationError(`Token path ${tokenPath} must be a regular file`);
      }
    } catch (error) {
      if (error instanceof TendrilError) throw error;
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw error;
      throw configurationError(`Unable to inspect token file ${tokenPath}`, error);
    }
  }
  try {
    const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
    const nonBlock = process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0);
    handle = await open(tokenPath, constants.O_RDONLY | noFollow | nonBlock);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP') {
      throw configurationError(`Token path ${tokenPath} must be a regular file`);
    }
    throw configurationError(`Unable to open token file ${tokenPath}`, error);
  }
  try {
    if (windowsIdentityBefore) {
      try {
        const openedIdentity = await handle.stat({ bigint: true });
        const windowsIdentityAfter = await lstat(tokenPath, { bigint: true });
        assertStableTokenFileIdentity(windowsIdentityBefore, openedIdentity, windowsIdentityAfter, tokenPath);
      } catch (error) {
        if (error instanceof TendrilError) throw error;
        throw configurationError(`Unable to verify token file identity ${tokenPath}`, error);
      }
    }
    return await readHttpTokenFromHandle(handle, tokenPath);
  } finally {
    await handle.close();
  }
}

export function assertStableTokenFileIdentity(
  before: BigIntStats,
  opened: BigIntStats,
  after: BigIntStats,
  tokenPath: string,
): void {
  if (!before.isFile() || before.isSymbolicLink() || !opened.isFile() || !after.isFile() || after.isSymbolicLink()) {
    throw configurationError(`Token path ${tokenPath} must remain a regular file while it is opened`);
  }
  if (before.ino === 0n || opened.ino === 0n || after.ino === 0n) {
    throw configurationError(
      `Token file identity cannot be verified on this Windows filesystem: ${tokenPath}. Use a local dataDir with stable file identities or provide TENDRIL_TOKEN through a secret manager.`,
    );
  }
  const sameOpenedFile = before.dev === opened.dev && before.ino === opened.ino;
  const samePublishedFile = opened.dev === after.dev && opened.ino === after.ino;
  if (!sameOpenedFile || !samePublishedFile) {
    throw configurationError(`Token file changed while it was being opened: ${tokenPath}`);
  }
}

export async function readHttpTokenFromHandle(
  handle: Awaited<ReturnType<typeof open>>,
  tokenPath: string,
): Promise<string> {
  const maximumFileBytes = MAX_TOKEN_BYTES + 2;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw configurationError(`Token path ${tokenPath} must be a regular file`);
    if (process.platform !== 'win32') {
      if ((metadata.mode & 0o077) !== 0) throw configurationError(`Token file ${tokenPath} must not be accessible by group or other users`);
      const uid = process.getuid?.();
      if (uid !== undefined && metadata.uid !== uid) throw configurationError(`Token file ${tokenPath} must be owned by the Tendril user`);
    }
    if (metadata.size > maximumFileBytes) throw configurationError(`Token file ${tokenPath} is unexpectedly large`);

    const content = Buffer.alloc(maximumFileBytes + 1);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumFileBytes) throw configurationError(`Token file ${tokenPath} is unexpectedly large`);
    return tokenFromFile(content.subarray(0, offset).toString('utf8'), tokenPath);
  } catch (error) {
    if (error instanceof TendrilError) throw error;
    throw configurationError(`Unable to read token file ${tokenPath}`, error);
  }
}

interface TokenFileOperations {
  unlink?: (filePath: string) => Promise<void>;
}

async function unlinkOwnedPublishedToken(
  tokenPath: string,
  candidate: string,
  unlinkFile: (filePath: string) => Promise<void>,
): Promise<void> {
  try {
    const current = await readSecureTokenFile(tokenPath);
    if (!constantTimeTokenEqual(current, candidate)) {
      throw new Error(`Refusing to remove token path ${tokenPath} because its contents changed`);
    }
    await unlinkFile(tokenPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  let replacement: string;
  try { replacement = await readSecureTokenFile(tokenPath); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (constantTimeTokenEqual(replacement, candidate)) {
    throw new Error(`Token path ${tokenPath} still contains the unpublished candidate after cleanup`);
  }
}

async function createTokenFileAtomically(tokenPath: string, operations: TokenFileOperations = {}): Promise<void> {
  const candidate = randomToken();
  const temporaryPath = pathWithinOwnedRoot(
    path.dirname(tokenPath),
    `.http-token.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const unlinkFile = operations.unlink ?? unlink;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  let operationFailure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${candidate}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, tokenPath);
      published = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  } catch (error) {
    operationFailure = error;
  }
  if (handle) {
    try { await handle.close(); }
    catch (error) { cleanupFailures.push(error); }
  }
  try {
    await unlinkFile(temporaryPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) cleanupFailures.push(error);
  }
  if (cleanupFailures.length && published) {
    try { await unlinkOwnedPublishedToken(tokenPath, candidate, unlinkFile); }
    catch (error) { cleanupFailures.push(error); }
  }
  if (cleanupFailures.length) {
    // A transient failure may have left the private temporary link behind. Retry
    // after rolling back publication, but retain the original failure so startup
    // cannot silently succeed with an artifact.
    try { await unlinkFile(temporaryPath); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) cleanupFailures.push(error);
    }
  }
  if (operationFailure !== undefined || cleanupFailures.length) {
    throw new AggregateError(
      [...(operationFailure === undefined ? [] : [operationFailure]), ...cleanupFailures],
      'Atomic token-file publication failed',
    );
  }
}

export async function loadOrCreateHttpToken(options: {
  configuredToken?: string;
  dataDir: string;
  fileOperations?: TokenFileOperations;
}): Promise<string> {
  if (options.configuredToken !== undefined) return validateHttpToken(options.configuredToken, 'Configured Tendril HTTP token');
  await ensureDir(options.dataDir);
  const tokenPath = pathWithinOwnedRoot(options.dataDir, 'http-token');
  try {
    return await readSecureTokenFile(tokenPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  try {
    await createTokenFileAtomically(tokenPath, options.fileOperations);
  } catch (error) {
    throw configurationError(`Unable to create token file ${tokenPath}`, error);
  }
  return readSecureTokenFile(tokenPath);
}

interface CdpCapabilityPayload {
  version: 1;
  sessionId: string;
  expiresAt: number;
}

export function createCdpCapability(
  masterToken: string,
  sessionId: string,
  options: { now?: number; ttlMs?: number } = {},
): string {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? CDP_CAPABILITY_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > CDP_CAPABILITY_TTL_MS) {
    throw new TendrilError('CONFIGURATION_ERROR', `CDP capability lifetime must be between 1 and ${CDP_CAPABILITY_TTL_MS}ms`);
  }
  const payload: CdpCapabilityPayload = { version: 1, sessionId, expiresAt: now + ttlMs };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', masterToken).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyCdpCapability(
  capability: string | undefined,
  masterToken: string,
  expectedSessionId: string,
  now = Date.now(),
): boolean {
  if (!capability || capability.length > 2048) return false;
  const parts = capability.split('.');
  if (parts.length !== 2) return false;
  const [encoded, signature] = parts as [string, string];
  const expectedSignature = createHmac('sha256', masterToken).update(encoded).digest('base64url');
  if (!constantTimeTokenEqual(signature, expectedSignature)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<CdpCapabilityPayload>;
    return payload.version === 1
      && payload.sessionId === expectedSessionId
      && Number.isSafeInteger(payload.expiresAt)
      && (payload.expiresAt as number) > now
      && (payload.expiresAt as number) <= now + CDP_CAPABILITY_TTL_MS;
  } catch {
    return false;
  }
}
