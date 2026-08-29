export type SessionId = string;
export type PageId = string;
export type SnapshotId = string;
export type ElementRef = string;

export interface TendrilConfig {
  host: string;
  port: number;
  headless: boolean;
  executablePath?: string;
  maxSessions: number;
  sessionIdleMs: number;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  maxSnapshotChars: number;
  maxResponseBodyBytes: number;
  blockPrivateNetworks: boolean;
  allowedHosts: string[];
  blockedHosts: string[];
  workspaceRoots: string[];
  searchProviders: SearchProviderName[];
  searxngUrl?: string;
  googleSearchApiKey?: string;
  googleSearchCx?: string;
  dataDir: string;
  runtimeDir: string;
  token?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export type SearchProviderName = 'duckduckgo' | 'bing' | 'google' | 'searxng';

export interface SessionCreateOptions {
  profile?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  allowedHosts?: string[];
  allowPrivateNetwork?: boolean;
  interceptionRules?: InterceptionRule[];
}

export interface SessionInfo {
  id: SessionId;
  profile?: string;
  ephemeral: boolean;
  headless: boolean;
  createdAt: string;
  lastActivityAt: string;
  pages: PageSummary[];
  processId?: number;
  cdpUrl?: string;
}

export interface BrowserCaptureOptions {
  pageId?: string;
  format?: 'png' | 'jpeg' | 'pdf';
  fullPage?: boolean;
  ref?: string;
  quality?: number;
  savePath?: string;
}

export interface BrowserCaptureResult {
  mimeType: string;
  data: string;
  savePath?: string;
}

export interface PageSummary {
  id: PageId;
  url: string;
  title: string;
  selected: boolean;
}

export interface SnapshotNode {
  ref?: ElementRef;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  level?: number;
  selected?: boolean;
  children?: SnapshotNode[];
}

export interface SnapshotResult {
  snapshotId: SnapshotId;
  pageId: PageId;
  url: string;
  title: string;
  mode: 'interactive' | 'reader' | 'full' | 'diff';
  content: string;
  nodes?: SnapshotNode[];
  cursor?: string;
  truncated: boolean;
  untrustedContent: true;
  warnings: string[];
}

export interface SearchResult {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  provider: SearchProviderName;
}

export interface EvidenceChunk {
  sourceUrl: string;
  title: string;
  text: string;
  heading?: string;
  query: string;
}

export interface CrawlResult {
  url: string;
  status: number | null;
  title?: string;
  markdown?: string;
  links: string[];
  error?: string;
}

export interface CrawlJob {
  id: string;
  parentJobId?: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: string;
  completedAt?: string;
  queued: number;
  visited: number;
  results: CrawlResult[];
  error?: string;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
}

export interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  resourceType: string;
  startedAt: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  failed?: string;
}

export interface ChallengeInfo {
  detected: boolean;
  provider?: 'cloudflare' | 'turnstile' | 'recaptcha' | 'hcaptcha' | 'duckduckgo' | 'google' | 'unknown';
  kind?: 'interstitial' | 'widget' | 'captcha' | 'rate-limit' | 'unknown';
  url: string;
  title: string;
  message?: string;
  requiresHuman: boolean;
  headed: boolean;
  profile?: string;
  clearanceCookiePresent: boolean;
}

export interface LogRecord {
  level: TendrilConfig['logLevel'];
  message: string;
  time: string;
  [key: string]: unknown;
}

export interface CompactSnapshotOptions {
  maxDepth?: number;        // default 3 (vs unlimited in interactive)
  inlineText?: boolean;     // collapse single-child text nodes into parent
  dropEmpty?: boolean;      // remove containers with no visible content
}

export interface StructuredData {
  jsonLd?: Record<string, unknown>[];
  openGraph?: Record<string, string>;
  microdata?: Record<string, unknown>[];
  prices?: Array<{ amount: string; currency: string; selector: string }>;
  dates?: Array<{ value: string; label: string; selector: string }>;
  authors?: string[];
}

export interface SearchRateLimit {
  provider: SearchProviderName;
  retryAfterMs?: number;
  remaining?: number;
  limit?: number;
}

export interface SearchProviderHealth {
  provider: SearchProviderName;
  available: boolean;
  lastSuccess?: string;
  lastFailure?: string;
  averageLatencyMs?: number;
  errorCount: number;
}

export interface ActivityEntry {
  type: 'navigate' | 'act' | 'snapshot' | 'extract' | 'search' | 'capture' | 'evaluate' | 'challenge';
  timestamp: string;
  detail: string;
  url?: string;
}

export interface InterceptionRule {
  urlPattern: string;       // glob pattern
  block?: boolean;
  modifyHeaders?: Record<string, string>;
}

export interface SessionHealth {
  alive: boolean;
  pid?: number;
  memoryBytes?: number;
  lastActivityAt: string;
  uptimeMs: number;
  pageCount: number;
}

export interface SessionExport {
  version: 1;
  profile?: string;
  cookies: Array<Record<string, unknown>>;
  localStorage?: Record<string, string>;
  url: string;
  viewport?: { width: number; height: number };
  exportedAt: string;
}
