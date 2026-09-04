import { describe, expect, it } from 'vitest';
import { asTendrilError, errorPayload, TendrilError } from '../src/errors.js';

describe('agent error recovery', () => {
  it.each([
    ['page.goto: net::ERR_CONNECTION_RESET', 'NETWORK_ERROR', true],
    ['Target page, context or browser has been closed', 'BROWSER_DISCONNECTED', true],
    ['Unexpected invariant failure', 'INTERNAL_ERROR', false],
  ])('classifies %s as %s', (message, code, retryable) => {
    expect(asTendrilError(new Error(message))).toMatchObject({ code, retryable });
  });

  it('preserves explicit errors and gives a concrete recovery action', () => {
    const error = new TendrilError('STALE_ELEMENT_REF', 'Old ref', { details: { ref: 'e1' } });
    expect(asTendrilError(error)).toBe(error);
    expect(errorPayload(error)).toMatchObject({
      error: { code: 'STALE_ELEMENT_REF', details: { ref: 'e1' }, recovery: expect.stringContaining('browser_snapshot') },
    });
  });
});
