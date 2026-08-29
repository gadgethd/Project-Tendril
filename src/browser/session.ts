import { copyFile, lstat, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { BrowserContext, Dialog, Download, Frame, Page, Request, Response } from 'playwright';
import { TendrilError } from '../errors.js';
import { EgressProxy } from '../security/egress-proxy.js';
import { NetworkPolicy } from '../security/network-policy.js';
import type {
  ActivityEntry, BrowserCaptureOptions, BrowserCaptureResult, ChallengeInfo, ConsoleEntry, ElementRef,
  NetworkEntry, PageId, PageSummary, SessionCreateOptions, SessionExport, SessionHealth, SessionId,
  SessionInfo, SnapshotResult, TendrilConfig,
} from '../types.js';
import {
  assertPathWithinOwnedRoot, assertPathWithinRoots, newId, pathWithinOwnedRoot, withTimeout, type Logger,
} from '../util.js';
import { launchChromium, type ChromiumProcess } from './chromium.js';
import { extractForms, extractPage, extractTables } from './extract.js';
import { createSnapshot, type ElementTarget } from './snapshot.js';

interface SessionCreateDependencies {
  launch?: typeof launchChromium;
  proxy?: EgressProxy;
}

interface DownloadEntry {
  id: string;
  suggestedFilename: string;
  url: string;
  path?: string;
  failure?: string;
}

interface DialogEntry {
  type: string;
  message: string;
  defaultValue: string;
  dialog: Dialog;
}

type AddCookie = Parameters<BrowserContext['addCookies']>[0][number];

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new TendrilError('CANCELLED', 'Operation cancelled', { retryable: true });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function boundedTimeout(configuredMs: number, deadlineMs?: number): number {
  if (deadlineMs === undefined) return configuredMs;
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new TendrilError('TIMEOUT', 'Operation deadline exceeded', { retryable: true });
  return Math.max(1, Math.min(configuredMs, remaining));
}

export type BrowserAction =
  | 'click' | 'double_click' | 'hover' | 'focus' | 'fill' | 'type' | 'select'
  | 'check' | 'uncheck' | 'press' | 'scroll' | 'drag' | 'upload';

export class TendrilSession {
  readonly id: SessionId;
  readonly createdAt = new Date();
  lastActivityAt = new Date();
  readonly ephemeral: boolean;
  readonly headless: boolean;
  readonly profile: string | undefined;
  readonly createOptions: SessionCreateOptions;
  readonly userDataDir: string;
  readonly proxy: EgressProxy;
  readonly chromium: ChromiumProcess;
  readonly consoleEntries: ConsoleEntry[] = [];
  readonly networkEntries: NetworkEntry[] = [];
  readonly downloads: DownloadEntry[] = [];
  private readonly activityLog: ActivityEntry[] = [];
  private readonly pages = new Map<Page, PageId>();
  private readonly pagesById = new Map<PageId, Page>();
  private readonly lastSnapshotByPage = new Map<PageId, string>();
  private readonly pendingDownloads = new Map<string, Promise<void>>();
  private readonly requestIds = new WeakMap<Request, string>();
  private readonly responses = new Map<string, Response>();
  private readonly refs = new Map<ElementRef, ElementTarget>();
  private readonly snapshotContents = new Map<string, string>();
  private selectedPageId?: PageId;
  private activeDialog?: DialogEntry;
  private closePromise?: Promise<void>;

  private constructor(
    id: string,
    profile: string | undefined,
    createOptions: SessionCreateOptions,
    userDataDir: string,
    proxy: EgressProxy,
    private readonly networkPolicy: NetworkPolicy,
    chromiumProcess: ChromiumProcess,
    headless: boolean,
    private readonly config: TendrilConfig,
    private readonly logger: Logger,
  ) {
    this.id = id;
    this.profile = profile;
    this.createOptions = structuredClone(createOptions);
    this.ephemeral = profile === undefined;
    this.headless = headless;
    const ownedSessionRoot = profile
      ? pathWithinOwnedRoot(config.dataDir, 'profiles')
      : pathWithinOwnedRoot(config.runtimeDir, 'sessions');
    this.userDataDir = assertPathWithinOwnedRoot(userDataDir, ownedSessionRoot, 'Browser session directory');
    this.proxy = proxy;
    this.chromium = chromiumProcess;
    for (const page of chromiumProcess.context.pages()) this.attachPage(page);
    chromiumProcess.context.on('page', (page) => this.attachPage(page));
  }

  static async create(options: {
    id?: string;
    profile?: string;
    userDataDir: string;
    createOptions: SessionCreateOptions;
    config: TendrilConfig;
    logger: Logger;
  }, dependencies: SessionCreateDependencies = {}): Promise<TendrilSession> {
    const policy = new NetworkPolicy({
      blockPrivateNetworks: options.createOptions.allowPrivateNetwork ? false : options.config.blockPrivateNetworks,
      allowedHosts: [...options.config.allowedHosts, ...(options.createOptions.allowedHosts ?? [])],
      blockedHosts: options.config.blockedHosts,
    });
    const proxy = dependencies.proxy ?? new EgressProxy(policy, options.logger);
    let chromiumProcess: ChromiumProcess | undefined;
    try {
      await proxy.start();
      chromiumProcess = await (dependencies.launch ?? launchChromium)({
        executablePath: options.config.executablePath,
        userDataDir: options.userDataDir,
        proxyUrl: proxy.url(),
        headless: options.createOptions.headless ?? options.config.headless,
        viewport: options.createOptions.viewport,
        locale: options.createOptions.locale,
        logger: options.logger,
      });
      chromiumProcess.context.setDefaultTimeout(options.config.actionTimeoutMs);
      chromiumProcess.context.setDefaultNavigationTimeout(options.config.navigationTimeoutMs);
      if (options.createOptions.timezoneId) {
        options.logger.warn('Timezone can only be set before Chromium launch and is not currently applied', { timezoneId: options.createOptions.timezoneId });
      }
      return new TendrilSession(
        options.id ?? newId('ses'), options.profile, options.createOptions, options.userDataDir, proxy,
        policy, chromiumProcess, options.createOptions.headless ?? options.config.headless, options.config, options.logger,
      );
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      let browserTerminationVerified = !(error instanceof TendrilError
        && error.details?.browserTerminationVerified === false);
      if (chromiumProcess) {
        try {
          await chromiumProcess.close();
        } catch (cleanupError) {
          browserTerminationVerified = false;
          cleanupFailures.push(cleanupError);
        }
      }
      try {
        await proxy.stop();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      if (cleanupFailures.length) {
        throw new TendrilError('BROWSER_LAUNCH_FAILED', browserTerminationVerified
          ? 'Browser session setup failed and resource cleanup was incomplete'
          : 'Browser session setup failed and Chromium termination could not be verified', {
          cause: new AggregateError([error, ...cleanupFailures], 'Browser session setup and cleanup failed'),
          details: { browserTerminationVerified, resourceCleanupVerified: false },
        });
      }
      throw error;
    }
  }

  private touch(): void { this.lastActivityAt = new Date(); }

  private recordActivity(type: ActivityEntry['type'], detail: string, url?: string): void {
    const timestamp = new Date();
    this.lastActivityAt = timestamp;
    this.pushBounded(this.activityLog, { type, timestamp: timestamp.toISOString(), detail, url }, 500);
  }

  private attachPage(page: Page): void {
    if (this.pages.has(page)) return;
    const pageId = newId('page');
    this.pages.set(page, pageId);
    this.pagesById.set(pageId, page);
    this.selectedPageId = pageId;
    page.on('close', () => {
      this.pages.delete(page);
      this.pagesById.delete(pageId);
      this.lastSnapshotByPage.delete(pageId);
      if (this.selectedPageId === pageId) this.selectedPageId = this.pagesById.keys().next().value as string | undefined;
    });
    page.on('console', (message) => {
      const location = message.location();
      this.pushBounded(this.consoleEntries, {
        type: message.type(), text: message.text(), timestamp: new Date().toISOString(),
        location: { url: location.url, lineNumber: location.lineNumber, columnNumber: location.columnNumber },
      });
    });
    page.on('pageerror', (error) => this.pushBounded(this.consoleEntries, {
      type: 'pageerror', text: error.message, timestamp: new Date().toISOString(),
    }));
    page.on('request', (request) => this.onRequest(request));
    page.on('response', (response) => this.onResponse(response));
    page.on('requestfailed', (request) => this.onRequestFailed(request));
    page.on('download', (download) => void this.onDownload(download));
    page.on('dialog', (dialog) => {
      this.activeDialog = { type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue(), dialog };
    });
  }

  private pushBounded<T>(array: T[], value: T, max = 1000): void {
    array.push(value);
    if (array.length > max) array.splice(0, array.length - max);
  }

  private onRequest(request: Request): void {
    const id = newId('req');
    this.requestIds.set(request, id);
    this.pushBounded(this.networkEntries, {
      id, method: request.method(), url: request.url(), resourceType: request.resourceType(), startedAt: new Date().toISOString(),
    });
  }

  private onResponse(response: Response): void {
    const id = this.requestIds.get(response.request());
    if (!id) return;
    const entry = this.networkEntries.find((item) => item.id === id);
    if (entry) {
      entry.status = response.status();
      entry.statusText = response.statusText();
      entry.contentType = response.headers()['content-type'];
    }
    this.responses.set(id, response);
    while (this.responses.size > 200) this.responses.delete(this.responses.keys().next().value as string);
  }

  private onRequestFailed(request: Request): void {
    const id = this.requestIds.get(request);
    const entry = id ? this.networkEntries.find((item) => item.id === id) : undefined;
    if (entry) entry.failed = request.failure()?.errorText ?? 'Request failed';
  }

  private async onDownload(download: Download): Promise<void> {
    const entry: DownloadEntry = { id: newId('download'), suggestedFilename: download.suggestedFilename(), url: download.url() };
    this.pushBounded(this.downloads, entry, 100);
    const completion = (async () => {
      try {
        const downloadPath = await download.path();
        if (downloadPath) entry.path = downloadPath;
        const failure = await download.failure();
        if (failure) entry.failure = failure;
      } catch (error) {
        entry.failure = error instanceof Error ? error.message : String(error);
      }
    })();
    this.pendingDownloads.set(entry.id, completion);
    try { await completion; }
    finally { this.pendingDownloads.delete(entry.id); }
  }

  private currentPage(pageId?: string): Page {
    this.touch();
    const id = pageId ?? this.selectedPageId;
    if (!id) throw new TendrilError('PAGE_NOT_FOUND', 'Session has no open pages');
    const page = this.pagesById.get(id);
    if (!page) throw new TendrilError('PAGE_NOT_FOUND', `Page not found: ${id}`);
    return page;
  }

  private pageId(page: Page): string {
    const id = this.pages.get(page);
    if (!id) throw new TendrilError('PAGE_NOT_FOUND', 'Page is not registered with this session');
    return id;
  }

  async info(cdpPublicUrl?: string): Promise<SessionInfo> {
    const info: SessionInfo = {
      id: this.id,
      ephemeral: this.ephemeral,
      headless: this.headless,
      createdAt: this.createdAt.toISOString(),
      lastActivityAt: this.lastActivityAt.toISOString(),
      pages: await this.listPages(),
      processId: this.chromium.child.pid,
    };
    if (this.profile) info.profile = this.profile;
    if (cdpPublicUrl) info.cdpUrl = cdpPublicUrl;
    return info;
  }

  async listPages(): Promise<PageSummary[]> {
    return Promise.all([...this.pagesById.entries()].map(async ([id, page]) => ({
      id, url: page.url(), title: await page.title().catch(() => ''), selected: id === this.selectedPageId,
    })));
  }

  async listPagesWithContext(): Promise<Array<PageSummary & { lastSnapshot?: string }>> {
    const pages = await this.listPages();
    return pages.map((page) => {
      const lastSnapshot = this.lastSnapshotByPage.get(page.id);
      return lastSnapshot === undefined ? page : { ...page, lastSnapshot: lastSnapshot.slice(0, 500) };
    });
  }

  async openPage(url = 'about:blank'): Promise<PageSummary> {
    const page = await this.chromium.context.newPage();
    const id = this.pageId(page);
    this.selectedPageId = id;
    if (url !== 'about:blank') await this.navigate({ pageId: id, url });
    return (await this.listPages()).find((item) => item.id === id)!;
  }

  async selectPage(pageId: string): Promise<PageSummary> {
    const page = this.currentPage(pageId);
    this.selectedPageId = pageId;
    await page.bringToFront();
    return (await this.listPages()).find((item) => item.id === pageId)!;
  }

  async closePage(pageId: string): Promise<void> {
    const page = this.currentPage(pageId);
    await page.close({ runBeforeUnload: false });
  }

  async navigate(options: { pageId?: string; url?: string; action?: 'goto' | 'back' | 'forward' | 'reload'; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; signal?: AbortSignal }): Promise<{ url: string; title: string; status: number | null }> {
    if (options.signal?.aborted) throw Object.assign(new Error('Navigation was cancelled'), { name: 'AbortError' });
    const page = this.currentPage(options.pageId);
    const action = options.action ?? 'goto';
    let response: Response | null = null;
    if (action === 'goto') {
      if (!options.url) throw new TendrilError('INVALID_URL', 'url is required for goto');
      let parsed: URL;
      try { parsed = new URL(options.url); }
      catch (error) { throw new TendrilError('INVALID_URL', `Invalid URL: ${options.url}`, { cause: error }); }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new TendrilError('NETWORK_BLOCKED', `Navigation protocol ${parsed.protocol} is not allowed`);
      }
      await this.networkPolicy.resolve(parsed.toString(), options.signal);
      const gotoOptions = { waitUntil: options.waitUntil ?? 'domcontentloaded' } as const;
      try {
        response = await page.goto(options.url, gotoOptions);
      } catch (error) {
        const transientAbort = error instanceof Error && error.message.includes('net::ERR_ABORTED');
        if (!transientAbort) throw error;
        await page.waitForTimeout(100);
        response = await page.goto(options.url, gotoOptions);
      }
    } else if (action === 'back') response = await page.goBack({ waitUntil: options.waitUntil ?? 'domcontentloaded' });
    else if (action === 'forward') response = await page.goForward({ waitUntil: options.waitUntil ?? 'domcontentloaded' });
    else response = await page.reload({ waitUntil: options.waitUntil ?? 'domcontentloaded' });
    this.refs.clear();
    const contentType = response?.headers()['content-type']?.split(';', 1)[0]?.trim();
    const result: { url: string; title: string; status: number | null; mimeType?: string } = {
      url: page.url(), title: await page.title(), status: response?.status() ?? null,
    };
    if (contentType) result.mimeType = contentType;
    const detail = action === 'goto' ? `goto ${options.url}` : action;
    this.recordActivity('navigate', detail, result.url);
    return result;
  }

  async setContent(html: string, pageId?: string): Promise<{ url: string; title: string }> {
    const page = this.currentPage(pageId);
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    this.refs.clear();
    return { url: page.url(), title: await page.title() };
  }

  async fetchText(url: string, pageId?: string, signal?: AbortSignal): Promise<{ status: number | null; text: string }> {
    this.currentPage(pageId);
    throwIfAborted(options.signal);
    let target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new TendrilError('NETWORK_BLOCKED', `Protocol ${target.protocol} is not allowed`);
    const proxy = new URL(this.proxy.url());
    const requestedMaxBytes = options.maxBytes ?? this.config.maxResponseBodyBytes;
    if (!Number.isFinite(requestedMaxBytes) || requestedMaxBytes <= 0) {
      throw new TendrilError('CONFIGURATION_ERROR', 'fetchText maxBytes must be a positive finite number');
    }
    const maxBytes = Math.max(1, Math.floor(Math.min(requestedMaxBytes, this.config.maxResponseBodyBytes)));
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (signal?.aborted) throw Object.assign(new Error('Fetch was cancelled'), { name: 'AbortError' });
      await this.networkPolicy.resolve(target.toString(), signal);
      const result = await new Promise<{ status: number; text: string; location?: string }>((resolve, reject) => {
        let settled = false;
        const request = http.request({
          hostname: proxy.hostname,
          port: proxy.port,
          method: 'GET',
          path: target.toString(),
          headers: {
            accept: options.accept ?? 'text/plain,*/*;q=0.1',
            'accept-encoding': 'identity',
            connection: 'close',
            host: target.host,
            'user-agent': 'Project-Tendril/1.0',
          },
        }, (response) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location;
          const headers = Object.fromEntries(Object.entries(response.headers)
            .flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : String(value)]]));
          if (location && [301, 302, 303, 307, 308].includes(status)) {
            settled = true;
            response.resume();
            resolve({ status, text: '', headers, location });
            return;
          }
          const rawLength = response.headers['content-length'];
          const contentLength = Number(Array.isArray(rawLength) ? rawLength[0] : rawLength);
          if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            settled = true;
            response.destroy();
            reject(new TendrilError('OUTPUT_LIMIT', 'Fetched text exceeds configured response limit'));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.byteLength;
            if (bytes > maxBytes) {
              settled = true;
              response.destroy();
              reject(new TendrilError('OUTPUT_LIMIT', 'Fetched text exceeds configured response limit'));
              return;
            }
            chunks.push(chunk);
          });
          response.once('end', () => {
            if (settled) return;
            settled = true;
            resolve({ status, text: Buffer.concat(chunks).toString('utf8'), headers });
          });
          response.once('error', (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
        });
        const onAbort = (): void => { request.destroy(abortError(options.signal!)); };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        request.setTimeout(timeoutMs, () => {
          request.destroy(new TendrilError('TIMEOUT', `Timed out fetching ${target.toString()}`, { retryable: true }));
        });
        request.once('error', (error) => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener('abort', onAbort);
          reject(error);
        });
        const onAbort = (): void => { request.destroy(Object.assign(new Error('Fetch was cancelled'), { name: 'AbortError' })); };
        signal?.addEventListener('abort', onAbort, { once: true });
        request.once('close', () => signal?.removeEventListener('abort', onAbort));
        request.end();
      });
      if (result.location) {
        target = new URL(result.location, target);
        if (!['http:', 'https:'].includes(target.protocol)) throw new TendrilError('NETWORK_BLOCKED', `Protocol ${target.protocol} is not allowed`);
        continue;
      }
      this.refs.clear();
      return { status: result.status, text: result.text, headers: result.headers };
    }
    throw new TendrilError('TIMEOUT', `Too many redirects fetching ${url}`, { retryable: true });
  }

  async snapshot(options: { pageId?: string; mode?: SnapshotResult['mode']; maxChars?: number; cursor?: string; compact?: boolean; maxDepth?: number; previousSnapshotId?: string } = {}): Promise<SnapshotResult> {
    if (options.cursor) {
      const result = this.continueSnapshot(options.cursor, options.maxChars);
      this.recordActivity('snapshot', 'continued snapshot', result.url);
      return result;
    }
    const page = this.currentPage(options.pageId);
    const pageId = this.pageId(page);
    const mode = options.mode ?? 'interactive';
    if (mode === 'reader') {
      const extracted = await extractPage(page);
      const full = `# ${extracted.title}\n\n${extracted.markdown}`;
      const maxChars = Math.min(options.maxChars ?? this.config.maxSnapshotChars, 100_000);
      const snapshotId = newId('snap');
      this.snapshotContents.set(snapshotId, full);
      this.lastSnapshotByPage.set(pageId, full);
      const result: SnapshotResult = {
        snapshotId, pageId, url: page.url(), title: extracted.title, mode,
        content: full.slice(0, maxChars), truncated: full.length > maxChars,
        untrustedContent: true, warnings: [],
      };
      if (result.truncated) result.cursor = Buffer.from(JSON.stringify({ snapshotId, offset: maxChars })).toString('base64url');
      this.recordActivity('snapshot', `${mode} snapshot`, result.url);
      return result;
    }
    const previousContent = options.previousSnapshotId
      ? this.snapshotContents.get(options.previousSnapshotId)
      : [...this.snapshotContents.values()].at(-1);
    const maxChars = Math.min(options.maxChars ?? this.config.maxSnapshotChars, 100_000);
    const created = await createSnapshot({
      page, pageId, mode, maxChars: 5_000_000, previousContent,
      compact: options.compact, maxDepth: options.maxDepth,
    });
    const full = created.result.content;
    this.snapshotContents.set(created.result.snapshotId, full);
    this.lastSnapshotByPage.set(pageId, full);
    while (this.snapshotContents.size > 20) this.snapshotContents.delete(this.snapshotContents.keys().next().value as string);
    this.refs.clear();
    for (const [ref, target] of created.refs) this.refs.set(ref, target);
    if (full.length > maxChars) {
      created.result.content = full.slice(0, maxChars);
      created.result.nodes = undefined;
      created.result.truncated = true;
      created.result.cursor = Buffer.from(JSON.stringify({ snapshotId: created.result.snapshotId, offset: maxChars })).toString('base64url');
    }
    this.recordActivity('snapshot', `${mode} snapshot`, created.result.url);
    return created.result;
  }

  private continueSnapshot(cursor: string, requestedMax?: number): SnapshotResult {
    let parsed: { snapshotId: string; offset: number };
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof parsed; }
    catch { throw new TendrilError('INVALID_URL', 'Invalid snapshot cursor'); }
    const content = this.snapshotContents.get(parsed.snapshotId);
    if (content === undefined) throw new TendrilError('STALE_ELEMENT_REF', 'Snapshot cursor has expired; take a new snapshot');
    const maxChars = Math.min(requestedMax ?? this.config.maxSnapshotChars, 100_000);
    const nextOffset = parsed.offset + maxChars;
    const result: SnapshotResult = {
      snapshotId: parsed.snapshotId, pageId: this.selectedPageId ?? '', url: this.currentPage().url(),
      title: '', mode: 'full', content: content.slice(parsed.offset, nextOffset),
      truncated: nextOffset < content.length, untrustedContent: true, warnings: [],
    };
    if (result.truncated) result.cursor = Buffer.from(JSON.stringify({ snapshotId: parsed.snapshotId, offset: nextOffset })).toString('base64url');
    return result;
  }

  private resolveTarget(ref: string): { page: Page; frame: Frame; target: ElementTarget } {
    const target = this.refs.get(ref);
    if (!target) throw new TendrilError('STALE_ELEMENT_REF', `Unknown or stale element reference ${ref}; take a new snapshot`);
    const page = this.pagesById.get(target.pageId);
    if (!page || page.url() !== target.pageUrl) throw new TendrilError('STALE_ELEMENT_REF', `Element reference ${ref} is stale after navigation; take a new snapshot`);
    const frame = page.frames()[target.frameIndex];
    if (!frame || frame.url() !== target.frameUrl) throw new TendrilError('STALE_ELEMENT_REF', `Frame for ${ref} changed; take a new snapshot`);
    return { page, frame, target };
  }

  async act(options: { action: BrowserAction; ref?: string; targetRef?: string; text?: string; value?: string; values?: string[]; key?: string; deltaX?: number; deltaY?: number; files?: string[]; submit?: boolean }): Promise<{ url: string; snapshot?: SnapshotResult }> {
    this.touch();
    if (options.action === 'press' && !options.ref) {
      const page = this.currentPage();
      await page.keyboard.press(options.key ?? 'Enter');
      const result = { url: page.url() };
      this.recordActivity('act', `${options.action} ${options.key ?? 'Enter'}`, result.url);
      return result;
    }
    if (!options.ref) throw new TendrilError('STALE_ELEMENT_REF', 'ref is required for this action');
    const { page, frame, target } = this.resolveTarget(options.ref);
    const locator = frame.locator(target.selector).first();
    if (await locator.count() === 0) throw new TendrilError('STALE_ELEMENT_REF', `Element ${options.ref} no longer exists; take a new snapshot`);
    switch (options.action) {
      case 'click': await locator.click(); break;
      case 'double_click': await locator.dblclick(); break;
      case 'hover': await locator.hover(); break;
      case 'focus': await locator.focus(); break;
      case 'fill': await locator.fill(options.text ?? ''); break;
      case 'type':
        await locator.fill('');
        await locator.pressSequentially(options.text ?? '');
        break;
      case 'select':
        if (options.value !== undefined) await locator.selectOption({ label: options.value });
        else await locator.selectOption(options.values ?? []);
        break;
      case 'check': await locator.check(); break;
      case 'uncheck': await locator.uncheck(); break;
      case 'press': await locator.press(options.key ?? 'Enter'); break;
      case 'scroll': await locator.evaluate((element, delta) => element.scrollBy(delta.x, delta.y), { x: options.deltaX ?? 0, y: options.deltaY ?? 600 }); break;
      case 'drag': {
        if (!options.targetRef) throw new TendrilError('STALE_ELEMENT_REF', 'targetRef is required for drag');
        const destination = this.resolveTarget(options.targetRef);
        await locator.dragTo(destination.frame.locator(destination.target.selector).first());
        break;
      }
      case 'upload': {
        const files = await Promise.all((options.files ?? []).map((file) => assertPathWithinRoots(file, this.config.workspaceRoots)));
        await locator.setInputFiles(files);
        break;
      }
    }
    if (options.submit && ['fill', 'type'].includes(options.action)) await locator.press('Enter');
    this.refs.clear();
    const result = { url: page.url() };
    this.recordActivity('act', `${options.action}${options.ref ? ` ${options.ref}` : ''}`, result.url);
    return result;
  }

  async wait(options: { pageId?: string; text?: string; selector?: string; url?: string; state?: 'load' | 'domcontentloaded' | 'networkidle'; timeoutMs?: number; delayMs?: number }): Promise<{ url: string }> {
    const page = this.currentPage(options.pageId);
    const timeout = Math.min(options.timeoutMs ?? this.config.actionTimeoutMs, 120_000);
    if (options.delayMs !== undefined) await page.waitForTimeout(Math.min(options.delayMs, 10_000));
    else if (options.text) await page.getByText(options.text, { exact: false }).first().waitFor({ timeout });
    else if (options.selector) await page.locator(options.selector).first().waitFor({ timeout });
    else if (options.url) await page.waitForURL(options.url, { timeout });
    else if (options.state) await page.waitForLoadState(options.state, { timeout });
    else throw new TendrilError('UNSUPPORTED_OPERATION', 'Specify text, selector, url, state, or delayMs');
    return { url: page.url() };
  }

  async extract(options: { pageId?: string; format?: 'all' | 'html' | 'markdown' | 'text' | 'links' | 'metadata' | 'forms' | 'tables'; selector?: string }): Promise<unknown> {
    const page = this.currentPage(options.pageId);
    let result: unknown;
    if (options.selector) {
      result = await page.locator(options.selector).evaluateAll((nodes) => nodes.map((node) => ({
        text: node.textContent?.replace(/\s+/g, ' ').trim(),
        html: node.outerHTML,
        attributes: Object.fromEntries([...node.attributes].map((attribute) => [attribute.name, attribute.value])),
      })));
    } else {
      const format = options.format ?? 'all';
      if (format === 'forms') result = await extractForms(page);
      else if (format === 'tables') result = await extractTables(page);
      else {
        const extracted = await extractPage(page);
        result = format === 'all' ? extracted : extracted[format];
      }
    }
    this.recordActivity('extract', options.selector ? `selector ${options.selector}` : (options.format ?? 'all'), page.url());
    return result;
  }

  async capture(options: BrowserCaptureOptions): Promise<BrowserCaptureResult> {
    const page = this.currentPage(options.pageId);
    const type = options.format ?? 'png';
    let buffer: Buffer;
    if (type === 'pdf') {
      buffer = await page.pdf({ printBackground: true });
    } else {
      const target = options.ref ? this.resolveTarget(options.ref) : undefined;
      buffer = target
        ? await target.frame.locator(target.target.selector).first().screenshot({ type, quality: type === 'jpeg' ? options.quality ?? 80 : undefined })
        : await page.screenshot({ type, fullPage: options.fullPage ?? false, quality: type === 'jpeg' ? options.quality ?? 80 : undefined });
    }
    const result: BrowserCaptureResult = {
      mimeType: type === 'pdf' ? 'application/pdf' : `image/${type}`,
      data: buffer.toString('base64'),
    };
    if (options.savePath) {
      const resolved = await assertPathWithinRoots(options.savePath, this.config.workspaceRoots);
      result.savePath = resolved;
      await writeFile(resolved, buffer);
    }
    this.recordActivity('capture', `${type}${options.savePath ? ` saved to ${options.savePath}` : ''}`, page.url());
    return result;
  }

  async evaluate(expression: string, pageId?: string): Promise<unknown> {
    const page = this.currentPage(pageId);
    const result = await page.evaluate((source) => {
      // This is intentionally page-scoped and cannot access the Tendril Node process.
      return (0, eval)(source) as unknown;
    }, expression);
    this.recordActivity('evaluate', expression.slice(0, 200), page.url());
    return result;
  }

  getActivityLog(): ActivityEntry[] { return this.activityLog.map((entry) => ({ ...entry })); }

  async health(): Promise<SessionHealth> {
    const pid = this.chromium.child.pid;
    let alive = false;
    if (pid !== undefined) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = error instanceof Error && 'code' in error && error.code === 'EPERM';
      }
    }

    let memoryBytes: number | undefined;
    if (alive && pid !== undefined) {
      try {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        const vmRssKb = status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1];
        if (vmRssKb !== undefined) memoryBytes = Number(vmRssKb) * 1024;
      } catch {
        // /proc is Linux-specific; process liveness is still useful elsewhere.
      }
    }

    const health: SessionHealth = {
      alive,
      lastActivityAt: this.lastActivityAt.toISOString(),
      uptimeMs: Math.max(0, Date.now() - this.createdAt.getTime()),
      pageCount: this.pagesById.size,
    };
    if (pid !== undefined) health.pid = pid;
    if (memoryBytes !== undefined) health.memoryBytes = memoryBytes;
    return health;
  }

  async exportCookies(): Promise<AddCookie[]> {
    this.touch();
    return this.chromium.context.cookies();
  }

  async importCookies(cookies: AddCookie[]): Promise<void> {
    this.touch();
    await this.chromium.context.addCookies(cookies);
  }

  async exportSession(): Promise<SessionExport> {
    const page = this.currentPage();
    const localStorage = await page.evaluate(() => Object.fromEntries(
      Array.from({ length: window.localStorage.length }, (_, index) => {
        const key = window.localStorage.key(index)!;
        return [key, window.localStorage.getItem(key) ?? ''];
      }),
    )).catch(() => undefined);
    const viewport = page.viewportSize() ?? await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    })).catch(() => undefined);
    const exported: SessionExport = {
      version: 1,
      cookies: await this.exportCookies(),
      url: page.url(),
      exportedAt: new Date().toISOString(),
    };
    if (this.profile) exported.profile = this.profile;
    if (localStorage !== undefined) exported.localStorage = localStorage;
    if (viewport !== undefined) exported.viewport = viewport;
    return exported;
  }

  async importSession(data: SessionExport): Promise<void> {
    if (data.version !== 1) throw new TendrilError('UNSUPPORTED_OPERATION', `Unsupported session export version: ${String(data.version)}`);
    await this.importCookies(data.cookies as AddCookie[]);
    const page = this.currentPage();
    if (data.url === 'about:blank') {
      await page.goto(data.url);
      this.refs.clear();
    } else {
      await this.navigate({ pageId: this.pageId(page), url: data.url });
    }
    if (data.localStorage !== undefined) {
      await page.evaluate((values) => {
        window.localStorage.clear();
        for (const [key, value] of Object.entries(values)) window.localStorage.setItem(key, value);
      }, data.localStorage);
    }
    if (data.viewport !== undefined) await page.setViewportSize(data.viewport);
  }

  async saveDownload(downloadId: string, destPath: string): Promise<{ path: string; bytes: number }> {
    this.touch();
    const entry = this.downloads.find((download) => download.id === downloadId);
    if (!entry) throw new TendrilError('UNSUPPORTED_OPERATION', `Download not found: ${downloadId}`);
    const pending = this.pendingDownloads.get(downloadId);
    if (pending) await pending;
    if (entry.failure) throw new TendrilError('UNSUPPORTED_OPERATION', `Download failed: ${entry.failure}`);
    if (!entry.path) throw new TendrilError('UNSUPPORTED_OPERATION', `Download path is unavailable: ${downloadId}`);

    const absoluteDestination = path.resolve(destPath);
    let destination: string;
    try {
      await lstat(absoluteDestination);
      destination = await assertPathWithinRoots(absoluteDestination, this.config.workspaceRoots);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = await assertPathWithinRoots(path.dirname(absoluteDestination), this.config.workspaceRoots);
      destination = path.join(parent, path.basename(absoluteDestination));
    }

    const source = entry.path;
    const bytes = (await stat(source)).size;
    try {
      await rename(source, destination);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) throw error;
      await copyFile(source, destination);
      await unlink(source);
    }
    entry.path = destination;
    return { path: destination, bytes };
  }

  inspect(options: { kind: 'console' | 'network' | 'downloads'; clear?: boolean }): unknown[] {
    this.touch();
    const entries = options.kind === 'console' ? this.consoleEntries : options.kind === 'network' ? this.networkEntries : this.downloads;
    const result = [...entries];
    if (options.clear) entries.splice(0, entries.length);
    return result;
  }

  async responseBody(requestId: string): Promise<{ body: string; base64: boolean; contentType?: string }> {
    const response = this.responses.get(requestId);
    if (!response) throw new TendrilError('UNSUPPORTED_OPERATION', `Response body is unavailable for ${requestId}`);
    const body = await response.body();
    if (body.length > this.config.maxResponseBodyBytes) throw new TendrilError('OUTPUT_LIMIT', 'Response body exceeds configured limit');
    const contentType = response.headers()['content-type'];
    const textual = !contentType || /text|json|xml|javascript|svg/i.test(contentType);
    const result: { body: string; base64: boolean; contentType?: string } = { body: textual ? body.toString('utf8') : body.toString('base64'), base64: !textual };
    if (contentType) result.contentType = contentType;
    return result;
  }

  async storage(options: { action: 'get' | 'set_cookies' | 'clear'; cookies?: AddCookie[]; origin?: string }): Promise<unknown> {
    this.touch();
    if (options.action === 'get') {
      const page = this.currentPage();
      const origin = options.origin ?? new URL(page.url()).origin;
      return {
        cookies: await this.chromium.context.cookies(),
        localStorage: await page.evaluate((targetOrigin) => location.origin === targetOrigin ? { ...localStorage } : {}, origin),
        sessionStorage: await page.evaluate((targetOrigin) => location.origin === targetOrigin ? { ...sessionStorage } : {}, origin),
      };
    }
    if (options.action === 'set_cookies') {
      await this.chromium.context.addCookies(options.cookies ?? []);
      return { success: true };
    }
    await this.chromium.context.clearCookies();
    const page = this.currentPage();
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    return { success: true };
  }

  async configure(options: { viewport?: { width: number; height: number }; headers?: Record<string, string>; geolocation?: { latitude: number; longitude: number; accuracy?: number }; offline?: boolean; permissions?: string[]; origin?: string; colorScheme?: 'dark' | 'light' | 'no-preference'; reducedMotion?: 'reduce' | 'no-preference'; timezoneId?: string; userAgent?: string; httpCredentials?: { username: string; password: string; origin?: string } | null }): Promise<void> {
    const page = this.currentPage();
    if (options.viewport) await page.setViewportSize(options.viewport);
    if (options.headers) await this.chromium.context.setExtraHTTPHeaders(options.headers);
    if (options.geolocation) await this.chromium.context.setGeolocation(options.geolocation);
    if (options.offline !== undefined) await this.chromium.context.setOffline(options.offline);
    if (options.httpCredentials !== undefined) await this.chromium.context.setHTTPCredentials(options.httpCredentials);
    if (options.permissions) await this.chromium.context.grantPermissions(options.permissions, options.origin ? { origin: options.origin } : undefined);
    if (options.colorScheme || options.reducedMotion) await page.emulateMedia({ colorScheme: options.colorScheme, reducedMotion: options.reducedMotion });
    if (options.timezoneId || options.userAgent) {
      const cdp = await this.chromium.context.newCDPSession(page);
      try {
        if (options.timezoneId) await cdp.send('Emulation.setTimezoneOverride', { timezoneId: options.timezoneId });
        if (options.userAgent) await cdp.send('Emulation.setUserAgentOverride', { userAgent: options.userAgent });
      } finally { await cdp.detach(); }
    }
  }

  dialog(): Omit<DialogEntry, 'dialog'> | undefined {
    if (!this.activeDialog) return undefined;
    const { dialog: _dialog, ...entry } = this.activeDialog;
    return entry;
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    if (!this.activeDialog) throw new TendrilError('UNSUPPORTED_OPERATION', 'There is no active dialog');
    const active = this.activeDialog;
    this.activeDialog = undefined;
    if (accept) await active.dialog.accept(promptText);
    else await active.dialog.dismiss();
  }

  async detectChallenge(pageId?: string): Promise<ChallengeInfo> {
    const page = this.currentPage(pageId);
    const [signals, cookies, title] = await Promise.all([
      page.evaluate(() => {
        const text = (document.body?.innerText ?? '').slice(0, 20_000);
        return {
          text,
          cloudflare: Boolean(document.querySelector('#challenge-running, #challenge-stage, .cf-browser-verification, iframe[src*="challenges.cloudflare.com"], script[src*="/cdn-cgi/challenge-platform/"]')),
          turnstile: Boolean(document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com/turnstile"]')),
          recaptcha: Boolean(document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]')),
          hcaptcha: Boolean(document.querySelector('.h-captcha, iframe[src*="hcaptcha.com"]')),
        };
      }).catch(() => ({ text: '', cloudflare: false, turnstile: false, recaptcha: false, hcaptcha: false })),
      this.chromium.context.cookies(page.url()).catch(() => []),
      page.title().catch(() => ''),
    ]);
    const lowerTitle = title.toLowerCase();
    const lowerUrl = page.url().toLowerCase();
    const lowerText = signals.text.toLowerCase();
    let provider: ChallengeInfo['provider'];
    let kind: ChallengeInfo['kind'];
    if (signals.turnstile) { provider = 'turnstile'; kind = 'widget'; }
    else if (signals.cloudflare || /just a moment|checking your browser/.test(lowerTitle) || /cf-chl-|cloudflare ray id/.test(lowerText)) { provider = 'cloudflare'; kind = 'interstitial'; }
    else if (signals.recaptcha) { provider = 'recaptcha'; kind = 'captcha'; }
    else if (signals.hcaptcha) { provider = 'hcaptcha'; kind = 'captcha'; }
    else if (lowerUrl.includes('duckduckgo.com') && /bots use duckduckgo|select all squares/.test(lowerText)) { provider = 'duckduckgo'; kind = 'captcha'; }
    else if (lowerUrl.includes('google.com/sorry') || /unusual traffic from your computer network/.test(lowerText)) { provider = 'google'; kind = lowerUrl.includes('/sorry') ? 'captcha' : 'rate-limit'; }
    else if (/captcha|verify you are human|security check/.test(`${lowerTitle} ${lowerText.slice(0, 3000)}`)) { provider = 'unknown'; kind = 'unknown'; }
    const info: ChallengeInfo = {
      detected: provider !== undefined,
      url: page.url(), title, requiresHuman: provider !== undefined,
      headed: !this.headless,
      clearanceCookiePresent: cookies.some((cookie) => cookie.name === 'cf_clearance'),
    };
    if (provider) info.provider = provider;
    if (kind) info.kind = kind;
    if (this.profile) info.profile = this.profile;
    if (provider) info.message = this.headless
      ? 'Challenge detected. Enable challengeAutoSolve for automatic resolution, or recreate/run this session in headed mode for manual completion.'
      : 'Challenge detected. Tendril has focused the headed browser for manual completion; wait for resolution before resuming automation.';
    return info;
  }

  async focusForHandoff(pageId?: string): Promise<ChallengeInfo> {
    const page = this.currentPage(pageId);
    await page.bringToFront();
    const challenge = await this.detectChallenge(pageId);
    if (this.headless && challenge.detected) {
      challenge.message = 'This session is headless and cannot be shown. Start Tendril with --headed or create a session with headless=false, preferably using a named profile.';
    }
    return challenge;
  }

  async waitForChallenge(options: { pageId?: string; timeoutMs?: number } = {}): Promise<ChallengeInfo> {
    const timeoutMs = Math.min(options.timeoutMs ?? 120_000, 10 * 60_000);
    const deadline = Date.now() + timeoutMs;
    let challenge = await this.detectChallenge(options.pageId);
    while (challenge.detected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      challenge = await this.detectChallenge(options.pageId);
    }
    if (challenge.detected) throw new TendrilError('TIMEOUT', `Challenge was not resolved within ${timeoutMs}ms`, { details: challenge as unknown as Record<string, unknown>, retryable: true });
    return challenge;
  }

  backendCdpHttpUrl(): string { return `http://127.0.0.1:${this.chromium.cdpPort}`; }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.logger.info('Closing browser session', { sessionId: this.id, profile: this.profile });
    this.closePromise = (async () => {
      const failures: unknown[] = [];
      const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
        try { await operation(); } catch (error) { failures.push(error); }
      };
      await attempt(() => this.chromium.close());
      await attempt(() => this.proxy.stop());
      await attempt(async () => {
        await withTimeout(Promise.allSettled(this.pendingDownloads.values()), 5_000, 'Pending download cleanup');
      });
      if (this.ephemeral) {
        // The constructor proves userDataDir is a generated child of config.runtimeDir/sessions.
        // lgtm[js/path-injection]
        await attempt(() => rm(this.userDataDir, { recursive: true, force: true }));
      }
      if (failures.length) throw new AggregateError(failures, `Failed to completely close session ${this.id}`);
    })();
    return this.closePromise;
  }
}
