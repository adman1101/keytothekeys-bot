'use strict';

/**
 * Error types for the Zep write-path client.
 *
 * The Zep SDK itself only throws two classes (ZepError, ZepTimeoutError),
 * both distinguished solely by a `.statusCode` property — there's no typed
 * ZepAuthError/ZepRateLimitError family upstream. This file re-throws
 * SDK errors as our own typed errors (mirroring lodgify-errors.js) so
 * call sites get the same clean, specific-catch experience as the
 * Lodgify client, and so failures are never ambiguous about what broke.
 */

class ZepApiError extends Error {
  constructor(message, { status, endpoint, body, code } = {}) {
    super(message);
    this.name = 'ZepApiError';
    this.status = status ?? null;
    this.endpoint = endpoint ?? null;
    this.body = body ?? null;
    this.code = code ?? null;
  }
}

/** 401 — API key missing/invalid. */
class ZepAuthError extends ZepApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'ZepAuthError';
  }
}

/** 403 — API key valid but lacks permission for this resource/action. */
class ZepPermissionError extends ZepApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'ZepPermissionError';
  }
}

/** 429 — rate limited. Zep's Flex tier documents 600 requests/minute. */
class ZepRateLimitError extends ZepApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'ZepRateLimitError';
    this.retryAfterSeconds = opts?.retryAfterSeconds ?? null;
  }
}

/** 400/422 — Zep rejected the payload shape/content. */
class ZepValidationError extends ZepApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'ZepValidationError';
  }
}

/** 5xx — Zep's servers failed. Not our fault; caller should retry later. */
class ZepServerError extends ZepApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'ZepServerError';
  }
}

/** Thrown when ZEP_API_KEY or GUEST_ID_HASH_SECRET isn't set — a config problem, not an API failure. */
class ZepConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZepConfigError';
  }
}

/**
 * Thrown by writeGuestFact() when the redaction filter finds a match.
 * The write to Zep is never attempted. `categories` lists which of the
 * five deny-list categories tripped (e.g. ['payment_card', 'health_info'])
 * — deliberately never the matched text itself, so this error is always
 * safe to log in full.
 */
class RedactionBlockedError extends Error {
  constructor(categories) {
    super(
      `Write blocked by redaction filter — matched categories: ${categories.join(', ')}. ` +
        'Fact was NOT sent to Zep. This is a fail-closed backstop, not a filter that strips and continues.'
    );
    this.name = 'RedactionBlockedError';
    this.categories = categories;
  }
}

module.exports = {
  ZepApiError,
  ZepAuthError,
  ZepPermissionError,
  ZepRateLimitError,
  ZepValidationError,
  ZepServerError,
  ZepConfigError,
  RedactionBlockedError,
};
