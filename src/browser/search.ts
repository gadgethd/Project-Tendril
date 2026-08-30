import { parseHTML } from 'linkedom';
import { TendrilError } from '../errors.js';
import type { EvidenceChunk, SearchProviderHealth, SearchProviderName, SearchRateLimit, SearchResult } from '../types.js';
import { hashText, newId, type Logger } from '../util.js';
import type { BrowserManager } from './manager.js';
import type { TendrilSession } from './session.js';

const SEARCH_CACHE_TTL_MS = 5 * 60_000;
const SEARCH_CACHE_MAX_ENTRIES = 100;
const MAX_SEARCH_RESULTS = 50;
const MAX_QUERY_CHARS = 1_000;
const MAX_PROVIDER_BODY_BYTES = 1_000_000;
const MAX_RESULT_TITLE_CHARS = 500;
const MAX_RESULT_SNIPPET_CHARS = 2_000;
const MAX_RESULT_URL_CHARS = 4_096;
const MAX_PROVENANCE_MIME_CHARS = 255;
const MAX_PROVENANCE_HEADING_CHARS = 300;
const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;
const MAX_SEARCH_TIMEOUT_MS = 120_000;
const PROVIDER_TIMEOUT_MS = 20_000;
const PROVIDER_FAILURE_THRESHOLD = 3;
const PROVIDER_COOLDOWN_MS = 30_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_EVIDENCE_DOCUMENT_CHARS = 200_000;
const MAX_EVIDENCE_SOURCE_CHARS = 10_000;
const DEFAULT_EVIDENCE_TOTAL_CHARS = 50_000;
const MAX_EVIDENCE_TOTAL_CHARS = 100_000;
const MAX_EVIDENCE_CHUNKS_PER_SOURCE = 5;
const RESEARCH_JOB_TTL_MS = 30 * 60_000;
const MAX_RESEARCH_JOBS = 100;
const RRF_K = 60;

const SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'what',
  'when',
  'where',
  'which',
  'who',
  'with',
]);

const AUTHORITY_DOMAINS = [
  'apnews.com',
  'bbc.com',
  'developer.mozilla.org',
  'github.com',
  'ietf.org',
  'nodejs.org',
  'reuters.com',
  'stackoverflow.com',
  'typescriptlang.org',
  'w3.org',
  'wikipedia.org',
] as const;

export interface SearchOptions {
  query: string;
  provider?: SearchProviderName;
  maxResults?: number;
  fetchTop?: number;
  searxngUrl?: string;
  language?: string;
  safeSearch?: 0 | 1 | 2;
  timeRange?: 'day' | 'month' | 'year';
  timeoutMs?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface ResearchOptions {
  queries: string[];
  maxResultsPerQuery?: number;
  maxSources?: number;
  maxEvidenceChars?: number;
  timeoutMs?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  language?: string;
  safeSearch?: 0 | 1 | 2;
  timeRange?: 'day' | 'month' | 'year';
}

export type ProviderFailureKind =
  | 'unconfigured'
  | 'circuit_open'
  | 'rate_limited'
  | 'challenge'
  | 'transport'
  | 'timeout'
  | 'aborted'
  | 'parse'
  | 'irrelevant'
  | 'empty'
  | 'output_limit';

export interface SearchProviderFailure {
  provider: SearchProviderName;
  kind: ProviderFailureKind;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  engine?: string;
}

export interface ResearchFailure {
  stage: 'search' | 'evidence';
  message: string;
  query?: string;
  sourceUrl?: string;
  providerFailure?: SearchProviderFailure;
}

export interface SearchResponse {
  query: string;
  provider: SearchProviderName;
  providers: SearchProviderName[];
  results: SearchResult[];
  evidence?: EvidenceChunk[];
  failures?: SearchProviderFailure[];
  evidenceFailures?: ResearchFailure[];
  rateLimit?: SearchRateLimit;
}

export interface ResearchResponse {
  queries: string[];
  sources: SearchResult[];
  evidence: EvidenceChunk[];
  failures: ResearchFailure[];
}

export interface ResearchJob extends ResearchResponse {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ParsedSearchResult {
  title: string;
  url: string;
  snippet: string;
  providerScore?: number;
  engines?: string[];
  publishedAt?: string;
}

interface ProviderPayload {
  results: SearchResult[];
  failures: SearchProviderFailure[];
}

interface ProviderSearchSuccess {
  ok: true;
  provider: SearchProviderName;
  payload: ProviderPayload;
}

interface ProviderSearchFailureResult {
  ok: false;
  provider: SearchProviderName;
  failure: SearchProviderFailure;
}

type ProviderSearchAttempt = ProviderSearchSuccess | ProviderSearchFailureResult;

interface SearchSemantics {
  endpoint?: string;
  language?: string;
  safeSearch?: number;
  timeRange?: string;
}

interface SearchCacheEntry {
  expiresAt: number;
  payload: ProviderPayload;
}

interface ProviderStats {
  available: boolean;
  attempts: number;
  totalLatencyMs: number;
  errorCount: number;
  consecutiveFailures: number;
  halfOpen: boolean;
  circuitOpenUntilMs?: number;
  lastSuccess?: string;
  lastFailure?: string;
}

interface SingleflightEntry {
  controller: AbortController;
  promise: Promise<ProviderPayload>;
  waiters: number;
}

interface OperationScope {
  signal: AbortSignal;
  deadlineMs: number;
  cancel(reason: Error): void;
  cleanup(): void;
}

interface ActiveOperation {
  scope: OperationScope;
  done: Promise<void>;
  complete(): void;
}

class ProviderFailureError extends Error {
  constructor(readonly failure: SearchProviderFailure) {
    super(failure.message);
    this.name = 'ProviderFailureError';
  }
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<{
    signal?: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    onAbort?: () => void;
  }> = [];

  constructor(private readonly capacity: number) {}

