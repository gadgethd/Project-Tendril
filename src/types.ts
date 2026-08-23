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
