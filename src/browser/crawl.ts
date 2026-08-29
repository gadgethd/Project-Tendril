import robotsParser from 'robots-parser';
import { TendrilError } from '../errors.js';
import type { CrawlJob, CrawlResult } from '../types.js';
import { newId, type Logger } from '../util.js';
import type { BrowserManager } from './manager.js';

interface InternalJob extends CrawlJob { cancelled: boolean }
interface RobotsPolicy { isAllowed(url: string, userAgent?: string): boolean | undefined }
interface CrawlOptions { url: string; maxPages?: number; maxDepth?: number; sameOrigin?: boolean; respectRobots?: boolean }
const parseRobots = robotsParser as unknown as (url: string, content: string) => RobotsPolicy;

function canonical(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch { return undefined; }
}

export class CrawlService {
  private readonly jobs = new Map<string, InternalJob>();

  constructor(private readonly manager: BrowserManager, private readonly logger: Logger) {}

  start(options: CrawlOptions): CrawlJob {
    return this.startJob(options);
  }

  followUp(parentJobId: string, options: CrawlOptions): CrawlJob {
    if (!this.jobs.has(parentJobId)) throw new TendrilError('CRAWL_FAILED', `Crawl job not found: ${parentJobId}`);
    return this.startJob(options, parentJobId);
  }

  private startJob(options: CrawlOptions, parentJobId?: string): CrawlJob {
    const url = canonical(options.url);
    if (!url) throw new TendrilError('INVALID_URL', `Invalid crawl URL: ${options.url}`);
    const job: InternalJob = {
      id: newId('crawl'), status: 'running', startedAt: new Date().toISOString(), queued: 1,
      visited: 0, results: [], cancelled: false,
      ...(parentJobId ? { parentJobId } : {}),
    };
    this.jobs.set(job.id, job);
    void this.run(job, {
      url,
      maxPages: Math.min(options.maxPages ?? 20, 100),
      maxDepth: Math.min(options.maxDepth ?? 2, 5),
      sameOrigin: options.sameOrigin ?? true,
      respectRobots: options.respectRobots ?? true,
    });
    return this.publicJob(job);
  }

  get(id: string): CrawlJob {
    const job = this.jobs.get(id);
    if (!job) throw new TendrilError('CRAWL_FAILED', `Crawl job not found: ${id}`);
    return this.publicJob(job);
  }

  cancel(id: string): CrawlJob {
    const job = this.jobs.get(id);
    if (!job) throw new TendrilError('CRAWL_FAILED', `Crawl job not found: ${id}`);
    job.cancelled = true;
    return this.publicJob(job);
  }

  private publicJob(job: InternalJob): CrawlJob {
    const { cancelled: _cancelled, ...result } = job;
    return structuredClone(result);
  }

  private async run(job: InternalJob, options: { url: string; maxPages: number; maxDepth: number; sameOrigin: boolean; respectRobots: boolean }): Promise<void> {
    let session;
    try {
      session = await this.manager.create();
      const root = new URL(options.url);
      const queue: Array<{ url: string; depth: number }> = [{ url: options.url, depth: 0 }];
      const seen = new Set<string>();
      let robots: RobotsPolicy | undefined;
      if (options.respectRobots) {
        const robotsUrl = new URL('/robots.txt', root).toString();
        try {
          const { text } = await session.fetchText(robotsUrl);
          robots = parseRobots(robotsUrl, text);
        } catch { /* Missing robots.txt means allow. */ }
      }
      while (queue.length && seen.size < options.maxPages && !job.cancelled) {
        const next = queue.shift()!;
        job.queued = queue.length;
        if (seen.has(next.url)) continue;
        seen.add(next.url);
        if (robots && !robots.isAllowed(next.url, 'Project-Tendril/1.0')) {
          job.results.push({ url: next.url, status: null, links: [], error: 'Blocked by robots.txt' });
          continue;
        }
        const result: CrawlResult = { url: next.url, status: null, links: [] };
        try {
          const navigation = await session.navigate({ url: next.url, waitUntil: 'domcontentloaded' });
          result.status = navigation.status;
          const safeExtraction = await session.extractWithSafety({ format: 'all' });
          const extracted = safeExtraction.data as { title: string; markdown: string; links: Array<{ url: string }> };
          result.title = extracted.title;
          result.markdown = extracted.markdown;
          result.links = [...new Set(extracted.links.map((link) => canonical(link.url)).filter((link): link is string => Boolean(link)))];
          if (safeExtraction.warnings.length) result.warnings = safeExtraction.warnings;
          if (next.depth < options.maxDepth) {
            for (const link of result.links) {
              const parsed = new URL(link);
              if (options.sameOrigin && parsed.origin !== root.origin) continue;
              if (!['http:', 'https:'].includes(parsed.protocol) || seen.has(link)) continue;
              queue.push({ url: link, depth: next.depth + 1 });
            }
          }
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error);
        }
        job.results.push(result);
        job.visited = seen.size;
      }
      job.status = job.cancelled ? 'cancelled' : 'completed';
      job.completedAt = new Date().toISOString();
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = new Date().toISOString();
      this.logger.error('Crawl failed', { jobId: job.id, error: job.error });
    } finally {
      if (session) await this.manager.close(session.id).catch(() => undefined);
    }
  }
}
