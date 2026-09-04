import type { TendrilConfig } from '../types.js';
import type { Logger } from '../util.js';
import { launchChromium, type BrowserProcess } from './chromium.js';
import { launchObscura } from './obscura.js';

export async function launchBrowser(options: {
  config: TendrilConfig;
  userDataDir: string;
  proxyUrl: string;
  headless: boolean;
  viewport?: { width: number; height: number };
  locale?: string;
  logger: Logger;
}): Promise<BrowserProcess> {
  if (options.config.browserBackend === 'obscura' && options.headless) {
    return launchObscura({
      executablePath: options.config.obscuraExecutablePath,
      userDataDir: options.userDataDir,
      proxyUrl: options.proxyUrl,
      headless: options.headless,
      stealth: options.config.obscuraStealth,
      viewport: options.viewport,
      locale: options.locale,
      logger: options.logger,
    });
  }
  return launchChromium({
    executablePath: options.config.executablePath,
    userDataDir: options.userDataDir,
    proxyUrl: options.proxyUrl,
    headless: options.headless,
    viewport: options.viewport,
    locale: options.locale,
    logger: options.logger,
  });
}

export type { BrowserBackend } from '../types.js';
export type { BrowserProcess } from './chromium.js';
