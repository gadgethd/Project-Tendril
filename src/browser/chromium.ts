import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { TendrilError } from '../errors.js';
import { ensureDir, type Logger } from '../util.js';

export interface ChromiumProcess {
  browser: Browser;
  context: BrowserContext;
  child: ChildProcess;
  cdpPort: number;
  browserPath: string;
  userDataDir: string;
  close(): Promise<void>;
}

async function firstAccessible(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue searching.
    }
  }
  return undefined;
}

export async function findChromium(explicit?: string): Promise<string> {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  try { candidates.push(chromium.executablePath()); } catch { /* browser not installed */ }
  if (process.platform === 'linux') {
    candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome');
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const root of roots) {
      candidates.push(
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
  }
  const found = await firstAccessible([...new Set(candidates)]);
  if (!found) {
    throw new TendrilError(
      'BROWSER_LAUNCH_FAILED',
      'No Chromium executable found. Run `tendril install-browser` or set TENDRIL_EXECUTABLE_PATH.',
    );
  }
  return found;
}

async function waitForDevTools(userDataDir: string, child: ChildProcess, timeoutMs = 15_000): Promise<{ port: number; browserPath: string }> {
  const activePortPath = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chromium exited with code ${child.exitCode}`);
    try {
      const [portLine, browserPath] = (await readFile(activePortPath, 'utf8')).trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && browserPath) return { port, browserPath };
    } catch {
      // Chromium has not written the endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Chromium did not create ${activePortPath}`);
}

async function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (!graceful && child.exitCode === null) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

export async function launchChromium(options: {
  executablePath?: string;
  userDataDir: string;
  proxyUrl: string;
  headless: boolean;
  viewport?: { width: number; height: number };
  locale?: string;
  logger: Logger;
}): Promise<ChromiumProcess> {
  if (process.getuid?.() === 0 && process.env.TENDRIL_ALLOW_NO_SANDBOX !== 'true') {
    throw new TendrilError('BROWSER_LAUNCH_FAILED', 'Tendril refuses to launch Chromium as root. Run as a non-root user.');
  }
  const executablePath = await findChromium(options.executablePath);
  await ensureDir(options.userDataDir);
  // Chromium's crash handler consults HOME even when crash reporting is disabled.
  // Keep every browser-owned path inside the session/profile so read-only hosts and
  // containers never require a writable system home directory.
  const browserHome = path.join(options.userDataDir, '.tendril-home');
  const browserConfigHome = path.join(browserHome, '.config');
  const browserCacheHome = path.join(browserHome, '.cache');
  await Promise.all([ensureDir(browserHome), ensureDir(browserConfigHome), ensureDir(browserCacheHome)]);
  const args = [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${options.userDataDir}`,
    `--proxy-server=${options.proxyUrl}`,
    '--proxy-bypass-list=<-loopback>',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-quic',
    '--disable-extensions',
    '--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,WebTransport',
    '--disable-sync',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    `--window-size=${options.viewport?.width ?? 1280},${options.viewport?.height ?? 800}`,
    'about:blank',
  ];
  if (options.headless) args.unshift('--headless=new');
  if (process.getuid?.() === 0) args.unshift('--no-sandbox');

  const stderr: string[] = [];
  const child = spawn(executablePath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      HOME: browserHome,
      XDG_CONFIG_HOME: browserConfigHome,
      XDG_CACHE_HOME: browserCacheHome,
    },
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr.push(chunk);
    if (stderr.join('').length > 16_384) stderr.shift();
  });

  try {
    const endpoint = await waitForDevTools(options.userDataDir, child);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chromium did not expose a default browser context');
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(60_000);
    // Some TypeScript-on-the-fly loaders wrap nested browser functions with this harmless helper.
    // Defining it in pages keeps development and packaged builds behaviorally identical.
    await context.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((target) => target);' });
    // CDP may expose the default context before its command-line about:blank page
    // exists (most commonly on Windows). Guarantee the session starts with a page.
    if (context.pages().length === 0) await context.newPage();
    for (const page of context.pages()) {
      await page.evaluate('globalThis.__name = globalThis.__name || ((target) => target);').catch(() => undefined);
    }
    if (options.locale) await context.setExtraHTTPHeaders({ 'Accept-Language': options.locale });
    options.logger.info('Chromium session started', { pid: child.pid, cdpPort: endpoint.port });
    let closing = false;
    return {
      browser,
      context,
      child,
      cdpPort: endpoint.port,
      browserPath: endpoint.browserPath,
      userDataDir: options.userDataDir,
      async close() {
        if (closing) return;
        closing = true;
        try {
          await Promise.race([
            browser.close(),
            new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
          ]);
        } catch { /* process may already be gone */ }
        await terminateProcess(child);
      },
    };
  } catch (error) {
    await terminateProcess(child);
    await rm(options.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw new TendrilError('BROWSER_LAUNCH_FAILED', `Unable to launch Chromium: ${stderr.join('').slice(-4000)}`, { cause: error });
  }
}
