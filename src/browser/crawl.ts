import { StringDecoder } from 'node:string_decoder';
import robotsParser from 'robots-parser';
import { TendrilError } from '../errors.js';
import type { CrawlJob, CrawlResult, CrawlResultPage } from '../types.js';
import { type Logger, newId, withTimeout } from '../util.js';
import type { BrowserManager } from './manager.js';
import type { TendrilSession } from './session.js';

interface InternalJob extends Omit<CrawlJob, 'resultCount'> {
  results: CrawlResult[];
  cancelled: boolean;
  storedMarkdownBytes: number;
  storedLinkBytes: number;
  storedLinkCount: number;
  storedTitleBytes: number;
  activeSessionId?: string;
  cancellationClose?: Promise<void>;
  controller: AbortController;
  deadlineTimer: NodeJS.Timeout;
  abortReason?: Error;
  creationCleanup?: Promise<void>;
  creationCleanupFailure?: unknown;
}
interface RobotsPolicy {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}
interface CrawlOptions {
  url: string;
  maxPages?: number;
  maxDepth?: number;
  sameOrigin?: boolean;
  respectRobots?: boolean;
}
interface CrawlServiceOptions {
  maxJobs?: number;
  retentionMs?: number;
  maxResultMarkdownBytes?: number;
  maxJobMarkdownBytes?: number;
  jobTimeoutMs?: number;
  creationCleanupTimeoutMs?: number;
  maxResultLinks?: number;
  maxJobLinks?: number;
  maxResultLinkBytes?: number;
  maxJobLinkBytes?: number;
  maxResultTitleBytes?: number;
  maxJobTitleBytes?: number;
  now?: () => number;
}
const parseRobots = robotsParser as unknown as (url: string, content: string) => RobotsPolicy;

function canonical(raw: string): string | undefined {
  try {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8_192) return undefined;
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return undefined;
  }
}

function redactErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
    try {
      const url = new URL(match);
      url.username = '';
      url.password = '';
      for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]');
      url.hash = '';
      return url.toString();
    } catch {
      return '[redacted URL]';
    }
  });
  return truncateUtf8(redacted, 2_048);
}

function publicCrawlUrl(raw: string): string {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]');
  return truncateUtf8(url.toString(), 2_048);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  const decoder = new StringDecoder('utf8');
  return decoder.write(Buffer.from(value).subarray(0, maximumBytes));
}

