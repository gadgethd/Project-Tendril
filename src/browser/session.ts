import { copyFile, lstat, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { BrowserContext, Dialog, Download, Frame, JSHandle, Page, Request, Response } from 'playwright';
import { TendrilError } from '../errors.js';
import { EgressProxy } from '../security/egress-proxy.js';
import { NetworkPolicy } from '../security/network-policy.js';
import type {
  ActivityEntry, BrowserCaptureOptions, BrowserCaptureResult, ChallengeInfo, ConsoleEntry, ContentSafetyEnvelope, ElementRef,
  NetworkEntry, PageId, PageSummary, SessionCreateOptions, SessionExport, SessionHealth, SessionId,
  SessionInfo, SnapshotResult, TendrilConfig,
} from '../types.js';
import {
  assertPathWithinOwnedRoot, assertPathWithinRoots, newId, pathWithinOwnedRoot, SENSITIVE_URL_KEY_PATTERN_SOURCE, withTimeout, type Logger,
} from '../util.js';
import { launchChromium, type ChromiumProcess } from './chromium.js';
import { mergeInjectionWarnings, SENSITIVE_CONTROL_PATTERN_SOURCE } from './content-safety.js';
import { extractForms, extractPage, extractTables } from './extract.js';
import {
  boundedSnapshotFrameUrls, boundedSnapshotTitle, boundedSnapshotUrl, boundedSnapshotWarnings,
  createSnapshot, ELEMENT_FINGERPRINT_OPTIONS, SNAPSHOT_BOUNDS,
  type ElementTarget,
} from './snapshot.js';

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

interface StoredSnapshotMetadata {
  readonly snapshotId: string;
  readonly pageId: string;
  readonly url: string;
  readonly title: string;
  readonly frameUrls: readonly string[];
  readonly mode: SnapshotResult['mode'];
  readonly warnings: readonly string[];
  readonly baselineSnapshotId?: string;
  readonly diffSummary?: SnapshotResult['diffSummary'];
}

interface StoredSnapshot {
  readonly metadata: StoredSnapshotMetadata;
  readonly fullContent: string;
  readonly canonicalContent?: string;
  readonly refIds: Set<ElementRef>;
  readonly cursorIds: Set<string>;
  readonly cursorByPosition: Map<string, string>;
  readonly documents: Set<JSHandle<Document>>;
}

interface CanonicalSnapshotBaseline {
  readonly snapshotId: string;
  readonly content: string;
}

interface SnapshotCursorEntry {
  readonly snapshotId: string;
  readonly offset: number;
  readonly maxChars: number;
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

const MAX_STORED_SNAPSHOTS = 20;
const MAX_STORED_SNAPSHOT_CHARS = 1_000_000;
const MAX_TOTAL_STORED_SNAPSHOT_CHARS = 5_000_000;
const MIN_SNAPSHOT_CHUNK_CHARS = 1_000;
const PAGE_SNAPSHOT_PREVIEW_CHARS = 500;
const MAX_STORED_SNAPSHOT_LINE_CHARS = 900;
const SNAPSHOT_CURSOR_PATTERN = /^cur_[a-f0-9]{20}$/;
const ELEMENT_REF_PATTERN = /^snap_[a-f0-9]{20}:e[1-9]\d{0,4}$/;
function normalizeStoredSnapshotLines(content: string): { content: string; truncated: boolean } {
  let truncated = false;
  const suffix = ' …[line truncated]';
  const lines = content.split('\n').map((line) => {
    if (line.length <= MAX_STORED_SNAPSHOT_LINE_CHARS) return line;
    truncated = true;
    let end = MAX_STORED_SNAPSHOT_LINE_CHARS - suffix.length;
    if (end > 0 && /[\uD800-\uDBFF]/.test(line[end - 1]!)) end -= 1;
    let prefix = line.slice(0, Math.max(0, end));
    const partialRef = prefix.lastIndexOf('[ref=');
    if (partialRef >= 0 && prefix.indexOf(']', partialRef) < 0) prefix = prefix.slice(0, partialRef).trimEnd();
    return `${prefix}${suffix}`.slice(0, MAX_STORED_SNAPSHOT_LINE_CHARS);
  });
  return { content: lines.join('\n'), truncated };
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
  private readonly snapshots = new Map<string, StoredSnapshot>();
  private readonly snapshotCursors = new Map<string, SnapshotCursorEntry>();
  private readonly canonicalSnapshotByPage = new Map<PageId, CanonicalSnapshotBaseline>();
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
      this.canonicalSnapshotByPage.delete(pageId);
      void this.invalidatePageRefs(pageId);
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

  private snapshotChunkSize(requested?: number): number {
    const value = requested ?? this.config.maxSnapshotChars;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
      throw new TendrilError('CONFIGURATION_ERROR', 'Snapshot maxChars must be a positive integer');
    }
    if (value < MIN_SNAPSHOT_CHUNK_CHARS) {
      throw new TendrilError('CONFIGURATION_ERROR', `Snapshot maxChars must be at least ${MIN_SNAPSHOT_CHUNK_CHARS}`);
    }
    return Math.min(value, 100_000);
  }

  private async invalidatePageRefs(pageId: PageId): Promise<void> {
    const targets: ElementTarget[] = [];
    const affectedSnapshots = new Set<StoredSnapshot>();
    for (const [ref, target] of this.refs) {
      if (target.pageId !== pageId) continue;
      this.refs.delete(ref);
      const snapshot = this.snapshots.get(target.snapshotId);
      snapshot?.refIds.delete(ref);
      if (snapshot) affectedSnapshots.add(snapshot);
      targets.push(target);
    }
    await Promise.all(targets.map((target) => target.element.dispose().catch(() => undefined)));
    await Promise.all([...affectedSnapshots].flatMap((snapshot) => {
      if (snapshot.refIds.size > 0) return [];
      const documents = [...snapshot.documents];
      snapshot.documents.clear();
      return documents.map((document) => document.dispose().catch(() => undefined));
    }));
  }

  private async evictSnapshot(snapshotId: string): Promise<void> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) return;
    this.snapshots.delete(snapshotId);
    const baseline = this.canonicalSnapshotByPage.get(snapshot.metadata.pageId);
    if (baseline?.snapshotId === snapshotId) this.canonicalSnapshotByPage.delete(snapshot.metadata.pageId);
    for (const cursor of snapshot.cursorIds) this.snapshotCursors.delete(cursor);
    snapshot.cursorByPosition.clear();
    const targets: ElementTarget[] = [];
    for (const ref of snapshot.refIds) {
      const target = this.refs.get(ref);
      if (!target || target.snapshotId !== snapshotId) continue;
      this.refs.delete(ref);
      targets.push(target);
    }
    await Promise.all(targets.map((target) => target.element.dispose().catch(() => undefined)));
    await Promise.all([...snapshot.documents].map((document) => document.dispose().catch(() => undefined)));
    snapshot.documents.clear();
  }

  private async storeSnapshot(options: {
    result: SnapshotResult;
    fullContent: string;
    canonicalContent?: string;
    refs?: Map<ElementRef, ElementTarget>;
    documents?: JSHandle<Document>[];
  }): Promise<StoredSnapshot> {
    const normalizedFull = normalizeStoredSnapshotLines(options.fullContent);
    const normalizedCanonical = options.canonicalContent === undefined
      ? undefined
      : normalizeStoredSnapshotLines(options.canonicalContent);
    const cappedContent = normalizedFull.content.slice(0, MAX_STORED_SNAPSHOT_CHARS);
    const boundary = normalizedFull.content.length > MAX_STORED_SNAPSHOT_CHARS ? cappedContent.lastIndexOf('\n') : -1;
    const fullContent = boundary > 0 ? cappedContent.slice(0, boundary) : cappedContent;
    const cappedCanonical = normalizedCanonical?.content.slice(0, MAX_STORED_SNAPSHOT_CHARS);
    const canonicalBoundary = (normalizedCanonical?.content.length ?? 0) > MAX_STORED_SNAPSHOT_CHARS
      ? cappedCanonical?.lastIndexOf('\n') ?? -1
      : -1;
    const canonicalContent = canonicalBoundary > 0 ? cappedCanonical!.slice(0, canonicalBoundary) : cappedCanonical;
    const warnings = [...options.result.warnings];
    if (normalizedFull.truncated || normalizedCanonical?.truncated) {
      warnings.push(`Snapshot lines exceeded ${MAX_STORED_SNAPSHOT_LINE_CHARS} characters and were safely truncated.`);
    }
    if (normalizedFull.content.length > MAX_STORED_SNAPSHOT_CHARS || (normalizedCanonical?.content.length ?? 0) > MAX_STORED_SNAPSHOT_CHARS) {
      warnings.push(`Snapshot content exceeded ${MAX_STORED_SNAPSHOT_CHARS} characters and was capped.`);
    }
    const boundedWarnings = boundedSnapshotWarnings(warnings);
    const metadata: StoredSnapshotMetadata = Object.freeze({
      snapshotId: options.result.snapshotId,
      pageId: options.result.pageId,
      url: options.result.url,
      title: options.result.title,
      frameUrls: Object.freeze([...options.result.frameUrls]),
      mode: options.result.mode,
      warnings: Object.freeze(boundedWarnings),
      ...(options.result.baselineSnapshotId ? { baselineSnapshotId: options.result.baselineSnapshotId } : {}),
      ...(options.result.diffSummary ? { diffSummary: Object.freeze({ ...options.result.diffSummary }) } : {}),
    });
    const record: StoredSnapshot = {
      metadata,
      fullContent,
      ...(canonicalContent === undefined ? {} : { canonicalContent }),
      refIds: new Set(),
      cursorIds: new Set(),
      cursorByPosition: new Map(),
      documents: new Set(),
    };
    this.snapshots.set(metadata.snapshotId, record);
    const retainedRefs = new Set([...fullContent.matchAll(/\[ref=([^\]]+)\]/g)].map((match) => match[1]!));
    for (const [ref, target] of options.refs ?? []) {
      if (retainedRefs.has(ref)) {
        record.refIds.add(ref);
        this.refs.set(ref, target);
      } else await target.element.dispose().catch(() => undefined);
    }
    for (const ref of record.refIds) {
      const document = options.refs?.get(ref)?.ownerDocument;
      if (document) record.documents.add(document);
    }
    await Promise.all((options.documents ?? []).filter((document) => !record.documents.has(document))
      .map((document) => document.dispose().catch(() => undefined)));
    const storedCharacters = (): number => [...this.snapshots.values()].reduce(
      (total, snapshot) => total + snapshot.fullContent.length + (snapshot.canonicalContent?.length ?? 0), 0,
    );
    while (this.snapshots.size > MAX_STORED_SNAPSHOTS || storedCharacters() > MAX_TOTAL_STORED_SNAPSHOT_CHARS) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (!oldest) break;
      await this.evictSnapshot(oldest);
    }
    return record;
  }

  private createSnapshotCursor(record: StoredSnapshot, offset: number, maxChars: number): string {
    const position = `${offset}:${maxChars}`;
    const existing = record.cursorByPosition.get(position);
    if (existing) return existing;
    const cursor = newId('cur');
    this.snapshotCursors.set(cursor, { snapshotId: record.metadata.snapshotId, offset, maxChars });
    record.cursorIds.add(cursor);
    record.cursorByPosition.set(position, cursor);
    return cursor;
  }

  private snapshotChunk(record: StoredSnapshot, offset: number, maxChars: number, nodes?: SnapshotResult['nodes']): SnapshotResult {
    const maximumOffset = Math.min(record.fullContent.length, offset + maxChars);
    let nextOffset = maximumOffset;
    if (maximumOffset < record.fullContent.length) {
      const boundary = record.fullContent.lastIndexOf('\n', maximumOffset - 1);
      if (boundary >= offset) nextOffset = boundary + 1;
      else if (nextOffset > offset && /[\uD800-\uDBFF]/.test(record.fullContent[nextOffset - 1]!)) nextOffset -= 1;
    }
    const truncated = nextOffset < record.fullContent.length;
    const metadata = record.metadata;
    const result: SnapshotResult = {
      snapshotId: metadata.snapshotId,
      pageId: metadata.pageId,
      url: metadata.url,
      title: metadata.title,
      frameUrls: [...metadata.frameUrls],
      mode: metadata.mode,
      content: record.fullContent.slice(offset, nextOffset),
      truncated,
      untrustedContent: true,
      warnings: [...metadata.warnings],
    };
    if (metadata.baselineSnapshotId) result.baselineSnapshotId = metadata.baselineSnapshotId;
    if (metadata.diffSummary) result.diffSummary = { ...metadata.diffSummary };
    if (!truncated && offset === 0 && nodes
      && record.fullContent.length + JSON.stringify(nodes).length <= maxChars) result.nodes = nodes;
    if (truncated) result.cursor = this.createSnapshotCursor(record, nextOffset, maxChars);
    return result;
  }

  private continueSnapshot(cursor: string, requestedMax?: number): SnapshotResult {
    if (!SNAPSHOT_CURSOR_PATTERN.test(cursor)) throw new TendrilError('INVALID_CURSOR', 'Invalid snapshot cursor');
    const entry = this.snapshotCursors.get(cursor);
    if (!entry) throw new TendrilError('INVALID_CURSOR', 'Snapshot cursor is invalid or expired');
    const snapshot = this.snapshots.get(entry.snapshotId);
    if (!snapshot || entry.offset < 1 || entry.offset >= snapshot.fullContent.length) {
      throw new TendrilError('INVALID_CURSOR', 'Snapshot cursor is invalid or expired');
    }
    if (requestedMax !== undefined && this.snapshotChunkSize(requestedMax) !== entry.maxChars) {
      throw new TendrilError('INVALID_CURSOR', 'Snapshot cursor chunk size is immutable; retry with the original maxChars');
    }
    return this.snapshotChunk(snapshot, entry.offset, entry.maxChars);
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
      return lastSnapshot === undefined ? page : { ...page, lastSnapshot };
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

  async navigate(options: { pageId?: string; url?: string; action?: 'goto' | 'back' | 'forward' | 'reload'; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; signal?: AbortSignal; deadlineMs?: number }): Promise<{ url: string; title: string; status: number | null; mimeType?: string }> {
    if (options.signal?.aborted) throw Object.assign(new Error('Navigation was cancelled'), { name: 'AbortError' });
    const page = this.currentPage(options.pageId);
    const pageId = this.pageId(page);
    const action = options.action ?? 'goto';
    let response: Response | null = null;
    const timeoutMs = boundedTimeout(this.config.navigationTimeoutMs, options.deadlineMs);
    if (action === 'goto') {
      if (!options.url) throw new TendrilError('INVALID_URL', 'url is required for goto');
      let parsed: URL;
      try { parsed = new URL(options.url); }
      catch (error) { throw new TendrilError('INVALID_URL', `Invalid URL: ${options.url}`, { cause: error }); }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new TendrilError('NETWORK_BLOCKED', `Navigation protocol ${parsed.protocol} is not allowed`);
      }
      await this.networkPolicy.resolve(parsed.toString(), options.signal);
      const gotoOptions = { waitUntil: options.waitUntil ?? 'domcontentloaded', timeout: timeoutMs } as const;
      try {
        response = await page.goto(options.url, gotoOptions);
      } catch (error) {
        const transientAbort = error instanceof Error && error.message.includes('net::ERR_ABORTED');
        if (!transientAbort) throw error;
        await page.waitForTimeout(100);
        response = await page.goto(options.url, gotoOptions);
      }
    } else if (action === 'back') response = await page.goBack({ waitUntil: options.waitUntil ?? 'domcontentloaded', timeout: timeoutMs });
    else if (action === 'forward') response = await page.goForward({ waitUntil: options.waitUntil ?? 'domcontentloaded', timeout: timeoutMs });
    else response = await page.reload({ waitUntil: options.waitUntil ?? 'domcontentloaded', timeout: timeoutMs });
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
    await this.invalidatePageRefs(this.pageId(page));
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return { url: page.url(), title: await page.title() };
  }

  async fetchText(
    url: string,
    pageId?: string,
    options: { signal?: AbortSignal; deadlineMs?: number; maxBytes?: number; accept?: string } = {},
  ): Promise<{ status: number | null; text: string; headers: Record<string, string> }> {
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
      throwIfAborted(options.signal);
      await this.networkPolicy.resolve(target.toString());
      throwIfAborted(options.signal);
      const timeoutMs = boundedTimeout(this.config.navigationTimeoutMs, options.deadlineMs);
      const result = await new Promise<{ status: number; text: string; headers: Record<string, string>; location?: string }>((resolve, reject) => {
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
        request.once('close', () => options.signal?.removeEventListener('abort', onAbort));
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
    const maxChars = this.snapshotChunkSize(options.maxChars);
    if (mode === 'reader') {
      await this.invalidatePageRefs(pageId);
      const url = page.url();
      const allFrames = page.frames();
      const frames = allFrames.slice(0, SNAPSHOT_BOUNDS.maxFrames);
      const rawFrameUrls = frames.map((frame) => frame.url());
      const frameUrls = boundedSnapshotFrameUrls(rawFrameUrls);
      const extracted = await extractPage(page, { maxChars: this.config.maxResponseBodyBytes });
      const full = `# ${extracted.title}\n\n${extracted.markdown}`;
      const snapshotId = newId('snap');
      const currentFrames = page.frames();
      if (page.url() !== url || currentFrames.length !== allFrames.length
        || frames.some((frame, index) => currentFrames[index] !== frame || frame.url() !== rawFrameUrls[index])) {
        throw new TendrilError('STALE_ELEMENT_REF', 'Page or frame changed while the reader snapshot was being captured; take a new snapshot');
      }
      const warnings = [...extracted.warnings];
      if (allFrames.length > frames.length) warnings.push(`Snapshot omitted ${allFrames.length - frames.length} frames after the frame limit.`);
      if (url !== boundedSnapshotUrl(url) || extracted.title !== boundedSnapshotTitle(extracted.title)
        || rawFrameUrls.some((frameUrl, index) => frameUrl !== frameUrls[index])) {
        warnings.push('Snapshot provenance was redacted or truncated to its output budget.');
      }
      const base: SnapshotResult = {
        snapshotId, pageId, url: boundedSnapshotUrl(url), title: boundedSnapshotTitle(extracted.title),
        frameUrls, mode,
        content: '', truncated: false, untrustedContent: true, warnings,
      };
      const stored = await this.storeSnapshot({ result: base, fullContent: full });
      this.lastSnapshotByPage.set(pageId, stored.fullContent.slice(0, PAGE_SNAPSHOT_PREVIEW_CHARS));
      const result = this.snapshotChunk(stored, 0, maxChars);
      this.recordActivity('snapshot', `${mode} snapshot`, result.url);
      return result;
    }

    let baseline: CanonicalSnapshotBaseline | undefined;
    if (mode === 'diff' && options.previousSnapshotId) {
      const previous = this.snapshots.get(options.previousSnapshotId);
      if (!previous?.canonicalContent) throw new TendrilError('STALE_ELEMENT_REF', 'Previous semantic snapshot is unavailable or expired');
      if (previous.metadata.pageId !== pageId) throw new TendrilError('STALE_ELEMENT_REF', 'Diff baselines must belong to the same page');
      baseline = { snapshotId: previous.metadata.snapshotId, content: previous.canonicalContent };
    } else if (mode === 'diff') {
      baseline = this.canonicalSnapshotByPage.get(pageId);
    }

    await this.invalidatePageRefs(pageId);
    const created = await createSnapshot({
      page, pageId, mode, maxChars: MAX_STORED_SNAPSHOT_CHARS,
      previousContent: baseline?.content, baselineSnapshotId: baseline?.snapshotId,
      compact: options.compact, maxDepth: options.maxDepth,
    });
    const stored = await this.storeSnapshot({
      result: created.result,
      fullContent: created.fullContent,
      canonicalContent: created.canonicalContent,
      refs: created.refs,
      documents: created.documents,
    });
    this.canonicalSnapshotByPage.set(pageId, { snapshotId: created.result.snapshotId, content: stored.canonicalContent! });
    this.lastSnapshotByPage.set(pageId, stored.fullContent.slice(0, PAGE_SNAPSHOT_PREVIEW_CHARS));
    const result = this.snapshotChunk(stored, 0, maxChars, created.result.nodes);
    this.recordActivity('snapshot', `${mode} snapshot`, result.url);
    return result;
  }

  private async resolveTarget(ref: string): Promise<{ page: Page; frame: Frame; target: ElementTarget }> {
    if (!ELEMENT_REF_PATTERN.test(ref)) {
      throw new TendrilError('STALE_ELEMENT_REF', 'Invalid or stale element reference; take a new snapshot');
    }
    const target = this.refs.get(ref);
    if (!target) throw new TendrilError('STALE_ELEMENT_REF', 'Unknown or stale element reference; take a new snapshot');
    const stale = async (message: string, cause?: unknown): Promise<never> => {
      this.refs.delete(ref);
      const snapshot = this.snapshots.get(target.snapshotId);
      snapshot?.refIds.delete(ref);
      await target.element.dispose().catch(() => undefined);
      if (snapshot?.refIds.size === 0) {
        const documents = [...snapshot.documents];
        snapshot.documents.clear();
        await Promise.all(documents.map((document) => document.dispose().catch(() => undefined)));
      }
      throw new TendrilError('STALE_ELEMENT_REF', message, cause === undefined ? undefined : { cause });
    };
    const page = this.pagesById.get(target.pageId);
    if (!this.snapshots.has(target.snapshotId) || !page || page !== target.page || page.url() !== target.pageUrl) {
      return stale(`Element reference ${ref} is stale after navigation; take a new snapshot`);
    }
    const frame = target.frame;
    if (!page.frames().includes(frame) || frame.url() !== target.frameUrl) {
      return stale(`Frame for ${ref} changed; take a new snapshot`);
    }
    let live: { connected: boolean; sameDocument: boolean; fingerprint: string };
    try {
      live = await target.element.evaluate((element, options) => {
        const { fingerprintOptions, ownerDocument } = options;
        const normalize = (value: string | null | undefined): string => (
          (value ?? '').slice(0, fingerprintOptions.maxTextChars * 4).replace(/\s+/g, ' ').trim().slice(0, fingerprintOptions.maxTextChars)
        );
        const escapeIdentifier = (value: string): string => (
          typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`)
        );
        const findReferenced = (candidate: Element, id: string): Element | null => {
          const root = candidate.getRootNode();
          if ('getElementById' in root && typeof root.getElementById === 'function') return root.getElementById(id);
          return candidate.ownerDocument.getElementById(id)
            ?? (root as Document | ShadowRoot).querySelector?.(`#${escapeIdentifier(id)}`)
            ?? null;
        };
        let remainingNodes = 20_000;
        const boundedNodeText = (candidate: Element, maxChars = fingerprintOptions.maxTextChars * 4): string => {
          const parts: string[] = [];
          const pending: Node[] = [];
          let current: Node | null = candidate.firstChild;
          let chars = 0;
          while (current && remainingNodes > 0 && chars < maxChars) {
            const node: Node = current;
            const sibling: Node | null = node.nextSibling;
            remainingNodes -= 1;
            if (node.nodeType === 3) {
              const text = (node.textContent ?? '').slice(0, maxChars - chars);
              parts.push(text);
              chars += text.length;
              current = sibling ?? pending.pop() ?? null;
              continue;
            }
            if (node instanceof Element && node.firstChild) {
              if (sibling) pending.push(sibling);
              current = node.firstChild;
            } else current = sibling ?? pending.pop() ?? null;
          }
          return normalize(parts.join(' '));
        };
        const referencedText = (candidate: Element, attribute: string): string => {
          const ids = (candidate.getAttribute(attribute) ?? '').slice(0, fingerprintOptions.maxTextChars * 4).split(/\s+/).filter(Boolean);
          const parts: string[] = [];
          let remainingChars = fingerprintOptions.maxTextChars * 4;
          for (const id of ids) {
            const referenced = findReferenced(candidate, id.slice(0, 500));
            if (!referenced || remainingChars <= 0) continue;
            const text = boundedNodeText(referenced, remainingChars);
            if (text) { parts.push(text); remainingChars -= text.length; }
          }
          return normalize(parts.join(' '));
        };
        const tag = element.tagName.toLowerCase();
        const type = (element.getAttribute('type') ?? '').slice(0, 100).toLowerCase();
        const labels: string[] = [];
        const elementLabels = 'labels' in element ? element.labels as NodeListOf<HTMLLabelElement> | null : null;
        if (elementLabels) {
          for (let index = 0; index < Math.min(elementLabels.length, 50); index += 1) {
            const label = elementLabels[index];
            if (label) labels.push(boundedNodeText(label));
          }
        }
        const semanticValue = tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type)
          ? (element as HTMLInputElement).value
          : tag === 'option'
            ? (element as HTMLOptionElement).value
            : '';
        const parts: Array<string | boolean> = [
          'semantic-v2',
          tag,
          ...fingerprintOptions.attributes.map((attribute) => normalize(element.getAttribute(attribute))),
          ...fingerprintOptions.referenceAttributes.map((attribute) => referencedText(element, attribute)),
          boundedNodeText(element),
          normalize(labels.join(' ')),
          normalize(semanticValue),
          'disabled' in element && Boolean(element.disabled),
          'checked' in element && Boolean(element.checked),
          'selected' in element && Boolean(element.selected),
          'readOnly' in element && Boolean(element.readOnly),
          'required' in element && Boolean(element.required),
          'isContentEditable' in element && Boolean(element.isContentEditable),
          (element as HTMLElement).hidden,
        ];
        let primary = 0x811c9dc5;
        let secondary = 0x9e3779b9;
        let length = 0;
        for (const rawPart of parts) {
          const part = String(rawPart).slice(0, fingerprintOptions.maxComponentChars);
          length += part.length;
          for (let index = 0; index <= part.length; index += 1) {
            const code = index === part.length ? 0xffff : part.charCodeAt(index);
            primary = Math.imul(primary ^ code, 0x01000193) >>> 0;
            secondary = Math.imul(secondary ^ code, 0x85ebca6b) >>> 0;
          }
        }
        const fingerprint = `semantic-v3:${primary.toString(16).padStart(8, '0')}:${secondary.toString(16).padStart(8, '0')}:${length}`
          .slice(0, fingerprintOptions.maxFingerprintChars);
        return {
          connected: element.isConnected,
          sameDocument: element.ownerDocument === ownerDocument,
          fingerprint,
        };
      }, {
        fingerprintOptions: ELEMENT_FINGERPRINT_OPTIONS,
        ownerDocument: target.ownerDocument,
      });
    } catch (error) {
      return stale(`Element reference ${ref} is detached or replaced; take a new snapshot`, error);
    }
    if (!live.connected || !live.sameDocument || live.fingerprint !== target.fingerprint) {
      return stale(`Element reference ${ref} is detached, replaced, or changed; take a new snapshot`);
    }
    return { page, frame, target };
  }

  async act(options: { action: BrowserAction; ref?: string; targetRef?: string; text?: string; value?: string; values?: string[]; key?: string; deltaX?: number; deltaY?: number; files?: string[]; submit?: boolean }): Promise<{ url: string; snapshot?: SnapshotResult }> {
    this.touch();
    if (options.action === 'press' && !options.ref) {
      const page = this.currentPage();
      const pageId = this.pageId(page);
      try { await page.keyboard.press(options.key ?? 'Enter'); }
      finally { await this.invalidatePageRefs(pageId); }
      const result = { url: page.url() };
      this.recordActivity('act', `${options.action} ${options.key ?? 'Enter'}`, result.url);
      return result;
    }
    if (!options.ref) throw new TendrilError('STALE_ELEMENT_REF', 'ref is required for this action');
    const { page, target } = await this.resolveTarget(options.ref);
    let destinationPageId: string | undefined;
    try {
      switch (options.action) {
        case 'click': await target.element.click(); break;
        case 'double_click': await target.element.dblclick(); break;
        case 'hover': await target.element.hover(); break;
        case 'focus': await target.element.focus(); break;
        case 'fill': await target.element.fill(options.text ?? ''); break;
        case 'type':
          await target.element.fill('');
          await target.element.type(options.text ?? '');
          break;
        case 'select':
          if (options.value !== undefined) await target.element.selectOption({ label: options.value });
          else await target.element.selectOption(options.values ?? []);
          break;
        case 'check': await target.element.check(); break;
        case 'uncheck': await target.element.uncheck(); break;
        case 'press': await target.element.press(options.key ?? 'Enter'); break;
        case 'scroll': await target.element.evaluate((element, delta) => element.scrollBy(delta.x, delta.y), { x: options.deltaX ?? 0, y: options.deltaY ?? 600 }); break;
        case 'drag': {
          if (!options.targetRef) throw new TendrilError('STALE_ELEMENT_REF', 'targetRef is required for drag');
          const destination = await this.resolveTarget(options.targetRef);
          if (destination.page !== page) throw new TendrilError('STALE_ELEMENT_REF', 'Drag refs must belong to the same page');
          destinationPageId = destination.target.pageId;
          const [sourceBox, targetBox] = await Promise.all([target.element.boundingBox(), destination.target.element.boundingBox()]);
          if (!sourceBox || !targetBox) throw new TendrilError('STALE_ELEMENT_REF', 'Drag source or destination is no longer visible; take a new snapshot');
          await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
          await page.mouse.down();
          try { await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 }); }
          finally { await page.mouse.up(); }
          break;
        }
        case 'upload': {
          const files = await Promise.all((options.files ?? []).map((file) => assertPathWithinRoots(file, this.config.workspaceRoots)));
          await target.element.setInputFiles(files);
          break;
        }
      }
      if (options.submit && ['fill', 'type'].includes(options.action)) await target.element.press('Enter');
    } finally {
      await this.invalidatePageRefs(target.pageId);
      if (destinationPageId && destinationPageId !== target.pageId) await this.invalidatePageRefs(destinationPageId);
    }
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
      const responseLimit = Number.isFinite(this.config.maxResponseBodyBytes) && this.config.maxResponseBodyBytes > 0
        ? Math.floor(this.config.maxResponseBodyBytes)
        : 1;
      result = await page.evaluate(({ selector, limits }) => {
        const selected = document.querySelectorAll(selector);
        const output: Array<{ text: string; html: string; attributes: Record<string, string>; truncated: boolean }> = [];
        let payloadRemaining = limits.maxPayloadChars;
        let cloneNodesRemaining = limits.maxCloneNodes;
        let textNodesRemaining = limits.maxTextNodes;
        const sensitiveControl = new RegExp(limits.sensitiveControlPattern, 'i');
        const sensitiveUrlKey = new RegExp(limits.sensitiveUrlKeyPattern, 'i');
        const redactUrl = (value: string): string => {
          try {
            const url = new URL(value, /^https?:/i.test(document.baseURI) ? document.baseURI : 'https://redaction.invalid/');
            for (const key of [...url.searchParams.keys()]) if (sensitiveUrlKey.test(key.slice(0, 500))) url.searchParams.set(key, '[redacted]');
            const rawHash = url.hash.slice(1);
            const queryIndex = rawHash.indexOf('?');
            const prefix = queryIndex >= 0 ? rawHash.slice(0, queryIndex + 1) : '';
            const parameterText = queryIndex >= 0 ? rawHash.slice(queryIndex + 1) : rawHash;
            if (parameterText.includes('=')) {
              const hash = new URLSearchParams(parameterText);
              for (const key of [...hash.keys()]) if (sensitiveUrlKey.test(key.slice(0, 500))) hash.set(key, '[redacted]');
              url.hash = `${prefix}${hash.toString()}`;
            }
            return url.toString();
          } catch { return value; }
        };
        const redactText = (value: string): string => value
          .replace(/(?:https?:\/\/|\/|#|\?)[^\s"'<>]*/gi, (candidate) => candidate.includes('=') ? redactUrl(candidate) : candidate)
          .replace(/(\b(?:api[_-]?key|key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|secret|token|credential|signature|sig|code|awsaccesskeyid|googleaccessid)\s*[=:]\s*)([^\s&;,]+)/gi, '$1[redacted]');
        const isSensitiveControl = (element: Element): boolean => (
          element.tagName.toLowerCase() === 'input' && (element.getAttribute('type') ?? '').toLowerCase() === 'hidden'
        ) || sensitiveControl.test([
          element.getAttribute('type'), element.getAttribute('name'), element.getAttribute('id'),
          element.getAttribute('autocomplete'), element.getAttribute('aria-label'),
        ].map((value) => value?.slice(0, 500)).filter(Boolean).join(' '));
        const boundedText = (root: Element, maxChars: number): { value: string; truncated: boolean } => {
          if (isSensitiveControl(root)) return { value: '[redacted]'.slice(0, maxChars), truncated: false };
          const parts: string[] = [];
          const pending: Node[] = [];
          let current: Node | null = root.firstChild;
          let chars = 0;
          while (current && textNodesRemaining > 0 && chars < maxChars) {
            const node: Node = current;
            const sibling: Node | null = node.nextSibling;
            textNodesRemaining -= 1;
            if (node.nodeType === 3) {
              const source = (node.textContent ?? '').slice(0, maxChars - chars);
              const text = redactText(source).slice(0, maxChars - chars);
              parts.push(text);
              chars += text.length;
              current = sibling ?? pending.pop() ?? null;
            } else if (node instanceof Element && isSensitiveControl(node)) {
              const text = '[redacted]'.slice(0, maxChars - chars);
              parts.push(text);
              chars += text.length;
              current = sibling ?? pending.pop() ?? null;
            } else if (node instanceof Element && node.firstChild) {
              if (sibling) pending.push(sibling);
              current = node.firstChild;
            } else current = sibling ?? pending.pop() ?? null;
          }
          return { value: parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxChars), truncated: Boolean(current || pending.length) };
        };
        const encodedLength = (character: string, attribute: boolean): number => {
          if (character === '&') return 5;
          if (character === '<' || character === '>') return 4;
          if (attribute && character === '"') return 6;
          return character.length;
        };
        const fitEncoded = (value: string, available: number, attribute: boolean): { value: string; cost: number; complete: boolean } => {
          let cost = 0;
          let end = 0;
          for (const character of value) {
            const next = encodedLength(character, attribute);
            if (cost + next > available) break;
            cost += next;
            end += character.length;
          }
          return { value: value.slice(0, end), cost, complete: end === value.length };
        };
        const cloneBounded = (root: Element, maxChars: number): { html: string; truncated: boolean } => {
          let serializationRemaining = maxChars;
          let truncated = false;
          const copy = (source: Element, depth: number): Element | undefined => {
            if (depth > limits.maxDepth || cloneNodesRemaining <= 0) { truncated = true; return undefined; }
            cloneNodesRemaining -= 1;
            const tag = source.tagName.toLowerCase().slice(0, 100);
            const elementCost = 5 + tag.length * 2;
            if (serializationRemaining < elementCost) { truncated = true; return undefined; }
            serializationRemaining -= elementCost;
            const clone = document.createElementNS(source.namespaceURI, tag);
            const attributes = Math.min(source.attributes.length, limits.maxAttributes);
            for (let index = 0; index < attributes; index += 1) {
              const attribute = source.attributes.item(index);
              if (!attribute) continue;
              const name = attribute.name.slice(0, 200);
              const baseCost = name.length + 4;
              if (serializationRemaining <= baseCost) { truncated = true; break; }
              const lowerName = name.toLowerCase();
              const sourceValue = attribute.value.slice(0, 2_000);
              const value = sensitiveControl.test(lowerName) || (isSensitiveControl(source) && lowerName === 'value')
                ? '[redacted]'
                : ['href', 'src', 'action', 'formaction', 'poster'].includes(lowerName)
                  ? redactUrl(sourceValue)
                  : sourceValue;
              const fitted = fitEncoded(value, serializationRemaining - baseCost, true);
              clone.setAttribute(name, fitted.value);
              serializationRemaining -= baseCost + fitted.cost;
              if (!fitted.complete || attribute.value.length > sourceValue.length) truncated = true;
              if (!fitted.complete) break;
            }
            if (source.attributes.length > attributes) truncated = true;
            if (isSensitiveControl(source) && !clone.hasAttribute('value') && serializationRemaining > 20) {
              clone.setAttribute('value', '[redacted]');
              serializationRemaining -= 20;
            }
            if (isSensitiveControl(source)) {
              const fitted = fitEncoded('[redacted]', serializationRemaining, false);
              clone.append(document.createTextNode(fitted.value));
              serializationRemaining -= fitted.cost;
              if (!fitted.complete) truncated = true;
              return clone;
            }
            for (let child = source.firstChild; child; child = child.nextSibling) {
              if (serializationRemaining <= 0 || cloneNodesRemaining <= 0) { truncated = true; break; }
              if (child.nodeType === 3) {
                cloneNodesRemaining -= 1;
                const sourceText = (child.textContent ?? '').slice(0, serializationRemaining);
                const fitted = fitEncoded(redactText(sourceText), serializationRemaining, false);
                clone.append(document.createTextNode(fitted.value));
                serializationRemaining -= fitted.cost;
                if (!fitted.complete || sourceText.length < (child.textContent ?? '').length) truncated = true;
              } else if (child.nodeType === 1) {
                const copied = copy(child as Element, depth + 1);
                if (!copied) break;
                clone.append(copied);
              }
            }
            return clone;
          };
          const clone = copy(root, 0);
          const html = clone ? (clone as HTMLElement).outerHTML.slice(0, maxChars) : '';
          return { html, truncated: truncated || html.length >= maxChars };
        };
        const count = Math.min(selected.length, limits.maxResults);
        for (let index = 0; index < count && payloadRemaining > 32; index += 1) {
          const node = selected.item(index);
          if (!(node instanceof Element)) continue;
          let truncated = selected.length > limits.maxResults;
          const text = boundedText(node, Math.min(limits.maxTextChars, payloadRemaining));
          payloadRemaining -= text.value.length;
          truncated ||= text.truncated;
          const cloned = cloneBounded(node, Math.min(limits.maxHtmlChars, payloadRemaining));
          payloadRemaining -= cloned.html.length;
          truncated ||= cloned.truncated;
          const attributes: Record<string, string> = {};
          const attributeCount = Math.min(node.attributes.length, limits.maxAttributes);
          for (let attributeIndex = 0; attributeIndex < attributeCount && payloadRemaining > 8; attributeIndex += 1) {
            const attribute = node.attributes.item(attributeIndex);
            if (!attribute) continue;
            const name = attribute.name.slice(0, Math.min(200, payloadRemaining));
            const lowerName = name.toLowerCase();
            const available = Math.max(0, payloadRemaining - name.length - 4);
            const rawValue = sensitiveControl.test(lowerName) || (isSensitiveControl(node) && lowerName === 'value')
              ? '[redacted]'
              : ['href', 'src', 'action', 'formaction', 'poster'].includes(lowerName)
                ? redactUrl(attribute.value.slice(0, 2_000))
                : attribute.value.slice(0, 2_000);
            const value = rawValue.slice(0, available);
            attributes[name] = value;
            payloadRemaining -= name.length + value.length + 4;
            if (value.length < rawValue.length || attribute.value.length > 2_000) truncated = true;
          }
          if (node.attributes.length > attributeCount) truncated = true;
          output.push({ text: text.value, html: cloned.html, attributes, truncated });
        }
        return output;
      }, {
        selector: options.selector,
        limits: {
          maxResults: 100,
          maxTextChars: 5_000,
          maxHtmlChars: 10_000,
          maxAttributes: 50,
          maxCloneNodes: 5_000,
          maxTextNodes: 5_000,
          maxDepth: 100,
          maxPayloadChars: Math.min(500_000, Math.max(1, Math.floor(responseLimit / 8))),
          sensitiveControlPattern: SENSITIVE_CONTROL_PATTERN_SOURCE,
          sensitiveUrlKeyPattern: SENSITIVE_URL_KEY_PATTERN_SOURCE,
        },
      });
    } else {
      const format = options.format ?? 'all';
      if (format === 'forms') result = await extractForms(page);
      else if (format === 'tables') result = await extractTables(page);
      else {
        const extracted = await extractPage(page, { maxChars: this.config.maxResponseBodyBytes });
        result = format === 'all' ? extracted : extracted[format];
      }
    }
    this.recordActivity('extract', options.selector ? `selector ${options.selector}` : (options.format ?? 'all'), page.url());
    return result;
  }

  async extractWithSafety(
    options: { pageId?: string; format?: 'all' | 'html' | 'markdown' | 'text' | 'links' | 'metadata' | 'forms' | 'tables'; selector?: string },
  ): Promise<ContentSafetyEnvelope> {
    const data = await this.extract(options);
    const inherited = typeof data === 'object' && data !== null && 'warnings' in data && Array.isArray(data.warnings)
      ? data.warnings.filter((warning): warning is string => typeof warning === 'string')
      : [];
    return { data, untrustedContent: true, warnings: [...new Set([...inherited, ...mergeInjectionWarnings(data)])] };
  }

  async capture(options: BrowserCaptureOptions): Promise<BrowserCaptureResult> {
    if (options.ref && options.format === 'pdf') {
      throw new TendrilError('UNSUPPORTED_OPERATION', 'Element refs are not supported for PDF capture');
    }
    const resolvedTarget = options.ref && options.format !== 'pdf' ? await this.resolveTarget(options.ref) : undefined;
    const page = options.pageId ? this.currentPage(options.pageId) : resolvedTarget?.page ?? this.currentPage();
    const type = options.format ?? 'png';
    let buffer: Buffer;
    if (type === 'pdf') {
      buffer = await page.pdf({ printBackground: true });
    } else {
      const target = resolvedTarget;
      if (target && target.page !== page) {
        throw new TendrilError('STALE_ELEMENT_REF', 'Capture ref must belong to the requested page');
      }
      buffer = target
        ? await target.target.element.screenshot({ type, quality: type === 'jpeg' ? options.quality ?? 80 : undefined })
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
    const id = this.pageId(page);
    try {
      const result = await page.evaluate((source) => {
        // This is intentionally page-scoped and cannot access the Tendril Node process.
        return (0, eval)(source) as unknown;
      }, expression);
      this.recordActivity('evaluate', expression.slice(0, 200), page.url());
      return result;
    } finally {
      await this.invalidatePageRefs(id);
    }
  }

  async fillForm(selectors: Record<string, string>): Promise<{ url: string; filled: string[] }> {
    const page = this.currentPage();
    const pageId = this.pageId(page);
    try {
      for (const [selector, value] of Object.entries(selectors)) {
        const locator = page.locator(selector).first();
        if (await locator.count() === 0) throw new TendrilError('STALE_ELEMENT_REF', `Form field not found: ${selector}`);
        const control = await locator.evaluate((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element instanceof HTMLInputElement ? element.type.toLowerCase() : '',
        }));
        if (control.tag === 'select') {
          await locator.selectOption({ label: value }).catch(() => locator.selectOption(value));
        } else if (control.type === 'checkbox' || control.type === 'radio') {
          if (/^(true|1|yes|on|checked)$/i.test(value)) await locator.check();
          else await locator.uncheck();
        } else {
          await locator.fill(value);
        }
      }
      return { url: page.url(), filled: Object.keys(selectors) };
    } finally {
      await this.invalidatePageRefs(pageId);
    }
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
      await this.invalidatePageRefs(this.pageId(page));
      await page.goto(data.url);
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
    const pageId = this.pageId(page);
    try {
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
    } finally {
      await this.invalidatePageRefs(pageId);
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