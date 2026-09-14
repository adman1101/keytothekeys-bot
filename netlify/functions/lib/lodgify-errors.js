'use strict';

/**
 * Error types for the Lodgify read-only client.
 *
 * These exist so callers can catch specific failure modes (auth vs.
 * rate-limit vs. server error) instead of parsing status codes themselves,
 * and so failures are always thrown loudly rather than swallowed.
 */

class LodgifyApiError extends Error {
  constructor(message, { status, endpoint, body, code } = {}) {
    super(message);
    this.name = 'LodgifyApiError';
    this.status = status ?? null;
    this.endpoint = endpoint ?? null;
    this.body = body ?? null;
    this.code = code ?? null;
  }
}

/** 401 — API key missing/invalid. */
class LodgifyAuthError extends LodgifyApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'LodgifyAuthError';
  }
}

/** 403 — API key valid but lacks permission for this resource. */
class LodgifyPermissionError extends LodgifyApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'LodgifyPermissionError';
  }
}

/** 429 — rate limited. Lodgify's v2 limit is 750 calls/min. */
class LodgifyRateLimitError extends LodgifyApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'LodgifyRateLimitError';
    this.retryAfterSeconds = opts?.retryAfterSeconds ?? null;
  }
}

/** 5xx — Lodgify's servers failed. Not our fault; caller should retry later. */
class LodgifyServerError extends LodgifyApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'LodgifyServerError';
  }
}

/** Thrown when LODGIFY_API_KEY isn't set — a config problem, not an API failure. */
class LodgifyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LodgifyConfigError';
  }
}

module.exports = {
  LodgifyApiError,
  LodgifyAuthError,
  LodgifyPermissionError,
  LodgifyRateLimitError,
  LodgifyServerError,
  LodgifyConfigError,
};