export class CrawlService {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly maxJobs: number;
  private readonly retentionMs: number;
  private readonly maxResultMarkdownBytes: number;
  private readonly maxJobMarkdownBytes: number;
  private readonly jobTimeoutMs: number;
  private readonly creationCleanupTimeoutMs: number;
  private readonly maxResultLinks: number;
  private readonly maxJobLinks: number;
  private readonly maxResultLinkBytes: number;
  private readonly maxJobLinkBytes: number;
  private readonly maxResultTitleBytes: number;
  private readonly maxJobTitleBytes: number;
  private readonly now: () => number;
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly manager: BrowserManager,
    private readonly logger: Logger,
    options: CrawlServiceOptions = {},
  ) {
    this.maxJobs = Math.max(1, options.maxJobs ?? 100);
    this.retentionMs = Math.max(1_000, options.retentionMs ?? 30 * 60_000);
    this.maxResultMarkdownBytes = Math.max(1, options.maxResultMarkdownBytes ?? 100_000);
    this.maxJobMarkdownBytes = Math.max(1, options.maxJobMarkdownBytes ?? 2_000_000);
    this.jobTimeoutMs = Math.max(100, options.jobTimeoutMs ?? 5 * 60_000);
    this.creationCleanupTimeoutMs = Math.max(100, options.creationCleanupTimeoutMs ?? 5_000);
    this.maxResultLinks = Math.max(1, options.maxResultLinks ?? 250);
    this.maxJobLinks = Math.max(1, options.maxJobLinks ?? 2_000);
    this.maxResultLinkBytes = Math.max(128, options.maxResultLinkBytes ?? 100_000);
    this.maxJobLinkBytes = Math.max(128, options.maxJobLinkBytes ?? 500_000);
    this.maxResultTitleBytes = Math.max(1, options.maxResultTitleBytes ?? 4_096);
    this.maxJobTitleBytes = Math.max(1, options.maxJobTitleBytes ?? 100_000);
    this.now = options.now ?? Date.now;
  }

  start(options: CrawlOptions): CrawlJob {
    return this.startJob(options);
  }

  followUp(parentJobId: string, options: CrawlOptions): CrawlJob {
    this.evictExpired();
    if (!this.jobs.has(parentJobId)) throw new TendrilError('CRAWL_FAILED', `Crawl job not found: ${parentJobId}`);
    return this.startJob(options, parentJobId);
  }

  private startJob(options: CrawlOptions, parentJobId?: string): CrawlJob {
    if (this.closing) throw new TendrilError('CRAWL_FAILED', 'Crawl service is closing');
    this.evictExpired();
    this.evictToLimit(this.maxJobs - 1);
    if (this.jobs.size >= this.maxJobs) throw new TendrilError('CRAWL_FAILED', 'Too many active crawl jobs', { retryable: true });
    const url = canonical(options?.url);
    if (!url) throw new TendrilError('INVALID_URL', 'Crawl URL must be a credential-free HTTP(S) URL no longer than 8192 characters');
    const maxPages = options.maxPages ?? 20;
    const maxDepth = options.maxDepth ?? 2;
    if (!Number.isFinite(maxPages) || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
      throw new TendrilError('CRAWL_FAILED', 'maxPages must be a finite integer from 1 to 100');
    }
    if (!Number.isFinite(maxDepth) || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 5) {
      throw new TendrilError('CRAWL_FAILED', 'maxDepth must be a finite integer from 0 to 5');
    }
    if (options.sameOrigin !== undefined && typeof options.sameOrigin !== 'boolean') throw new TendrilError('CRAWL_FAILED', 'sameOrigin must be a boolean');
    if (options.respectRobots !== undefined && typeof options.respectRobots !== 'boolean')
      throw new TendrilError('CRAWL_FAILED', 'respectRobots must be a boolean');
    const controller = new AbortController();
    const job: InternalJob = {
      id: newId('crawl'),
      status: 'running',
      startedAt: new Date(this.now()).toISOString(),
      queued: 1,
      visited: 0,
      results: [],
      cancelled: false,
      storedMarkdownBytes: 0,
      storedLinkBytes: 0,
      storedLinkCount: 0,
      storedTitleBytes: 0,
      controller,
      deadlineTimer: setTimeout(() => {
        job.abortReason = new TendrilError('TIMEOUT', `Crawl exceeded its ${this.jobTimeoutMs}ms execution deadline`, { retryable: true });
        controller.abort(job.abortReason);
      }, this.jobTimeoutMs),
      ...(parentJobId ? { parentJobId } : {}),
    };
    this.jobs.set(job.id, job);
    const task = this.run(job, {
      url,
      maxPages,
      maxDepth,
      sameOrigin: options.sameOrigin ?? true,
      respectRobots: options.respectRobots ?? true,
    });
    this.tasks.set(job.id, task);
    const finish = (): void => {
      clearTimeout(job.deadlineTimer);
      this.tasks.delete(job.id);
      this.scheduleExpiration(job);
      this.evictExpired();
      this.evictToLimit(this.maxJobs);
    };
    void task.then(finish, finish);
    return this.publicJob(job);
  }

  get(id: string): CrawlJob {
    this.evictExpired();
    return this.publicJob(this.requireJob(id));
  }

  results(id: string, options: { offset?: number; limit?: number } = {}): CrawlResultPage {
    this.evictExpired();
    const job = this.requireJob(id);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 20;
    if (!Number.isInteger(offset) || offset < 0) throw new TendrilError('CRAWL_FAILED', 'Crawl result offset must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TendrilError('CRAWL_FAILED', 'Crawl result limit must be an integer from 1 to 100');
    const results = structuredClone(job.results.slice(offset, offset + limit));
    const nextOffset = offset + results.length < job.results.length ? offset + results.length : undefined;
    return {
      jobId: job.id,
      status: job.status,
      offset,
      limit,
      total: job.results.length,
      results,
      ...(nextOffset === undefined ? {} : { nextOffset }),
    };
  }

  cancel(id: string): CrawlJob {
    const job = this.requireJob(id);
    job.cancelled = true;
    job.controller.abort(Object.assign(new Error('Crawl was cancelled'), { name: 'AbortError' }));
    this.closeActiveSession(job);
    return this.publicJob(job);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      const activeCloses: Promise<void>[] = [];
      for (const job of this.jobs.values()) {
        if (job.status !== 'running') continue;
        job.cancelled = true;
        job.controller.abort(Object.assign(new Error('Crawl service is closing'), { name: 'AbortError' }));
        const close = this.closeActiveSession(job);
        if (close) activeCloses.push(close);
      }
      await Promise.allSettled(activeCloses);
      await Promise.allSettled([...this.tasks.values()]);
      for (const timer of this.expiryTimers.values()) clearTimeout(timer);
      this.expiryTimers.clear();
    })();
    return this.closePromise;
  }

  private requireJob(id: string): InternalJob {
    const job = this.jobs.get(id);
    if (!job) throw new TendrilError('CRAWL_FAILED', `Crawl job not found: ${id}`);
    return job;
  }

  private publicJob(job: InternalJob): CrawlJob {
    return structuredClone({
      id: job.id,
      ...(job.parentJobId ? { parentJobId: job.parentJobId } : {}),
      status: job.status,
      startedAt: job.startedAt,
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      queued: job.queued,
      visited: job.visited,
      resultCount: job.results.length,
      ...(job.error ? { error: job.error } : {}),
    });
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      if (job.status === 'running' || !job.completedAt) continue;
      if (new Date(job.completedAt).getTime() <= cutoff) this.deleteJob(id);
    }
  }

  private evictToLimit(limit: number): void {
    if (this.jobs.size <= limit) return;
    const completed = [...this.jobs.values()]
      .filter((job) => job.status !== 'running')
      .sort((left, right) => (left.completedAt ?? left.startedAt).localeCompare(right.completedAt ?? right.startedAt));
    for (const job of completed) {
      if (this.jobs.size <= limit) break;
      this.deleteJob(job.id);
    }
  }

  private scheduleExpiration(job: InternalJob): void {
    if (job.status === 'running' || !job.completedAt || this.closing) return;
    const existing = this.expiryTimers.get(job.id);
    if (existing) clearTimeout(existing);
    const expiresAt = new Date(job.completedAt).getTime() + this.retentionMs;
    const timer = setTimeout(
      () => {
        this.expiryTimers.delete(job.id);
        const current = this.jobs.get(job.id);
        if (current && current.status !== 'running') this.deleteJob(job.id);
      },
      Math.max(1, expiresAt - this.now()),
    );
    timer.unref();
    this.expiryTimers.set(job.id, timer);
  }

  private deleteJob(id: string): void {
    const job = this.jobs.get(id);
    if (job) clearTimeout(job.deadlineTimer);
    this.jobs.delete(id);
    const timer = this.expiryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(id);
  }

  private closeActiveSession(job: InternalJob): Promise<void> | undefined {
    if (!job.activeSessionId) return undefined;
    if (!job.cancellationClose) {
      job.cancellationClose = this.manager.close(job.activeSessionId);
      // Mark the shared promise handled immediately; run() still awaits this exact
      // promise and publishes any cleanup rejection as the terminal job error.
      void job.cancellationClose.catch(() => undefined);
    }
    return job.cancellationClose;
  }

  private async robotsFor(
    job: InternalJob,
    session: TendrilSession,
    url: URL,
    cache: Map<string, Promise<RobotsPolicy | undefined>>,
  ): Promise<RobotsPolicy | undefined> {
    let pending = cache.get(url.origin);
    if (!pending) {
      pending = (async () => {
        const robotsUrl = new URL('/robots.txt', url.origin).toString();
        try {
          const { text } = await this.awaitJob(job, session.fetchText(robotsUrl, undefined, job.controller.signal));
          return parseRobots(robotsUrl, text);
        } catch (error) {
          if (job.controller.signal.aborted) throw error;
          return undefined;
        }
      })();
      cache.set(url.origin, pending);
    }
    return pending;
  }

  private async awaitJob<T>(job: InternalJob, operation: Promise<T>): Promise<T> {
    if (job.controller.signal.aborted) throw job.abortReason ?? job.controller.signal.reason ?? this.abortError();
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = (): void => rejectAbort(job.abortReason ?? job.controller.signal.reason ?? this.abortError());
    job.controller.signal.addEventListener('abort', onAbort, { once: true });
    void operation.catch(() => undefined);
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      job.controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private abortError(): Error {
    return Object.assign(new Error('Crawl was cancelled'), { name: 'AbortError' });
  }

  private async cleanupLateCreation(creation: Promise<TendrilSession>): Promise<void> {
    const deadline = Date.now() + this.creationCleanupTimeoutMs;
    const remaining = (): number => Math.max(1, deadline - Date.now());
    let lateSession: TendrilSession;
    try {
      lateSession = await withTimeout(creation, remaining(), 'Pending crawl session creation');
    } catch (error) {
      if (!(error instanceof TendrilError && error.code === 'TIMEOUT')) return;
      // Continue best-effort cleanup if creation eventually resolves, while the
      // bounded failure below keeps the job from claiming a verified cancellation.
      void creation.then((session) => this.manager.close(session.id)).catch(() => undefined);
      throw new TendrilError('CRAWL_FAILED', 'Pending crawl session creation did not settle before the cleanup deadline', {
        cause: error,
      });
    }
    await withTimeout(this.manager.close(lateSession.id), remaining(), 'Late crawl session cleanup');
  }

  private async run(
    job: InternalJob,
    options: { url: string; maxPages: number; maxDepth: number; sameOrigin: boolean; respectRobots: boolean },
  ): Promise<void> {
    let session: TendrilSession | undefined;
    let terminalStatus: CrawlJob['status'] = 'completed';
    let terminalError: string | undefined;
    try {
      const creation = this.manager.create();
      try {
        session = await this.awaitJob(job, creation);
      } catch (error) {
        if (job.controller.signal.aborted) {
          job.creationCleanup ??= this.cleanupLateCreation(creation);
          void job.creationCleanup.catch(() => undefined);
          try {
            await job.creationCleanup;
          } catch (cleanupError) {
            job.creationCleanupFailure = cleanupError;
            throw cleanupError;
          }
        }
        throw error;
      }
      job.activeSessionId = session.id;
      const root = new URL(options.url);
      const queue: Array<{ url: string; depth: number }> = [{ url: options.url, depth: 0 }];
      const queued = new Set<string>([options.url]);
      const seen = new Set<string>();
      const robotsByOrigin = new Map<string, Promise<RobotsPolicy | undefined>>();
      while (queue.length && seen.size < options.maxPages && !job.cancelled) {
        const next = queue.shift()!;
        queued.delete(next.url);
        job.queued = queue.length;
        if (seen.has(next.url)) continue;
        seen.add(next.url);
        const nextUrl = new URL(next.url);
        const robots = options.respectRobots ? await this.robotsFor(job, session, nextUrl, robotsByOrigin) : undefined;
        if (job.cancelled) break;
        if (robots && !robots.isAllowed(next.url, 'Project-Tendril/1.0')) {
          const publicUrl = publicCrawlUrl(next.url);
          job.results.push({ requestedUrl: publicUrl, finalUrl: publicUrl, url: publicUrl, status: null, links: [], error: 'Blocked by robots.txt' });
          job.visited = seen.size;
          continue;
        }
        const requestedUrl = publicCrawlUrl(next.url);
        const result: CrawlResult = { requestedUrl, finalUrl: requestedUrl, url: requestedUrl, status: null, links: [] };
        try {
          const navigation = await this.awaitJob(
            job,
            session.navigate({
              url: next.url,
              waitUntil: 'domcontentloaded',
              signal: job.controller.signal,
            }),
          );
          result.status = navigation.status;
          const finalUrl = canonical(navigation.url ?? next.url);
          if (!finalUrl) throw new TendrilError('NETWORK_BLOCKED', 'Navigation redirected to a non-HTTP(S), credentialed, or overlong URL');
          result.url = publicCrawlUrl(finalUrl);
          result.finalUrl = result.url;
          const parsedFinal = new URL(finalUrl);
          if (options.sameOrigin && parsedFinal.origin !== root.origin) {
            result.error = 'Navigation redirected outside the allowed origin';
            job.results.push(result);
            job.visited = seen.size;
            job.queued = queue.length;
            continue;
          }
          const finalRobots = options.respectRobots ? await this.robotsFor(job, session, parsedFinal, robotsByOrigin) : undefined;
          if (finalRobots && !finalRobots.isAllowed(finalUrl, 'Project-Tendril/1.0')) {
            result.error = 'Blocked by robots.txt after redirect';
            job.results.push(result);
            job.visited = seen.size;
            job.queued = queue.length;
            continue;
          }
          const extracted = (await this.awaitJob(job, session.extract({ format: 'all' }))) as {
            title: string;
            markdown: string;
            links: Array<{ url: string }>;
          };
          const remainingTitleBytes = Math.max(0, this.maxJobTitleBytes - job.storedTitleBytes);
          const titleLimit = Math.min(this.maxResultTitleBytes, remainingTitleBytes);
          result.title = truncateUtf8(extracted.title, titleLimit);
          job.storedTitleBytes += Buffer.byteLength(result.title);
          if (Buffer.byteLength(extracted.title) > Buffer.byteLength(result.title)) {
            result.truncated = { ...result.truncated, title: true };
          }
          const remainingJobBytes = Math.max(0, this.maxJobMarkdownBytes - job.storedMarkdownBytes);
          const markdownLimit = Math.min(this.maxResultMarkdownBytes, remainingJobBytes);
          result.markdown = truncateUtf8(extracted.markdown, markdownLimit);
          job.storedMarkdownBytes += Buffer.byteLength(result.markdown);
          if (Buffer.byteLength(extracted.markdown) > Buffer.byteLength(result.markdown)) {
            result.truncated = { ...result.truncated, markdown: true };
          }
          const rawLinks: string[] = [];
          const publicLinks: string[] = [];
          const uniqueLinks = new Set<string>();
          let resultLinkBytes = 0;
          let linksTruncated = false;
          let inspectedLinks = 0;
          for (const extractedLink of extracted.links) {
            inspectedLinks += 1;
            if (inspectedLinks > this.maxResultLinks * 4) {
              linksTruncated = true;
              break;
            }
            if (rawLinks.length >= this.maxResultLinks || job.storedLinkCount >= this.maxJobLinks) {
              linksTruncated = true;
              break;
            }
            const rawLink = canonical(extractedLink.url);
            if (!rawLink || uniqueLinks.has(rawLink)) continue;
            uniqueLinks.add(rawLink);
            const publicLink = publicCrawlUrl(rawLink);
            const linkBytes = Buffer.byteLength(publicLink);
            if (resultLinkBytes + linkBytes > this.maxResultLinkBytes || job.storedLinkBytes + linkBytes > this.maxJobLinkBytes) {
              linksTruncated = true;
              continue;
            }
            rawLinks.push(rawLink);
            publicLinks.push(publicLink);
            resultLinkBytes += linkBytes;
            job.storedLinkBytes += linkBytes;
            job.storedLinkCount += 1;
          }
          result.links = publicLinks;
          if (linksTruncated) result.truncated = { ...result.truncated, links: true };
          if (next.depth < options.maxDepth) {
            for (const link of rawLinks) {
              const parsed = new URL(link);
              if (options.sameOrigin && parsed.origin !== root.origin) continue;
              if (!['http:', 'https:'].includes(parsed.protocol) || seen.has(link) || queued.has(link)) continue;
              if (seen.size + queue.length >= options.maxPages) break;
              queue.push({ url: link, depth: next.depth + 1 });
              queued.add(link);
            }
          }
        } catch (error) {
          if (job.controller.signal.aborted) throw job.abortReason ?? job.controller.signal.reason ?? error;
          result.error = redactErrorMessage(error);
        }
        job.results.push(result);
        job.visited = seen.size;
        job.queued = queue.length;
      }
      terminalStatus = job.cancelled ? 'cancelled' : 'completed';
    } catch (error) {
      if (job.creationCleanupFailure !== undefined) {
        terminalStatus = 'failed';
        terminalError = redactErrorMessage(new Error(`Crawl cleanup failed: ${redactErrorMessage(job.creationCleanupFailure)}`));
      } else if (job.cancelled) terminalStatus = 'cancelled';
      else {
        terminalStatus = 'failed';
        terminalError = redactErrorMessage(error);
        this.logger.error('Crawl failed', { jobId: job.id, error: terminalError });
      }
    } finally {
      if (session) {
        try {
          await this.closeActiveSession(job);
        } catch (error) {
          terminalStatus = 'failed';
          terminalError = redactErrorMessage(new Error(`Crawl cleanup failed: ${redactErrorMessage(error)}`));
        }
      }
      delete job.activeSessionId;
      job.queued = 0;
      job.status = terminalStatus;
      if (terminalError) job.error = terminalError;
      job.completedAt = new Date(this.now()).toISOString();
    }
  }
}
