import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { reportBoundaryError } from '@/lib/reportError';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(() => 'evt-123'),
}));

const SENSITIVE_URLS = [
  '/auth/magic-link/verify?token=magic-secret-123',
  '/auth/twitter/callback?code=oauth-code-456&state=oauth-state-789',
];

describe('reportBoundaryError query string redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it.each(SENSITIVE_URLS)('does not report token, code or state values for %s', (url) => {
    window.history.replaceState({}, '', url);
    const pathname = url.split('?')[0];

    reportBoundaryError(new Error('boom'), 'route', pathname);

    const [, captureContext] = vi.mocked(Sentry.captureException).mock.calls[0];
    const serialized = JSON.stringify(captureContext);

    for (const secret of ['magic-secret-123', 'oauth-code-456', 'oauth-state-789']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/token=|code=|state=/);
    expect(captureContext).toEqual(
      expect.objectContaining({
        contexts: { error_boundary: expect.objectContaining({ route: pathname }) },
      }),
    );
  });

  it('still reports only the pathname when it falls back to window.location', () => {
    window.history.replaceState({}, '', '/auth/magic-link/verify?token=magic-secret-123');

    reportBoundaryError(new Error('boom'), 'global');

    const [, captureContext] = vi.mocked(Sentry.captureException).mock.calls[0];
    expect(JSON.stringify(captureContext)).not.toContain('magic-secret-123');
    expect(captureContext).toEqual(
      expect.objectContaining({
        tags: expect.objectContaining({ route: '/auth/magic-link/verify' }),
      }),
    );
  });
});
