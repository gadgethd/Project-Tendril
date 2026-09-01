import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { TendrilError } from '../errors.js';
import { ensureDir, type Logger } from '../util.js';
import {
  closeChromiumResources,
  type BrowserProcess,
  type ProcessTerminationOptions,
  terminateFailedChromiumLaunch,
  trackPosixProcessGroup,
} from './chromium.js';

function pathCandidates(name: string): string[] {
  const suffixes = process.platform === 'win32' ? ['', '.exe'] : [''];
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => suffixes.map((suffix) => path.join(directory, `${name}${suffix}`)));
}

export async function findObscura(explicit?: string): Promise<string> {
  const candidates = [explicit, process.env.TENDRIL_OBSCURA_PATH, ...pathCandidates('obscura')].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue searching.
    }
  }
  throw new TendrilError('BROWSER_LAUNCH_FAILED', 'No Obscura executable found. Install Obscura and put it on PATH, or set TENDRIL_OBSCURA_PATH.');
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) throw new Error('Unable to reserve a loopback port for Obscura');
  return port;
}

async function waitForDevTools(port: number, child: ChildProcess, spawnError: () => Error | undefined, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const launchError = spawnError();
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Obscura exited with code ${child.exitCode}`);
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 500 }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        request.once('timeout', () => request.destroy(new Error('Timed out waiting for Obscura')));
        request.once('error', reject);
      });
      const endpoint = JSON.parse(body) as { webSocketDebuggerUrl?: string };
      if (endpoint.webSocketDebuggerUrl) return endpoint.webSocketDebuggerUrl;
    } catch {
      // Obscura has not opened its CDP endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Obscura did not open its CDP endpoint on 127.0.0.1:${port}`);
}

export async function launchObscura(options: {
  executablePath?: string;
  userDataDir: string;
  proxyUrl: string;
  headless: boolean;
  stealth: boolean;
  viewport?: { width: number; height: number };
  locale?: string;
  logger: Logger;
}): Promise<BrowserProcess> {
  if (!options.headless) {
    throw new TendrilError('UNSUPPORTED_OPERATION', 'Obscura is headless-only. Use the Chromium backend for headed human handoff.');
  }
  const executablePath = await findObscura(options.executablePath);
  await ensureDir(options.userDataDir);
  const cdpPort = await reserveLoopbackPort();
  const args = [
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(cdpPort),
    '--proxy',
    options.proxyUrl,
    '--storage-dir',
    options.userDataDir,
    '--max-connections',
    '16',
    '--allow-private-network',
    '--allow-file-access',
    '--quiet',
  ];
  if (options.stealth) args.push('--stealth');

  const stderr: string[] = [];
  const child = spawn(executablePath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const posixExitCleanup = process.platform === 'win32' ? undefined : trackPosixProcessGroup(child);
  const terminationOptions: ProcessTerminationOptions = posixExitCleanup ? { posixExitCleanup } : {};
  let childError: Error | undefined;
  child.once('error', (error) => {
    childError = error;
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr.push(chunk);
    if (stderr.join('').length > 16_384) stderr.shift();
  });

  try {
    const websocketUrl = await waitForDevTools(cdpPort, child, () => childError);
    const browser = await chromium.connectOverCDP(websocketUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(60_000);
    if (options.locale) await context.setExtraHTTPHeaders({ 'Accept-Language': options.locale });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize(options.viewport ?? { width: 1280, height: 800 });
    options.logger.info('Obscura session started', { pid: child.pid, cdpPort, stealth: options.stealth });
    let closePromise: Promise<void> | undefined;
    return {
      backend: 'obscura',
      browser,
      context,
      child,
      cdpPort,
      browserPath: '/devtools/browser',
      executablePath,
      userDataDir: options.userDataDir,
      async close() {
        closePromise ??= closeChromiumResources(browser, child, terminationOptions);
        return closePromise;
      },
    };
  } catch (error) {
    try {
      await terminateFailedChromiumLaunch(child, terminationOptions);
    } catch (terminationError) {
      throw new TendrilError('BROWSER_LAUNCH_FAILED', `Unable to launch Obscura: ${stderr.join('').slice(-4000)}`, {
        cause: new AggregateError([error, terminationError], 'Obscura launch failed and process termination was not verified'),
        details: { browserTerminationVerified: false },
      });
    }
    throw new TendrilError('BROWSER_LAUNCH_FAILED', `Unable to launch Obscura: ${stderr.join('').slice(-4000)}`, { cause: error });
  }
}