  async run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve(this.releaseFunction());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: (typeof this.queue)[number] = { signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.queue.length > 0) {
        const waiter = this.queue.shift()!;
        if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
        if (waiter.signal?.aborted) {
          waiter.reject(abortError(waiter.signal));
          continue;
        }
        waiter.resolve(this.releaseFunction());
        return;
      }
      this.active -= 1;
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key].trim() : '';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function cloneFailure(failure: SearchProviderFailure): SearchProviderFailure {
  return { ...failure };
}

function cloneResult(result: SearchResult): SearchResult {
  return {
    ...result,
    ...(result.providers ? { providers: [...result.providers] } : {}),
    ...(result.providerRanks ? { providerRanks: { ...result.providerRanks } } : {}),
    ...(result.engines ? { engines: [...result.engines] } : {}),
    ...(result.queries ? { queries: [...result.queries] } : {}),
  };
}

function clonePayload(payload: ProviderPayload): ProviderPayload {
  return { results: payload.results.map(cloneResult), failures: payload.failures.map(cloneFailure) };
}

function normalizeQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function semanticFingerprint(semantics: SearchSemantics): string {
  return JSON.stringify(
    Object.entries(semantics)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function cacheKey(query: string, provider: SearchProviderName, semantics: SearchSemantics): string {
  return `${provider}:${normalizeQuery(query)}:${semanticFingerprint(semantics)}`;
}

export class SearchCache {
  private readonly entries = new Map<string, SearchCacheEntry>();

  constructor(
    private readonly maxEntries = SEARCH_CACHE_MAX_ENTRIES,
    private readonly ttlMs = SEARCH_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(query: string, provider: SearchProviderName, semantics: SearchSemantics = {}): SearchResult[] | undefined {
    return this.getPayload(query, provider, semantics)?.results;
  }

  set(query: string, provider: SearchProviderName, results: SearchResult[], semantics: SearchSemantics = {}): void {
    this.setPayload(query, provider, { results, failures: [] }, semantics);
  }

  getPayload(query: string, provider: SearchProviderName, semantics: SearchSemantics = {}): ProviderPayload | undefined {
    const key = cacheKey(query, provider, semantics);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return clonePayload(entry.payload);
  }

  setPayload(query: string, provider: SearchProviderName, payload: ProviderPayload, semantics: SearchSemantics = {}): void {
    const key = cacheKey(query, provider, semantics);
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, payload: clonePayload(payload) });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new TendrilError('CANCELLED', 'Operation cancelled', { retryable: true });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function operationScope(options: { signal?: AbortSignal; deadlineMs?: number; timeoutMs?: number }, defaultTimeoutMs: number): OperationScope {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? defaultTimeoutMs, MAX_SEARCH_TIMEOUT_MS));
  const deadlineMs = Math.min(options.deadlineMs ?? Number.POSITIVE_INFINITY, Date.now() + timeoutMs);
  const onAbort = (): void => {
    const reason = options.signal?.reason;
    controller.abort(
      reason instanceof TendrilError
        ? reason
        : new TendrilError('CANCELLED', reason instanceof Error ? reason.message : 'Operation cancelled', { retryable: true, cause: reason }),
    );
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(
    () => controller.abort(new TendrilError('TIMEOUT', 'Operation deadline exceeded', { retryable: true })),
    Math.max(0, deadlineMs - Date.now()),
  );
  timer.unref();
  return {
    signal: controller.signal,
    deadlineMs,
    cancel: (reason) => controller.abort(reason),
    cleanup: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function normalizeResultUrl(raw: string): string | undefined {
  try {
    if (raw.length > MAX_RESULT_URL_CHARS * 2) return undefined;
    let url = new URL(raw);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if ((hostname === 'duckduckgo.com' || hostname.endsWith('.duckduckgo.com')) && url.searchParams.has('uddg')) {
      url = new URL(url.searchParams.get('uddg')!);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || ['gclid', 'fbclid', 'msclkid', 'ved'].includes(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.hash = '';
    const normalized = url.toString();
    return normalized.length <= MAX_RESULT_URL_CHARS ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      normalizeSearchText(query)
        .split(' ')
        .filter((term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term)),
    ),
  ];
}

export function isOfficialMcpUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^www\./, '');
    if (hostname === 'modelcontextprotocol.io' || hostname.endsWith('.modelcontextprotocol.io')) return true;
    if (hostname !== 'github.com') return false;
    return url.pathname.split('/').filter(Boolean)[0]?.toLowerCase() === 'modelcontextprotocol';
  } catch {
    return false;
  }
}

function authorityScore(rawUrl: string, terms: string[]): number {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, '');
    const hasMcpIntent = terms.includes('mcp') || (terms.includes('model') && terms.includes('context') && terms.includes('protocol'));
    if (hasMcpIntent && isOfficialMcpUrl(rawUrl)) return 50;
    if (AUTHORITY_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) return 4;
    if (/\.(?:gov|edu)$/.test(hostname) || hostname.endsWith('.gov.uk') || hostname.endsWith('.ac.uk')) return 4;
  } catch {
    return 0;
  }
  return 0;
}

function termCoverage(result: Pick<SearchResult, 'title' | 'snippet'>, terms: string[]): number {
  const haystack = new Set(normalizeSearchText(`${result.title} ${result.snippet}`).split(' ').filter(Boolean));
  return terms.filter((term) => haystack.has(term)).length;
}

function relevanceScore(result: SearchResult, query: string): number {
  const terms = queryTerms(query);
  const title = normalizeSearchText(result.title);
  const snippet = normalizeSearchText(result.snippet);
  const titleTerms = new Set(title.split(' ').filter(Boolean));
  const snippetTerms = new Set(snippet.split(' ').filter(Boolean));
  const normalizedQuery = normalizeSearchText(query);
  return (
    terms.filter((term) => titleTerms.has(term)).length * 6 +
    terms.filter((term) => snippetTerms.has(term)).length * 2 +
    (normalizedQuery && title.includes(normalizedQuery) ? 10 : 0) +
    (normalizedQuery && snippet.includes(normalizedQuery) ? 3 : 0) +
    authorityScore(result.url, terms) +
    Math.min(2, Math.max(0, result.providerScore ?? 0))
  );
}

function hasRelevantResults(results: SearchResult[], query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return results.length > 0;
  const requiredMatches = terms.length >= 4 ? 2 : 1;
  return results.some((result) => termCoverage(result, terms) >= requiredMatches);
}

export function rankResults(results: SearchResult[], query: string): SearchResult[] {
  return results
    .map((result, index) => ({ result: cloneResult(result), index, relevance: relevanceScore(result, query) }))
    .sort(
      (left, right) =>
        right.relevance - left.relevance || left.result.rank - right.result.rank || left.index - right.index || left.result.url.localeCompare(right.result.url),
    )
    .map(({ result, relevance }, index) => ({ ...result, rank: index + 1, score: relevance }));
}

export function fuseResults(
  successes: Array<{ provider: SearchProviderName; results: SearchResult[] }>,
  query: string,
  providerOrder: SearchProviderName[],
  maxResults: number,
): SearchResult[] {
  interface Aggregate {
    representative: SearchResult;
    relevance: number;
    fusedScore: number;
    providerRanks: Partial<Record<SearchProviderName, number>>;
    providers: SearchProviderName[];
  }
  const order = new Map(providerOrder.map((provider, index) => [provider, index]));
  const aggregated = new Map<string, Aggregate>();
  for (const success of successes) {
    for (const result of success.results) {
      const canonical = normalizeResultUrl(result.url);
      if (!canonical) continue;
      const relevance = relevanceScore(result, query);
      const contribution = 1 / (RRF_K + Math.max(1, result.rank));
      const existing = aggregated.get(canonical);
      if (!existing) {
        aggregated.set(canonical, {
          representative: { ...cloneResult(result), url: canonical },
          relevance,
          fusedScore: contribution,
          providerRanks: { [success.provider]: result.rank },
          providers: [success.provider],
        });
        continue;
      }
      existing.fusedScore += contribution;
      existing.providerRanks[success.provider] = result.rank;
      if (!existing.providers.includes(success.provider)) existing.providers.push(success.provider);
      const representativeOrder = order.get(existing.representative.provider) ?? Number.MAX_SAFE_INTEGER;
      const candidateOrder = order.get(result.provider) ?? Number.MAX_SAFE_INTEGER;
      if (relevance > existing.relevance || (relevance === existing.relevance && candidateOrder < representativeOrder)) {
        existing.representative = { ...cloneResult(result), url: canonical };
        existing.relevance = relevance;
      }
    }
  }
  return [...aggregated.values()]
    .map((entry) => {
      entry.providers.sort((left, right) => (order.get(left) ?? 999) - (order.get(right) ?? 999));
      return { ...entry.representative, providers: entry.providers, providerRanks: entry.providerRanks, score: entry.fusedScore + entry.relevance / 100 };
    })
    .sort(
      (left, right) =>
        (right.score ?? 0) - (left.score ?? 0) ||
        (order.get(left.provider) ?? 999) - (order.get(right.provider) ?? 999) ||
        left.rank - right.rank ||
        left.url.localeCompare(right.url),
    )
    .slice(0, maxResults)
    .map((result, index) => ({ ...result, rank: index + 1, score: Number((result.score ?? 0).toFixed(6)) }));
}

function parseDuckDuckGoResponse(text: string): ParsedSearchResult[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderFailureError({ provider: 'duckduckgo', kind: 'parse', message: 'DuckDuckGo API returned invalid JSON', retryable: true });
  }
  if (!isRecord(payload))
    throw new ProviderFailureError({ provider: 'duckduckgo', kind: 'parse', message: 'DuckDuckGo API returned an invalid response', retryable: true });
  const parsed: ParsedSearchResult[] = [];
  const abstract = stringField(payload, 'AbstractText');
  const abstractUrl = stringField(payload, 'AbstractURL');
  if (abstract && abstractUrl) parsed.push({ title: stringField(payload, 'Heading') || abstract, url: abstractUrl, snippet: abstract });
  const collectTopics = (topics: unknown): void => {
    if (!Array.isArray(topics) || parsed.length >= MAX_SEARCH_RESULTS) return;
    for (const topic of topics) {
      if (!isRecord(topic)) continue;
      collectTopics(topic.Topics);
      const snippet = stringField(topic, 'Text');
      const url = stringField(topic, 'FirstURL');
      if (snippet && url) parsed.push({ title: snippet.split(' - ', 1)[0] ?? snippet, url, snippet });
      if (parsed.length >= MAX_SEARCH_RESULTS) break;
    }
  };
  collectTopics(payload.Results);
  collectTopics(payload.RelatedTopics);
  return parsed;
}

export function parseSearxngResponse(text: string): { results: ParsedSearchResult[]; failures: SearchProviderFailure[] } {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderFailureError({ provider: 'searxng', kind: 'parse', message: 'SearXNG returned invalid JSON', retryable: true });
  }
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new ProviderFailureError({ provider: 'searxng', kind: 'parse', message: 'SearXNG returned an invalid response', retryable: true });
  }
  const results: ParsedSearchResult[] = [];
  for (const item of payload.results.slice(0, MAX_SEARCH_RESULTS * 2)) {
    if (!isRecord(item)) continue;
    const title = stringField(item, 'title');
    const url = stringField(item, 'url');
    if (!title || !url) continue;
    const engines = Array.isArray(item.engines)
      ? item.engines
          .filter((engine): engine is string => typeof engine === 'string')
          .slice(0, 20)
          .map((engine) => truncate(engine, 100))
      : [];
    const publishedAt = stringField(item, 'publishedDate') || stringField(item, 'published_date');
    results.push({
      title,
      url,
      snippet: stringField(item, 'content'),
      ...(finiteNumber(item.score) !== undefined ? { providerScore: finiteNumber(item.score) } : {}),
      ...(engines.length > 0 ? { engines } : {}),
      ...(publishedAt ? { publishedAt: truncate(publishedAt, 100) } : {}),
    });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  const failures: SearchProviderFailure[] = [];
  if (Array.isArray(payload.unresponsive_engines)) {
    for (const entry of payload.unresponsive_engines.slice(0, 50)) {
      let engine = '';
      let message = '';
      if (Array.isArray(entry)) {
        engine = typeof entry[0] === 'string' ? entry[0] : '';
        message = typeof entry[1] === 'string' ? entry[1] : '';
      } else if (isRecord(entry)) {
        engine = stringField(entry, 'engine');
        message = stringField(entry, 'error') || stringField(entry, 'message');
      }
      failures.push({
        provider: 'searxng',
        kind: 'transport',
        retryable: true,
        message: truncate(message || 'SearXNG engine did not respond', 500),
        ...(engine ? { engine: truncate(engine, 100) } : {}),
      });
    }
  }
  return { results, failures };
}

