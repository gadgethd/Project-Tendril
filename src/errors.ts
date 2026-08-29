export type TendrilErrorCode =
  | 'CONFIGURATION_ERROR'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_LIMIT_REACHED'
  | 'PROFILE_IN_USE'
  | 'PAGE_NOT_FOUND'
  | 'STALE_ELEMENT_REF'
  | 'NETWORK_BLOCKED'
  | 'INVALID_URL'
  | 'TIMEOUT'
  | 'CANCELLED'
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
  const message = error instanceof Error ? error.message : String(error);
  return new TendrilError('UNSUPPORTED_OPERATION', message, { cause: error });
}
