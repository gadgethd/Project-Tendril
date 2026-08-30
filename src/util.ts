import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { TendrilError } from './errors.js';
import type { LogRecord, TendrilConfig } from './types.js';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export const SENSITIVE_URL_KEY_PATTERN_SOURCE = [
  '(?:^|[_-])(?:access|refresh|id)?[_-]?token(?:$|[_-])',
  '(?:^|[_-])(?:api[_-]?key|key|secret|password|passwd|authorization|auth|session|cookie|credential|signature)(?:$|[_-])',
  '^(?:sig|code|awsaccesskeyid|googleaccessid)$',
  '^x-(?:amz|goog)-',
].join('|');

export function isSensitiveUrlKey(key: string): boolean {
  return new RegExp(SENSITIVE_URL_KEY_PATTERN_SOURCE, 'i').test(key.slice(0, 500));
}

export function redactUrl(raw: string): string {
  const redactParameters = (parameters: URLSearchParams): void => {
    for (const key of [...parameters.keys()]) {
      if (isSensitiveUrlKey(key)) parameters.set(key, '[redacted]');
    }
  };
  const redactHash = (hash: string): string => {
    if (!hash) return '';
    const queryIndex = hash.indexOf('?');
    const prefix = queryIndex >= 0 ? hash.slice(0, queryIndex + 1) : '';
    const parameterText = queryIndex >= 0 ? hash.slice(queryIndex + 1) : hash;
    if (!parameterText.includes('=')) return isSensitiveUrlKey(parameterText) ? '[redacted]' : hash;
    const parameters = new URLSearchParams(parameterText);
    redactParameters(parameters);
    return `${prefix}${parameters.toString()}`;
  };
  try {
    const parameterOnly = !/[/?#]/.test(raw) && raw.includes('=');
    if (parameterOnly) {
      const parameters = new URLSearchParams(raw);
      redactParameters(parameters);
      return parameters.toString();
    }
    const absolute = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) || raw.startsWith('//');
    const url = new URL(raw, 'https://redaction.invalid/');
    if (url.username) url.username = '[redacted]';
    if (url.password) url.password = '[redacted]';
    redactParameters(url.searchParams);
    url.hash = redactHash(url.hash.slice(1));
    if (absolute) return url.toString();
    if (raw.startsWith('#')) return url.hash;
    if (raw.startsWith('?')) return `${url.search}${url.hash}`;
    const pathAndQuery = `${url.pathname}${url.search}${url.hash}`;
    return raw.startsWith('/') ? pathAndQuery : pathAndQuery.replace(/^\//, '');
  } catch {
    return raw;
  }
}

export class Logger {
  constructor(private readonly minimum: TendrilConfig['logLevel'] = 'info') {}

  log(level: LogRecord['level'], message: string, fields: Record<string, unknown> = {}): void {
    const levels = ['debug', 'info', 'warn', 'error'];
    if (levels.indexOf(level) < levels.indexOf(this.minimum)) return;
    const record: LogRecord = { level, message, time: new Date().toISOString(), ...fields };
    process.stderr.write(`${JSON.stringify(record)}\n`);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.log('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.log('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.log('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.log('error', message, fields);
  }
}

export function safePathBasename(value: string, label = 'Path component'): string {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value !== path.posix.basename(value) ||
    value !== path.win32.basename(value) ||
    value.includes('\0')
  ) {
    throw new TendrilError('CONFIGURATION_ERROR', `${label} must be a safe filename component`);
  }
  return value;
}

export function pathWithinOwnedRoot(root: string, ...components: string[]): string {
  const resolvedRoot = path.resolve(root);
  const safeComponents = components.map((component) => safePathBasename(component));
  const candidate = path.resolve(resolvedRoot, ...safeComponents);
  const relative = path.relative(resolvedRoot, candidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TendrilError('CONFIGURATION_ERROR', 'Constructed path must be a child of its owned root');
  }
  return candidate;
}

export function assertPathWithinOwnedRoot(filePath: string, root: string, label = 'Path'): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(filePath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TendrilError('CONFIGURATION_ERROR', `${label} must be a child of its owned root`);
  }
  return resolvedPath;
}

export async function ensureDir(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  // The directory is an operator-selected root or a child produced by pathWithinOwnedRoot.
  // lgtm[js/path-injection]
  await mkdir(resolved, { recursive: true, mode: 0o700 });
}

export async function assertPathWithinRoots(filePath: string, roots: string[]): Promise<string> {
  let exists = false;
  try {
    await lstat(filePath);
    exists = true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new TendrilError('FILE_ACCESS_DENIED', `File cannot be accessed: ${filePath}`, { cause: error });
    }
  }

  let resolved: string;
  if (exists) {
    try {
      resolved = await realpath(filePath);
      await stat(resolved);
    } catch (error) {
      throw new TendrilError('FILE_ACCESS_DENIED', `File cannot be accessed: ${filePath}`, { cause: error });
    }
  } else {
    const dir = path.dirname(filePath);
    try {
      resolved = await realpath(dir);
      await stat(resolved);
    } catch (error) {
      throw new TendrilError('FILE_ACCESS_DENIED', `Directory does not exist or cannot be accessed: ${dir}`, { cause: error });
    }
  }

  for (const root of roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(root);
    } catch {
      continue;
    }
    const relative = path.relative(resolvedRoot, resolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return exists ? resolved : filePath;
  }
  throw new TendrilError('FILE_ACCESS_DENIED', `File path is outside allowed workspace roots: ${filePath}`);
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TendrilError('TIMEOUT', `${label} timed out after ${timeoutMs}ms`, { retryable: true })), timeoutMs);
      // Cleanup deadlines must keep the process alive until they settle. Otherwise an
      // unresolved operation can let Node exit before its timeout reports failure.
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
