import { BrowserManager } from './browser/manager.js';
import { SearchService } from './browser/search.js';
import { CrawlService } from './browser/crawl.js';
import type { TendrilConfig } from './types.js';
import { Logger } from './util.js';

export interface TendrilRuntime {
  manager: BrowserManager;
  search: SearchService;
  crawl: CrawlService;
  logger: Logger;
  close(): Promise<void>;
}

export async function createRuntime(config: TendrilConfig): Promise<TendrilRuntime> {
  const logger = new Logger(config.logLevel);
  const manager = new BrowserManager(config, logger);
  await manager.start();
  const search = new SearchService(manager, logger);
  const crawl = new CrawlService(manager, logger);
  let closePromise: Promise<void> | undefined;
  return {
    manager,
    search,
    crawl,
    logger,
    close() {
      if (!closePromise) {
        closePromise = (async () => {
          try {
            await crawl.close();
          } finally {
            await manager.closeAll();
          }
        })();
      }
      return closePromise;
    },
  };
}
