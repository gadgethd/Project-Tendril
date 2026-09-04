import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { TendrilError } from '../errors.js';
import { USER_AGENT } from '../version.js';
import type { NetworkPolicy } from './network-policy.js';

export interface TextFetchOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  accept?: string;
  proxyUrl?: string;
}

export interface TextResponse {
  status: number;
  text: string;
  headers: Record<string, string>;
  url: string;
}

export type TextFetcher = (url: string, options: TextFetchOptions) => Promise<TextResponse>;

function transient(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN'].includes(String(error.code));
}

/** Bounded, cancellable GET with policy validation and DNS pinning at every redirect. */
export async function fetchTextWithPolicy(policy: NetworkPolicy, rawUrl: string, options: TextFetchOptions = {}): Promise<TextResponse> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(maxBytes) ||
    maxBytes <= 0 ||
    (options.deadlineMs !== undefined && !Number.isFinite(options.deadlineMs))
  ) {
    throw new TendrilError('INVALID_ARGUMENT', 'Fetch timeout, deadline, and byte limit must be positive finite values');
  }
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch (cause) {
    throw new TendrilError('INVALID_URL', 'Expected an absolute HTTP(S) URL', { cause });
  }
  const controller = new AbortController();
  const deadline = Math.min(options.deadlineMs ?? Infinity, Date.now() + timeoutMs);
  const onAbort = (): void =>
    controller.abort(options.signal?.reason instanceof Error ? options.signal.reason : new TendrilError('CANCELLED', 'Fetch cancelled'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timeout = (): void => controller.abort(new TendrilError('TIMEOUT', 'Fetch deadline exceeded', { retryable: true }));
  const timer = setTimeout(timeout, Math.max(0, deadline - Date.now()));
  if (deadline <= Date.now()) timeout();
  const { signal } = controller;
  const visited = new Set<string>();
  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      signal.throwIfAborted();
      target.hash = '';
      if (visited.has(target.href)) throw new TendrilError('NETWORK_ERROR', 'Redirect loop detected');
      visited.add(target.href);
      let result: TextResponse | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        signal.throwIfAborted();
        try {
          const destination = await policy.resolve(target.href, signal);
          signal.throwIfAborted();
          result = await new Promise<TextResponse>((resolve, reject) => {
            const proxy = options.proxyUrl ? new URL(options.proxyUrl) : undefined;
            const transport = proxy || target.protocol === 'http:' ? http : https;
            const request = transport.request({
              hostname: proxy?.hostname ?? destination.address,
              family: proxy ? undefined : destination.family,
              servername: destination.hostname,
              port: proxy?.port ?? (target.port || undefined),
              path: proxy ? target.href : `${target.pathname}${target.search}`,
              method: 'GET',
              agent: false,
              headers: {
                host: target.host,
                accept: options.accept ?? 'text/plain,*/*;q=0.1',
                'accept-encoding': 'gzip, deflate, br',
                'user-agent': USER_AGENT,
              },
            });
            let finished = false;
            let cleanupBody: (() => void) | undefined;
            const finish = (error?: unknown, response?: TextResponse): void => {
              if (finished) return;
              finished = true;
              signal.removeEventListener('abort', abort);
              cleanupBody?.();
              request.destroy();
              if (error) reject(error);
              else resolve(response!);
            };
            const abort = (): void => finish(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            request.once('error', (error) => finish(error));
            request.once('response', (response) => {
              const status = response.statusCode ?? 0;
              const headers = Object.fromEntries(
                Object.entries(response.headers).flatMap(([key, value]) =>
                  value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : String(value)]],
                ),
              );
              const metadata = { status, headers, url: target.href };
              cleanupBody = () => response.destroy();
              if (headers['x-tendril-blocked'] === 'true') {
                finish(new TendrilError('NETWORK_BLOCKED', 'Destination blocked by Tendril network policy'));
                return;
              }
              // Close redirect bodies immediately; a redirect may stream forever.
              if (headers.location && [301, 302, 303, 307, 308].includes(status)) {
                finish(undefined, { ...metadata, text: '' });
                return;
              }
              if (Number(headers['content-length']) > maxBytes) {
                finish(new TendrilError('OUTPUT_LIMIT', 'Fetched text exceeds configured response limit'));
                return;
              }
              const encoding = headers['content-encoding']?.trim().toLowerCase();
              const decoder =
                encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
              if (encoding && encoding !== 'identity' && !decoder) {
                finish(new TendrilError('NETWORK_ERROR', `Unsupported response encoding: ${encoding}`));
                return;
              }
              cleanupBody = () => {
                response.destroy();
                decoder?.destroy();
              };
              const body = decoder ?? response;
              let wireBytes = 0;
              let decodedBytes = 0;
              const chunks: Buffer[] = [];
              const limitError = (): TendrilError => new TendrilError('OUTPUT_LIMIT', 'Fetched text exceeds configured response limit');
              response.on('data', (chunk: Buffer) => {
                wireBytes += chunk.length;
                if (wireBytes > maxBytes) finish(limitError());
              });
              response.once('error', (error) => finish(error));
              body.once('error', (error) => finish(error));
              body.on('data', (chunk: Buffer) => {
                decodedBytes += chunk.length;
                if (decodedBytes > maxBytes) finish(limitError());
                else chunks.push(chunk);
              });
              body.once('end', () => finish(undefined, { ...metadata, text: Buffer.concat(chunks).toString('utf8') }));
              if (decoder) response.pipe(decoder);
            });
            if (signal.aborted) abort();
            else request.end();
          });
          if (attempt === 0 && [502, 503, 504].includes(result.status) && !result.headers['retry-after']) {
            await delay(150, undefined, { signal });
            continue;
          }
          break;
        } catch (error) {
          signal.throwIfAborted();
          if (attempt > 0 || !transient(error)) throw error;
          await delay(150, undefined, { signal });
        }
      }
      if (result!.headers.location && [301, 302, 303, 307, 308].includes(result!.status)) {
        try {
          target = new URL(result!.headers.location, target);
        } catch (cause) {
          throw new TendrilError('INVALID_URL', 'Invalid redirect URL', { cause });
        }
        continue;
      }
      return result!;
    }
    throw new TendrilError('NETWORK_ERROR', 'Too many redirects');
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
