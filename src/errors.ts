export type TendrilErrorCode =
  | 'CONFIGURATION_ERROR'
  | 'INVALID_ARGUMENT'
  | 'NETWORK_ERROR'
  | 'BROWSER_DISCONNECTED'
  | 'INTERNAL_ERROR'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_LIMIT_REACHED'
  | 'PROFILE_IN_USE'
  | 'PAGE_NOT_FOUND'
  | 'STALE_ELEMENT_REF'
  | 'INVALID_CURSOR'
  | 'NETWORK_BLOCKED'
  | 'INVALID_URL'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'OUTPUT_LIMIT'
  | 'FILE_ACCESS_DENIED'
  | 'BROWSER_LAUNCH_FAILED'
  | 'SEARCH_FAILED'
  | 'CRAWL_FAILED'
  | 'UNSUPPORTED_OPERATION';

export class TendrilError extends Error {
  readonly code: TendrilErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(code: TendrilErrorCode, message: string, options: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TendrilError';
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

export function asTendrilError(error: unknown): TendrilError {
  if (error instanceof TendrilError) return error;
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new TendrilError('TIMEOUT', error.message, { cause: error, retryable: true });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new TendrilError('CANCELLED', error.message || 'Operation cancelled', { cause: error, retryable: true });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/Target (?:page, context or browser|closed)|browser has been closed|browser.*disconnected|page has been closed/i.test(message)) {
    return new TendrilError('BROWSER_DISCONNECTED', message, { cause: error, retryable: true });
  }
  if (/net::ERR_|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(message)) {
    return new TendrilError('NETWORK_ERROR', message, { cause: error, retryable: true });
  }
  if (error instanceof Error && error.name === 'ZodError' && 'issues' in error) {
    return new TendrilError('INVALID_ARGUMENT', 'Invalid tool arguments', { details: { issues: error.issues }, cause: error });
  }
  if (error instanceof Error && 'type' in error && error.type === 'entity.parse.failed') {
    return new TendrilError('INVALID_ARGUMENT', 'Request body must be valid JSON', { cause: error });
  }
  return new TendrilError('INTERNAL_ERROR', message, { cause: error });
}

const RECOVERY: Partial<Record<TendrilErrorCode, string>> = {
  INVALID_ARGUMENT: 'Correct the named arguments and call the tool again.',
  INVALID_URL: 'Supply an absolute URL starting with https:// or http://.',
  SESSION_NOT_FOUND: 'Call browser_session with action=list to find an active session, or action=create to start one.',
  PAGE_NOT_FOUND: 'Call browser_page with action=list and use a pageId from that session.',
  STALE_ELEMENT_REF: 'Take a fresh browser_snapshot for the same page and use the new ref. Do not replay the old ref.',
  INVALID_CURSOR: 'Take a fresh browser_snapshot without a cursor.',
  SESSION_LIMIT_REACHED: 'Close an unused session with browser_session action=close, or wait for an active operation to finish.',
  PROFILE_IN_USE: 'Reconnect to the profile in its owning runtime, or use an ephemeral session.',
  TIMEOUT: 'Inspect current page state before repeating an action. For search, retry with fewer sources or a larger timeoutMs.',
  NETWORK_ERROR: 'Retry a read-only request. Inspect current state before repeating an action that may have already completed.',
  BROWSER_DISCONNECTED: 'Create a new browser_session, navigate to the URL, and take a fresh snapshot.',
  BROWSER_LAUNCH_FAILED: 'Run tendril doctor and install the configured browser with tendril install-browser, or select an installed Chromium backend.',
  SEARCH_FAILED: 'Inspect the provider failures or call browser_search with action=providers. Retry an available provider after its retryAfterMs.',
  OUTPUT_LIMIT: 'Request less content, fewer sources, or a smaller snapshot/extraction.',
  NETWORK_BLOCKED: 'The destination is blocked by network policy or DNS failed. Check the error details and runtime host configuration.',
};

export function errorPayload(error: unknown) {
  const tendril = asTendrilError(error);
  return {
    error: {
      code: tendril.code,
      message: tendril.message,
      retryable: tendril.retryable,
      ...(tendril.details ? { details: tendril.details } : {}),
      ...(RECOVERY[tendril.code] ? { recovery: RECOVERY[tendril.code] } : {}),
    },
  };
}