function parseBingRss(text: string): ParsedSearchResult[] {
  const { document } = parseHTML(text);
  return [...document.querySelectorAll('item')].slice(0, MAX_SEARCH_RESULTS).map((node) => ({
    title: node.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    url: node.querySelector('link')?.textContent?.trim() ?? '',
    snippet: node.querySelector('description')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  }));
}

function parseDuckDuckGoHtml(text: string): ParsedSearchResult[] {
  if (/bots use duckduckgo|select all squares|anomaly-modal/i.test(text)) {
    throw new ProviderFailureError({ provider: 'duckduckgo', kind: 'challenge', message: 'DuckDuckGo returned a bot challenge', retryable: true });
  }
  const { document } = parseHTML(text);
  return [...document.querySelectorAll('.result')].slice(0, MAX_SEARCH_RESULTS).map((node) => ({
    title: node.querySelector('.result__title')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    url: (node.querySelector('a.result__a') as HTMLAnchorElement | null)?.href ?? '',
    snippet: node.querySelector('.result__snippet')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  }));
}

function retryAfterMs(headers: Record<string, string>, now = Date.now()): number | undefined {
  const value = headers['retry-after'];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function rateLimitFromFailure(failure: SearchProviderFailure): SearchRateLimit | undefined {
  if (failure.kind !== 'rate_limited') return undefined;
  return failure.retryAfterMs === undefined ? { provider: failure.provider } : { provider: failure.provider, retryAfterMs: failure.retryAfterMs };
}

function classifyProviderError(error: unknown, provider: SearchProviderName): SearchProviderFailure {
  if (error instanceof ProviderFailureError) return cloneFailure(error.failure);
  if (error instanceof TendrilError) {
    if (error.code === 'CANCELLED') return { provider, kind: 'aborted', message: error.message, retryable: true };
    if (error.code === 'TIMEOUT') return { provider, kind: 'timeout', message: error.message, retryable: true };
    if (error.code === 'OUTPUT_LIMIT') return { provider, kind: 'output_limit', message: error.message, retryable: false };
  }
  const record = isRecord(error) ? error : undefined;
  const embedded = record && isRecord(record.rateLimit) ? record.rateLimit : undefined;
  const status = finiteNumber(record?.status) ?? finiteNumber(record?.statusCode);
  const message = truncate(error instanceof Error ? error.message : String(error), 500);
  if (status === 429 || embedded || /\b429\b/.test(message)) {
    const retry = finiteNumber(embedded?.retryAfterMs) ?? finiteNumber(record?.retryAfterMs);
    return { provider, kind: 'rate_limited', message, retryable: true, ...(retry !== undefined ? { retryAfterMs: retry } : {}) };
  }
  if (/timeout|timed out/i.test(message)) return { provider, kind: 'timeout', message, retryable: true };
  if (/captcha|challenge|unusual traffic|bots use/i.test(message)) return { provider, kind: 'challenge', message, retryable: true };
  return { provider, kind: 'transport', message, retryable: true };
}

function providerUrl(provider: SearchProviderName, query: string, searxngUrl?: string): string {
  if (provider === 'duckduckgo') return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  if (provider === 'bing') return `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  if (provider === 'google') throw new TendrilError('CONFIGURATION_ERROR', 'Google search must use the Custom Search JSON API');
  if (!searxngUrl) throw new TendrilError('CONFIGURATION_ERROR', 'searxngUrl is required for the SearXNG provider');
  let base: URL;
  try {
    base = new URL(searxngUrl);
  } catch (error) {
    throw new TendrilError('CONFIGURATION_ERROR', 'searxngUrl must be a valid URL', { cause: error });
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new TendrilError('CONFIGURATION_ERROR', 'searxngUrl must be an HTTP(S) URL without embedded credentials');
  }
  const basePath = base.pathname.replace(/\/$/, '');
  base.pathname = basePath.endsWith('/search') ? basePath : `${basePath}/search`;
  base.search = '';
  base.hash = '';
  base.searchParams.set('q', query);
  base.searchParams.set('format', 'json');
  return base.toString();
}

function normalizeParsedResults(parsed: ParsedSearchResult[], provider: SearchProviderName, query: string): SearchResult[] {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const item of parsed) {
    const url = normalizeResultUrl(item.url);
    const title = truncate(item.title.replace(/\s+/g, ' ').trim(), MAX_RESULT_TITLE_CHARS);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    results.push({
      rank: results.length + 1,
      title,
      url,
      snippet: truncate(item.snippet.replace(/\s+/g, ' ').trim(), MAX_RESULT_SNIPPET_CHARS),
      provider,
      ...(item.providerScore !== undefined ? { providerScore: item.providerScore } : {}),
      ...(item.engines && item.engines.length > 0 ? { engines: [...item.engines] } : {}),
      ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  if (results.length === 0)
    throw new ProviderFailureError({ provider, kind: 'empty', message: `${provider} returned no recognizable results`, retryable: true });
  if (!hasRelevantResults(results, query))
    throw new ProviderFailureError({ provider, kind: 'irrelevant', message: `${provider} results did not cover the query terms`, retryable: true });
  return rankResults(results, query);
}

function canonicalDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return rawUrl;
  }
}

export function allocateResearchSources(perQuery: Array<{ query: string; results: SearchResult[] }>, maxSources: number): SearchResult[] {
  const selected: SearchResult[] = [];
  const selectedByUrl = new Map<string, SearchResult>();
  const usedDomains = new Set<string>();
  while (selected.length < maxSources) {
    let progressed = false;
    for (const group of perQuery) {
      for (const candidate of group.results) {
        const canonical = normalizeResultUrl(candidate.url) ?? candidate.url;
        const existing = selectedByUrl.get(canonical);
        if (existing) {
          existing.queries ??= [];
          if (!existing.queries.includes(group.query)) existing.queries.push(group.query);
        }
      }
      const unusedDomain = group.results.find((candidate) => {
        const canonical = normalizeResultUrl(candidate.url) ?? candidate.url;
        return !selectedByUrl.has(canonical) && !usedDomains.has(canonicalDomain(canonical));
      });
      const candidate = unusedDomain ?? group.results.find((item) => !selectedByUrl.has(normalizeResultUrl(item.url) ?? item.url));
      if (!candidate) continue;
      const canonical = normalizeResultUrl(candidate.url) ?? candidate.url;
      const source = { ...cloneResult(candidate), url: canonical, queries: [group.query] };
      selected.push(source);
      selectedByUrl.set(canonical, source);
      usedDomains.add(canonicalDomain(canonical));
      progressed = true;
      if (selected.length >= maxSources) break;
    }
    if (!progressed) break;
  }
  return selected;
}

function evidenceParagraphs(markdown: string, query: string): Array<{ heading?: string; text: string; score: number; index: number }> {
  const terms = queryTerms(query);
  const chunks: Array<{ heading?: string; text: string; score: number; index: number }> = [];
  let heading: string | undefined;
  let index = 0;
  for (const block of markdown.split(/\n{2,}/)) {
    const text = block.trim();
    if (!text) continue;
    const headingMatch = text.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      heading = truncate(headingMatch[1]!.trim(), 300);
      continue;
    }
    if (text.length < 80) continue;
    const normalized = new Set(
      normalizeSearchText(`${heading ?? ''} ${text}`)
        .split(' ')
        .filter(Boolean),
    );
    const score = terms.filter((term) => normalized.has(term)).length;
    chunks.push({ ...(heading ? { heading } : {}), text, score, index: index++ });
  }
  return chunks.sort((left, right) => right.score - left.score || left.index - right.index);
}

export class SearchService {
  private readonly providerStats = new Map<SearchProviderName, ProviderStats>();
  private readonly singleflight = new Map<string, SingleflightEntry>();
  private readonly providerLimiters = new Map<SearchProviderName, Semaphore>();
  private readonly activeOperations = new Set<ActiveOperation>();
  private readonly researchJobs = new Map<string, ResearchJob>();
  private readonly providerLimiter: Semaphore;
  private readonly evidenceLimiter: Semaphore;
  private closePromise?: Promise<void>;
  private closing = false;

  constructor(
    private readonly manager: BrowserManager,
    private readonly logger: Logger,
    private readonly cache = new SearchCache(),
    private readonly now: () => number = Date.now,
  ) {
    const sessionCapacity = Math.max(1, Math.min(4, manager.config.maxSessions ?? 4));
    this.providerLimiter = new Semaphore(sessionCapacity);
    this.evidenceLimiter = new Semaphore(Math.max(1, Math.min(3, sessionCapacity)));
  }

  getProviderHealth(): SearchProviderHealth[];
  getProviderHealth(provider: SearchProviderName): SearchProviderHealth;
  getProviderHealth(provider?: SearchProviderName): SearchProviderHealth | SearchProviderHealth[] {
    if (provider) return this.providerHealth(provider);
    const providers = [...new Set([...this.manager.config.searchProviders, ...this.providerStats.keys()])];
    return providers.map((name) => this.providerHealth(name));
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closing = true;
      const operations = [...this.activeOperations];
      const reason = new TendrilError('CANCELLED', 'Search service is shutting down', { retryable: true });
      for (const operation of operations) operation.scope.cancel(reason);
      await Promise.allSettled(operations.map((operation) => operation.done));
    })();
    return this.closePromise;
  }

  getResearchJob(id: string): ResearchJob {
    this.pruneResearchJobs();
    const job = this.researchJobs.get(id);
    if (!job) throw new TendrilError('SEARCH_FAILED', `Research job not found or expired: ${id}`);
    return structuredClone(job);
  }

  async startResearchJob(options: ResearchOptions): Promise<ResearchJob> {
    const researched = await this.research(options);
    const timestamp = new Date(this.now()).toISOString();
    return this.storeResearchJob({
      id: newId('research'),
      ...researched,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(this.now() + RESEARCH_JOB_TTL_MS).toISOString(),
    });
  }

  async refineResearchJob(id: string, options: ResearchOptions): Promise<ResearchJob> {
    const previous = this.getResearchJob(id);
    const followUp = await this.research(options);
    const maxSources = Math.max(1, Math.min(options.maxSources ?? 10, 30));
    const sourcesByUrl = new Map<string, SearchResult>();
    for (const candidate of [...previous.sources, ...followUp.sources]) {
      const canonical = normalizeResultUrl(candidate.url) ?? candidate.url;
      const existing = sourcesByUrl.get(canonical);
      if (existing) {
        existing.queries = [...new Set([...(existing.queries ?? []), ...(candidate.queries ?? [])])];
        existing.providers = [...new Set([...(existing.providers ?? [existing.provider]), ...(candidate.providers ?? [candidate.provider])])];
      } else sourcesByUrl.set(canonical, { ...cloneResult(candidate), url: canonical });
    }
    const sources = [...sourcesByUrl.values()].slice(0, maxSources);
    const retainedUrls = new Set(sources.map((source) => source.url));
    const combinedEvidence = [
      ...new Map(
        [...previous.evidence, ...followUp.evidence]
          .filter((entry) => retainedUrls.has(entry.sourceUrl) || retainedUrls.has(entry.canonicalUrl))
          .map((entry) => [`${entry.citationId}\0${entry.text}`, entry]),
      ).values(),
    ];
    const maxEvidenceChars = Math.max(1, Math.min(options.maxEvidenceChars ?? DEFAULT_EVIDENCE_TOTAL_CHARS, MAX_EVIDENCE_TOTAL_CHARS));
    const evidence = this.boundEvidence(combinedEvidence, maxEvidenceChars);
    const updatedAt = new Date(this.now()).toISOString();
    return this.storeResearchJob({
      id: previous.id,
      queries: [...new Set([...previous.queries, ...followUp.queries])],
      sources,
      evidence,
      failures: [...previous.failures, ...followUp.failures].slice(-200),
      createdAt: previous.createdAt,
      updatedAt,
      expiresAt: new Date(this.now() + RESEARCH_JOB_TTL_MS).toISOString(),
    });
  }

  async search(options: SearchOptions): Promise<SearchResponse> {
    const query = options.query?.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!query || query.length > MAX_QUERY_CHARS) throw new TendrilError('SEARCH_FAILED', `query must contain 1-${MAX_QUERY_CHARS} characters`);
    if (options.searxngUrl && options.searxngUrl !== this.manager.config.searxngUrl) {
      throw new TendrilError('CONFIGURATION_ERROR', 'Per-call SearXNG endpoint overrides are not allowed');
    }
    const maxResults = Math.max(1, Math.min(options.maxResults ?? 10, MAX_SEARCH_RESULTS));
    const operation = this.startOperation(options, DEFAULT_SEARCH_TIMEOUT_MS);
    const { scope } = operation;
    try {
      throwIfAborted(scope.signal);
      const configured = options.provider ? [options.provider] : this.manager.config.searchProviders;
      const providers = [...new Set(configured)];
      const failures: SearchProviderFailure[] = [];
      const eligible: SearchProviderName[] = [];
      for (const provider of providers) {
        if (this.isConfigured(provider)) eligible.push(provider);
        else failures.push({ provider, kind: 'unconfigured', message: `${provider} is not configured`, retryable: false });
      }
      const endpoint = this.manager.config.searxngUrl;
      const semantics: SearchSemantics = {
        ...(endpoint ? { endpoint } : {}),
        ...(options.language ? { language: options.language } : {}),
        ...(options.safeSearch !== undefined ? { safeSearch: options.safeSearch } : {}),
        ...(options.timeRange ? { timeRange: options.timeRange } : {}),
      };
      const attempts = await Promise.all(eligible.map((provider) => this.tryProvider(query, provider, semantics, scope.signal, scope.deadlineMs)));
      throwIfAborted(scope.signal);
      const successes: ProviderSearchSuccess[] = [];
      for (const attempt of attempts) {
        if (attempt.ok) {
          successes.push(attempt);
          failures.push(...attempt.payload.failures);
        } else failures.push(attempt.failure);
      }
      if (successes.length === 0) {
        const rateLimited = failures.find((failure) => failure.kind === 'rate_limited');
        if (rateLimited)
          return {
            query,
            provider: rateLimited.provider,
            providers: [],
            results: [],
            failures,
            rateLimit: rateLimitFromFailure(rateLimited),
          };
        throw new TendrilError(
          'SEARCH_FAILED',
          `All search providers failed: ${failures.map((failure) => `${failure.provider}/${failure.kind}: ${failure.message}`).join('; ')}`,
          {
            details: { failures },
            retryable: failures.some((failure) => failure.retryable),
          },
        );
      }
      const results = fuseResults(
        successes.map((success) => ({ provider: success.provider, results: success.payload.results })),
        query,
        eligible,
        maxResults,
      );
      if (results.length === 0) throw new TendrilError('SEARCH_FAILED', 'Search providers returned no valid HTTP(S) results', { retryable: true });
      const response: SearchResponse = {
        query,
        provider: results[0]!.provider,
        providers: successes.map((success) => success.provider),
        results,
      };
      if (failures.length > 0) response.failures = failures;
      const rateLimited = failures.find((failure) => failure.kind === 'rate_limited');
      if (rateLimited) response.rateLimit = rateLimitFromFailure(rateLimited);
      const fetchTop = Math.max(0, Math.min(options.fetchTop ?? 0, 10));
      if (fetchTop > 0) {
        const sources = results.slice(0, fetchTop).map((result) => ({ ...cloneResult(result), queries: [query] }));
        const fetched = await this.fetchEvidence(sources, scope.signal, scope.deadlineMs, DEFAULT_EVIDENCE_TOTAL_CHARS);
        response.evidence = fetched.evidence;
        if (fetched.failures.length > 0) response.evidenceFailures = fetched.failures;
      }
      return response;
    } finally {
      operation.complete();
    }
  }

  async research(options: ResearchOptions): Promise<ResearchResponse> {
    const queries = [
      ...new Set(
        options.queries
          .slice(0, 10)
          .map((query) => query.normalize('NFKC').trim().replace(/\s+/g, ' '))
          .filter((query) => query.length > 0 && query.length <= MAX_QUERY_CHARS),
      ),
    ];
    if (queries.length === 0) throw new TendrilError('SEARCH_FAILED', 'At least one valid research query is required');
    const operation = this.startOperation(options, MAX_SEARCH_TIMEOUT_MS);
    const { scope } = operation;
    const failures: ResearchFailure[] = [];
    try {
      const searched = await Promise.all(
        queries.map(async (query) => {
          try {
            const response = await this.search({
              query,
              maxResults: Math.max(1, Math.min(options.maxResultsPerQuery ?? 5, 10)),
              signal: scope.signal,
              deadlineMs: scope.deadlineMs,
              language: options.language,
              safeSearch: options.safeSearch,
              timeRange: options.timeRange,
            });
            return {
              query,
              results: response.results,
              failures: (response.failures ?? []).map(
                (failure): ResearchFailure => ({
                  stage: 'search',
                  query,
                  message: failure.message,
                  providerFailure: failure,
                }),
              ),
            };
          } catch (error) {
            throwIfAborted(scope.signal);
            return {
              query,
              results: [],
              failures: [{ stage: 'search' as const, query, message: error instanceof Error ? error.message : String(error) }],
            };
          }
        }),
      );
      throwIfAborted(scope.signal);
      for (const group of searched) failures.push(...group.failures);
      const sources = allocateResearchSources(searched, Math.max(1, Math.min(options.maxSources ?? 10, 30)));
      const maxEvidenceChars = Math.max(1, Math.min(options.maxEvidenceChars ?? DEFAULT_EVIDENCE_TOTAL_CHARS, MAX_EVIDENCE_TOTAL_CHARS));
      const fetched = await this.fetchEvidence(sources, scope.signal, scope.deadlineMs, maxEvidenceChars);
      failures.push(...fetched.failures);
      return { queries, sources, evidence: fetched.evidence, failures };
    } finally {
      operation.complete();
    }
  }

  private startOperation(options: { signal?: AbortSignal; deadlineMs?: number; timeoutMs?: number }, defaultTimeoutMs: number): ActiveOperation {
    if (this.closing) throw new TendrilError('CANCELLED', 'Search service is shutting down', { retryable: true });
    const scope = operationScope(options, defaultTimeoutMs);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let completed = false;
    const operation: ActiveOperation = {
      scope,
      done,
      complete: () => {
        if (completed) return;
        completed = true;
        scope.cleanup();
        this.activeOperations.delete(operation);
        resolveDone();
      },
    };
    this.activeOperations.add(operation);
    return operation;
  }

  private storeResearchJob(job: ResearchJob): ResearchJob {
    this.pruneResearchJobs();
    this.researchJobs.delete(job.id);
    this.researchJobs.set(job.id, structuredClone(job));
    while (this.researchJobs.size > MAX_RESEARCH_JOBS) {
      const oldest = this.researchJobs.keys().next().value;
      if (oldest === undefined) break;
      this.researchJobs.delete(oldest);
    }
    return structuredClone(job);
  }

  private pruneResearchJobs(): void {
    const now = this.now();
    for (const [id, job] of this.researchJobs) {
      if (Date.parse(job.expiresAt) <= now) this.researchJobs.delete(id);
    }
  }

  private boundEvidence(chunks: EvidenceChunk[], maxChars: number): EvidenceChunk[] {
    const bounded: EvidenceChunk[] = [];
    let remaining = maxChars;
    for (const chunk of chunks) {
      if (remaining <= 0) break;
      if (chunk.text.length <= remaining) {
        bounded.push(structuredClone(chunk));
        remaining -= chunk.text.length;
        continue;
      }
      const text = chunk.text.slice(0, remaining);
      bounded.push({
        ...structuredClone(chunk),
        text,
        truncated: true,
        citationId: `cite_${hashText(`${chunk.canonicalUrl}\0${chunk.query}\0${chunk.heading ?? ''}\0${text}`).slice(0, 20)}`,
      });
      remaining = 0;
    }
    return bounded;
  }

  private isConfigured(provider: SearchProviderName): boolean {
    if (provider === 'google') return Boolean(this.manager.config.googleSearchApiKey && this.manager.config.googleSearchCx);
    if (provider === 'searxng') return Boolean(this.manager.config.searxngUrl);
    return true;
  }

  private async tryProvider(
    query: string,
    provider: SearchProviderName,
    semantics: SearchSemantics,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<ProviderSearchAttempt> {
    try {
      const payload = await this.getSearchResults(query, provider, semantics, signal, deadlineMs);
      return { ok: true, provider, payload };
    } catch (error) {
      const failure = classifyProviderError(error, provider);
      this.logger.warn('Search provider failed', { provider, kind: failure.kind, error: failure.message });
      return { ok: false, provider, failure };
    }
  }

  private async getSearchResults(
    query: string,
    provider: SearchProviderName,
    semantics: SearchSemantics,
    signal: AbortSignal,
    _deadlineMs: number,
  ): Promise<ProviderPayload> {
    const cached = this.cache.getPayload(query, provider, semantics);
    if (cached) {
      this.logger.debug('Search cache hit', { provider, query });
      return cached;
    }
    const key = cacheKey(query, provider, semantics);
    let flight = this.singleflight.get(key);
    if (!flight) {
      const controller = new AbortController();
      const promise = this.executeProvider(query, provider, semantics, controller.signal, Date.now() + PROVIDER_TIMEOUT_MS);
      flight = { controller, promise, waiters: 0 };
      this.singleflight.set(key, flight);
      promise.then(
        () => {
          if (this.singleflight.get(key) === flight) this.singleflight.delete(key);
        },
        () => {
          if (this.singleflight.get(key) === flight) this.singleflight.delete(key);
        },
      );
    } else this.logger.debug('Joining in-flight search', { provider, query });
    flight.waiters += 1;
    try {
      return await waitForPromise(flight.promise, signal);
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && this.singleflight.get(key) === flight) {
        flight.controller.abort(new TendrilError('CANCELLED', 'No search callers remain'));
        // The last cancelled waiter owns cleanup of the shared upstream operation.
        await flight.promise.catch(() => undefined);
      }
    }
  }

  private async executeProvider(
    query: string,
    provider: SearchProviderName,
    semantics: SearchSemantics,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<ProviderPayload> {
    const circuitFailure = this.beginProviderAttempt(provider);
    if (circuitFailure) throw new ProviderFailureError(circuitFailure);
    const startedAt = this.now();
    try {
      const providerSemaphore = this.providerLimiters.get(provider) ?? new Semaphore(2);
      this.providerLimiters.set(provider, providerSemaphore);
      const payload = await providerSemaphore.run(signal, () =>
        this.providerLimiter.run(signal, () => this.searchWithProvider(query, provider, MAX_SEARCH_RESULTS, semantics, signal, deadlineMs)),
      );
      const normalized = { results: normalizeParsedResults(payload.results, provider, query), failures: payload.failures };
      this.recordProviderSuccess(provider, Math.max(0, this.now() - startedAt));
      this.cache.setPayload(query, provider, normalized, semantics);
      return clonePayload(normalized);
    } catch (error) {
      const failure = classifyProviderError(error, provider);
      this.recordProviderFailure(provider, failure, Math.max(0, this.now() - startedAt));
      throw new ProviderFailureError(failure);
    }
  }

  private beginProviderAttempt(provider: SearchProviderName): SearchProviderFailure | undefined {
    const stats = this.providerStats.get(provider);
    if (!stats?.circuitOpenUntilMs) return undefined;
    const remaining = stats.circuitOpenUntilMs - this.now();
    if (remaining > 0 || stats.halfOpen)
      return {
        provider,
        kind: 'circuit_open',
        retryable: true,
        message: remaining > 0 ? `${provider} circuit is open` : `${provider} half-open probe is already running`,
        retryAfterMs: Math.max(0, remaining),
      };
    stats.halfOpen = true;
    return undefined;
  }

  private recordProviderSuccess(provider: SearchProviderName, latencyMs: number): void {
    const previous = this.providerStats.get(provider);
    this.providerStats.set(provider, {
      available: true,
      attempts: (previous?.attempts ?? 0) + 1,
      totalLatencyMs: (previous?.totalLatencyMs ?? 0) + latencyMs,
      errorCount: previous?.errorCount ?? 0,
      consecutiveFailures: 0,
      halfOpen: false,
      lastSuccess: new Date(this.now()).toISOString(),
      ...(previous?.lastFailure ? { lastFailure: previous.lastFailure } : {}),
    });
  }

  private recordProviderFailure(provider: SearchProviderName, failure: SearchProviderFailure, latencyMs: number): void {
    if (failure.kind === 'aborted') {
      const current = this.providerStats.get(provider);
      if (current?.halfOpen) current.halfOpen = false;
      return;
    }
    if (failure.kind === 'circuit_open' || failure.kind === 'unconfigured') return;
    const previous = this.providerStats.get(provider);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const retryAfter =
      failure.kind === 'rate_limited'
        ? (failure.retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS)
        : consecutiveFailures >= PROVIDER_FAILURE_THRESHOLD
          ? PROVIDER_COOLDOWN_MS
          : undefined;
    this.providerStats.set(provider, {
      available: false,
      attempts: (previous?.attempts ?? 0) + 1,
      totalLatencyMs: (previous?.totalLatencyMs ?? 0) + latencyMs,
      errorCount: (previous?.errorCount ?? 0) + 1,
      consecutiveFailures,
      halfOpen: false,
      ...(retryAfter !== undefined ? { circuitOpenUntilMs: this.now() + retryAfter } : {}),
      lastFailure: new Date(this.now()).toISOString(),
      ...(previous?.lastSuccess ? { lastSuccess: previous.lastSuccess } : {}),
    });
  }

  private providerHealth(provider: SearchProviderName): SearchProviderHealth {
    const configured = this.isConfigured(provider);
    const stats = this.providerStats.get(provider);
    if (!stats) return { provider, available: configured, errorCount: 0, consecutiveFailures: 0 };
    const open = stats.circuitOpenUntilMs !== undefined && stats.circuitOpenUntilMs > this.now();
    return {
      provider,
      available: configured && stats.available && !open,
      errorCount: stats.errorCount,
      consecutiveFailures: stats.consecutiveFailures,
      averageLatencyMs: stats.attempts > 0 ? stats.totalLatencyMs / stats.attempts : undefined,
      ...(stats.lastSuccess ? { lastSuccess: stats.lastSuccess } : {}),
      ...(stats.lastFailure ? { lastFailure: stats.lastFailure } : {}),
      ...(open ? { circuitOpenUntil: new Date(stats.circuitOpenUntilMs!).toISOString() } : {}),
    };
  }

  private async searchWithProvider(
    query: string,
    provider: SearchProviderName,
    maxResults: number,
    semantics: SearchSemantics,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<{ results: ParsedSearchResult[]; failures: SearchProviderFailure[] }> {
    throwIfAborted(signal);
    const session = await this.manager.create();
    try {
      throwIfAborted(signal);
      if (provider === 'searxng') {
        const url = new URL(providerUrl(provider, query, semantics.endpoint));
        if (semantics.language) url.searchParams.set('language', semantics.language);
        if (semantics.safeSearch !== undefined) url.searchParams.set('safesearch', String(semantics.safeSearch));
        if (semantics.timeRange) url.searchParams.set('time_range', semantics.timeRange);
        const response = await session.fetchText(url.toString(), undefined, {
          signal,
          deadlineMs,
          maxBytes: MAX_PROVIDER_BODY_BYTES,
          accept: 'application/json',
        });
        this.assertProviderStatus(provider, response.status, response.headers);
        return parseSearxngResponse(response.text);
      }
      if (provider === 'google') return { results: await this.searchGoogle(session, query, maxResults, signal, deadlineMs), failures: [] };
      if (provider === 'duckduckgo') return { results: await this.searchDuckDuckGo(session, query, signal, deadlineMs), failures: [] };
      const response = await session.fetchText(providerUrl(provider, query), undefined, {
        signal,
        deadlineMs,
        maxBytes: MAX_PROVIDER_BODY_BYTES,
        accept: 'application/rss+xml, application/xml, text/xml',
      });
      this.assertProviderStatus(provider, response.status, response.headers);
      return { results: parseBingRss(response.text), failures: [] };
    } finally {
      await this.manager
        .close(session.id)
        .catch((error) => this.logger.warn('Failed to close search session', { sessionId: session.id, error: String(error) }));
    }
  }

  private assertProviderStatus(provider: SearchProviderName, status: number | null, headers: Record<string, string>): void {
    if (status === 429) {
      const retry = retryAfterMs(headers, this.now());
      throw new ProviderFailureError({
        provider,
        kind: 'rate_limited',
        message: `${provider} returned HTTP 429`,
        retryable: true,
        ...(retry !== undefined ? { retryAfterMs: retry } : {}),
      });
    }
    if (status === null || status < 200 || status >= 300) {
      throw new ProviderFailureError({
        provider,
        kind: 'transport',
        message: `${provider} returned HTTP ${status ?? 'unknown'}`,
        retryable: status === null || status >= 500,
      });
    }
  }

  private async searchDuckDuckGo(session: TendrilSession, query: string, signal: AbortSignal, deadlineMs: number): Promise<ParsedSearchResult[]> {
    const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    try {
      const response = await session.fetchText(apiUrl, undefined, { signal, deadlineMs, maxBytes: MAX_PROVIDER_BODY_BYTES, accept: 'application/json' });
      this.assertProviderStatus('duckduckgo', response.status, response.headers);
      const parsed = parseDuckDuckGoResponse(response.text);
      if (parsed.length > 0) {
        normalizeParsedResults(parsed, 'duckduckgo', query);
        return parsed;
      }
    } catch (error) {
      const failure = classifyProviderError(error, 'duckduckgo');
      if (failure.kind === 'rate_limited' || failure.kind === 'aborted' || failure.kind === 'timeout') throw error;
      this.logger.warn('DuckDuckGo API failed; falling back to HTML search', { kind: failure.kind, error: failure.message });
    }
    const response = await session.fetchText(providerUrl('duckduckgo', query), undefined, {
      signal,
      deadlineMs,
      maxBytes: MAX_PROVIDER_BODY_BYTES,
      accept: 'text/html',
    });
    this.assertProviderStatus('duckduckgo', response.status, response.headers);
    return parseDuckDuckGoHtml(response.text);
  }

  private async searchGoogle(
    session: TendrilSession,
    query: string,
    maxResults: number,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<ParsedSearchResult[]> {
    const key = this.manager.config.googleSearchApiKey;
    const cx = this.manager.config.googleSearchCx;
    if (!key || !cx) throw new ProviderFailureError({ provider: 'google', kind: 'unconfigured', message: 'Google search is not configured', retryable: false });
    const parsed: ParsedSearchResult[] = [];
    while (parsed.length < maxResults) {
      throwIfAborted(signal);
      const count = Math.min(maxResults - parsed.length, 10);
      const url = new URL('https://www.googleapis.com/customsearch/v1');
      url.searchParams.set('key', key);
      url.searchParams.set('cx', cx);
      url.searchParams.set('q', query);
      url.searchParams.set('num', String(count));
      url.searchParams.set('start', String(parsed.length + 1));
      const response = await session.fetchText(url.toString(), undefined, {
        signal,
        deadlineMs,
        maxBytes: MAX_PROVIDER_BODY_BYTES,
        accept: 'application/json',
      });
      this.assertProviderStatus('google', response.status, response.headers);
      let payload: unknown;
      try {
        payload = JSON.parse(response.text) as unknown;
      } catch {
        throw new ProviderFailureError({ provider: 'google', kind: 'parse', message: 'Google Custom Search API returned invalid JSON', retryable: true });
      }
      if (!isRecord(payload))
        throw new ProviderFailureError({
          provider: 'google',
          kind: 'parse',
          message: 'Google Custom Search API returned an invalid response',
          retryable: true,
        });
      if (!Array.isArray(payload.items)) break;
      const previousLength = parsed.length;
      for (const item of payload.items) {
        if (!isRecord(item)) continue;
        const title = stringField(item, 'title');
        const itemUrl = stringField(item, 'link');
        if (title && itemUrl) parsed.push({ title, url: itemUrl, snippet: stringField(item, 'snippet') });
      }
      if (parsed.length - previousLength < count) break;
    }
    return parsed;
  }

  private async fetchEvidence(
    sources: SearchResult[],
    signal: AbortSignal,
    deadlineMs: number,
    maxEvidenceChars: number,
  ): Promise<{ evidence: EvidenceChunk[]; failures: ResearchFailure[] }> {
    const tasks = sources.map((source) =>
      this.evidenceLimiter.run(signal, async () => {
        let session: TendrilSession | undefined;
        let abortClose: Promise<void> | undefined;
        const onAbort = (): void => {
          if (session && !abortClose) abortClose = session.close().catch(() => undefined);
        };
        try {
          throwIfAborted(signal);
          session = await this.manager.create();
          signal.addEventListener('abort', onAbort, { once: true });
          throwIfAborted(signal);
          const navigation = await session.navigate({ url: source.url, waitUntil: 'domcontentloaded', signal, deadlineMs });
          if (navigation.status !== null && navigation.status >= 400) throw new Error(`Evidence source returned HTTP ${navigation.status}`);
          throwIfAborted(signal);
          const extracted = await session.extract({ format: 'markdown' });
          throwIfAborted(signal);
          if (typeof extracted !== 'string') throw new Error('Evidence extraction did not return Markdown');
          const documentTruncated = extracted.length > MAX_EVIDENCE_DOCUMENT_CHARS;
          const markdown = extracted.slice(0, MAX_EVIDENCE_DOCUMENT_CHARS);
          const query = truncate(source.queries?.[0] ?? '', MAX_QUERY_CHARS);
          const sourceUrl = truncate(source.url, MAX_RESULT_URL_CHARS);
          const canonicalUrl = normalizeResultUrl(source.url) ?? sourceUrl;
          const finalUrl = normalizeResultUrl(navigation.url) ?? canonicalUrl;
          const title = truncate(navigation.title || source.title, MAX_RESULT_TITLE_CHARS);
          const rawMimeType = (navigation.mimeType ?? 'text/html')
            .replace(/[\u0000-\u001f\u007f]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const mimeType = truncate(rawMimeType || 'text/html', MAX_PROVENANCE_MIME_CHARS);
          const contentHash = hashText(markdown);
          const retrievedAt = new Date(this.now()).toISOString();
          let sourceChars = 0;
          const evidence: EvidenceChunk[] = [];
          const candidates = evidenceParagraphs(markdown, query);
          if (candidates.length === 0 && markdown.trim()) candidates.push({ text: markdown.trim(), score: 0, index: 0 });
          for (const chunk of candidates.slice(0, MAX_EVIDENCE_CHUNKS_PER_SOURCE)) {
            const remaining = MAX_EVIDENCE_SOURCE_CHARS - sourceChars;
            if (remaining <= 0) break;
            const text = truncate(chunk.text, Math.min(2_500, remaining));
            sourceChars += text.length;
            const heading = chunk.heading ? truncate(chunk.heading, MAX_PROVENANCE_HEADING_CHARS) : undefined;
            const citationId = `cite_${hashText(`${canonicalUrl}\0${query}\0${heading ?? ''}\0${text}`).slice(0, 20)}`;
            evidence.push({
              citationId,
              sourceUrl,
              canonicalUrl,
              finalUrl,
              title,
              text,
              ...(heading ? { heading } : {}),
              query,
              provider: source.provider,
              rank: source.rank,
              status: navigation.status,
              mimeType,
              retrievedAt,
              contentHash,
              ...(documentTruncated || text.length < chunk.text.length ? { truncated: true } : {}),
            });
          }
          return { evidence, failure: undefined };
        } catch (error) {
          throwIfAborted(signal);
          return {
            evidence: [],
            failure: {
              stage: 'evidence' as const,
              sourceUrl: source.url,
              query: source.queries?.[0],
              message: error instanceof Error ? error.message : String(error),
            },
          };
        } finally {
          signal.removeEventListener('abort', onAbort);
          if (abortClose) await abortClose;
          if (session) await this.manager.close(session.id).catch(() => undefined);
        }
      }),
    );
    const settled = await Promise.allSettled(tasks);
    throwIfAborted(signal);
    const fetched = settled.map((item, index) =>
      item.status === 'fulfilled'
        ? item.value
        : {
            evidence: [],
            failure: {
              stage: 'evidence' as const,
              sourceUrl: sources[index]?.url,
              query: sources[index]?.queries?.[0],
              message: item.reason instanceof Error ? item.reason.message : String(item.reason),
            },
          },
    );
    const evidence: EvidenceChunk[] = [];
    const failures: ResearchFailure[] = [];
    let remaining = maxEvidenceChars;
    for (const item of fetched) {
      if (item.failure) failures.push(item.failure);
      for (const chunk of item.evidence) {
        if (remaining <= 0) break;
        if (chunk.text.length <= remaining) {
          evidence.push(chunk);
          remaining -= chunk.text.length;
          continue;
        }
        const text = chunk.text.slice(0, remaining);
        if (text.length > 0)
          evidence.push({
            ...chunk,
            text,
            truncated: true,
            citationId: `cite_${hashText(`${chunk.canonicalUrl}\0${chunk.query}\0${chunk.heading ?? ''}\0${text}`).slice(0, 20)}`,
          });
        remaining = 0;
      }
    }
    return { evidence, failures };
  }
}
