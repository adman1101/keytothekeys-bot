'use strict';

/**
 * Lodgify API client — READ-ONLY BY DESIGN.
 *
 * Why this file looks the way it does: Lodgify only issues one API key per
 * account, and that key has full read+write permissions with no read-only
 * scoping option on Lodgify's side. Since the platform can't enforce
 * read-only for us, this module does — by construction, not by convention.
 *
 * Hard rule for anyone editing this file: there is exactly one function in
 * this whole module that is allowed to call `fetch` — `_get()` below — and
 * it is hardcoded to HTTP GET. There is no `_post`, `_put`, `_patch`, or
 * `_delete` helper anywhere in this file, and there must never be one. If a
 * future task needs Lodgify writes, that belongs in a *different* module
 * with its own explicit review — do not add write methods here.
 *
 * Every exported method ultimately funnels through `_get()`, so every call
 * is logged and every error is handled consistently.
 *
 * Endpoints/params below are confirmed against Lodgify's official API v2
 * docs (docs.lodgify.com) as of 2026-08-18. Where a param wasn't directly
 * confirmable (docs page blocked automated fetch), it's noted inline.
 */

const {
  LodgifyAuthError,
  LodgifyPermissionError,
  LodgifyRateLimitError,
  LodgifyServerError,
  LodgifyApiError,
  LodgifyConfigError,
} = require('./lodgify-errors');

const BASE_URL = 'https://api.lodgify.com';

// Lodgify's documented v2 limit is 750 calls/min. We self-throttle below
// that so we never lean on their 429 as our only guardrail — the 750/min
// figure is an account- or key-level ceiling per Lodgify's docs, and we'd
// rather slow down proactively than find out the hard way whether it's
// shared with other tools hitting the same key.
const MAX_CALLS_PER_MINUTE = 600;
const WINDOW_MS = 60 * 1000;
const callTimestamps = [];

function getApiKey() {
  const key = process.env.LODGIFY_API_KEY;
  if (!key) {
    throw new LodgifyConfigError(
      'LODGIFY_API_KEY environment variable is not set. Set it in your Netlify env vars (or local shell) — it is never read from anywhere else.'
    );
  }
  return key;
}

/** Structured, single-line JSON logging. Never pass the API key in here. */
function logEvent(level, event, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Proactive client-side rate gate. Blocks (async) until it's safe to make
 * another call without exceeding MAX_CALLS_PER_MINUTE in a trailing 60s
 * window. This does not replace handling a 429 from Lodgify — it just makes
 * one much less likely in normal use.
 */
async function waitForRateLimitSlot() {
  const now = Date.now();
  while (callTimestamps.length && now - callTimestamps[0] > WINDOW_MS) {
    callTimestamps.shift();
  }
  if (callTimestamps.length >= MAX_CALLS_PER_MINUTE) {
    const oldest = callTimestamps[0];
    const waitMs = WINDOW_MS - (now - oldest) + 25; // small buffer
    logEvent('warn', 'lodgify_client_throttling', {
      waitMs,
      callsInWindow: callTimestamps.length,
    });
    await sleep(Math.max(waitMs, 0));
    return waitForRateLimitSlot();
  }
  callTimestamps.push(Date.now());
}

function buildUrl(endpoint, query) {
  const url = new URL(BASE_URL + endpoint);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function parseErrorBody(res) {
  const raw = await res.text().catch(() => '');
  if (!raw) return { message: null, raw: null };
  try {
    const json = JSON.parse(raw);
    return { message: json.message || json.Message || null, code: json.code || null, raw: json };
  } catch {
    return { message: raw.slice(0, 500), raw };
  }
}

/**
 * The ONLY function in this module allowed to touch `fetch`. GET-only —
 * do not add a `method` parameter to this function.
 *
 * @param {string} endpoint - path starting with /v2/...
 * @param {object} opts
 * @param {object} [opts.query] - query string params
 * @param {string} [opts.identifier] - property/guest/booking id for audit logging
 */
async function _get(endpoint, { query, identifier } = {}) {
  const apiKey = getApiKey();
  const url = buildUrl(endpoint, query);
  const startedAt = Date.now();

  logEvent('info', 'lodgify_api_call_start', {
    method: 'GET',
    endpoint,
    identifier: identifier ?? null,
  });

  await waitForRateLimitSlot();

  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-ApiKey': apiKey,
        Accept: 'application/json',
      },
    });
  } catch (networkErr) {
    logEvent('error', 'lodgify_api_call_network_error', {
      method: 'GET',
      endpoint,
      identifier: identifier ?? null,
      message: networkErr.message,
    });
    throw new LodgifyApiError(`Network error calling Lodgify (${endpoint}): ${networkErr.message}`, {
      endpoint,
    });
  }

  const durationMs = Date.now() - startedAt;

  if (res.ok) {
    const data = await res.json();
    logEvent('info', 'lodgify_api_call_success', {
      method: 'GET',
      endpoint,
      identifier: identifier ?? null,
      status: res.status,
      durationMs,
    });
    return data;
  }

  const { message, code, raw } = await parseErrorBody(res);
  const commonLogFields = {
    method: 'GET',
    endpoint,
    identifier: identifier ?? null,
    status: res.status,
    durationMs,
    lodgifyMessage: message,
    lodgifyCode: code,
  };

  switch (res.status) {
    case 401:
      logEvent('error', 'lodgify_api_call_auth_failed', commonLogFields);
      throw new LodgifyAuthError(
        `Lodgify rejected the API key (401) calling ${endpoint}. Check LODGIFY_API_KEY is set correctly in Netlify env vars.`,
        { status: 401, endpoint, body: raw, code }
      );
    case 403:
      logEvent('error', 'lodgify_api_call_permission_denied', commonLogFields);
      throw new LodgifyPermissionError(
        `Lodgify denied permission (403) for ${endpoint}. The API key may not have access to this resource.`,
        { status: 403, endpoint, body: raw, code }
      );
    case 429: {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : null;
      logEvent('error', 'lodgify_api_call_rate_limited', {
        ...commonLogFields,
        retryAfterSeconds,
      });
      throw new LodgifyRateLimitError(
        `Lodgify rate limit hit (429) calling ${endpoint}. Limit is 750 calls/min.` +
          (retryAfterSeconds ? ` Retry after ${retryAfterSeconds}s.` : ''),
        { status: 429, endpoint, body: raw, code, retryAfterSeconds }
      );
    }
    default:
      if (res.status >= 500) {
        logEvent('error', 'lodgify_api_call_server_error', commonLogFields);
        throw new LodgifyServerError(
          `Lodgify server error (${res.status}) calling ${endpoint}. Not caused by this client — safe to retry later.`,
          { status: res.status, endpoint, body: raw, code }
        );
      }
      logEvent('error', 'lodgify_api_call_failed', commonLogFields);
      throw new LodgifyApiError(
        `Lodgify call failed (${res.status}) for ${endpoint}${message ? `: ${message}` : ''}`,
        { status: res.status, endpoint, body: raw, code }
      );
  }
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/**
 * List properties. Confirmed query params (Lodgify v2 docs): page, size
 * (max 50, default 50), wid, updatedSince, includeCount, includeInOut.
 */
async function listProperties({ page, size, wid, updatedSince, includeCount, includeInOut } = {}) {
  return _get('/v2/properties', {
    query: { page, size, wid, updatedSince, includeCount, includeInOut },
    identifier: `page=${page ?? 1}`,
  });
}

/**
 * Get a single property by id. Confirmed query params: wid, includeInOut.
 */
async function getProperty(propertyId, { wid, includeInOut } = {}) {
  if (!propertyId) throw new Error('getProperty requires a propertyId');
  return _get(`/v2/properties/${encodeURIComponent(propertyId)}`, {
    query: { wid, includeInOut },
    identifier: `propertyId=${propertyId}`,
  });
}

// ---------------------------------------------------------------------------
// Bookings / reservations
// ---------------------------------------------------------------------------

/**
 * List bookings. Confirmed query params (Lodgify v2 docs):
 *   - propertyId       filter to one property
 *   - stayFilter       'Upcoming' | 'Current' | 'Historic' | 'All' |
 *                       'ArrivalDate' | 'DepartureDate' (default 'Upcoming';
 *                       Lodgify's own docs warn 'All' can return a lot of data)
 *   - stayFilterDate    required when stayFilter is 'ArrivalDate'/'DepartureDate'
 *   - page, size        pagination (size max 50)
 *   - updatedSince
 *   - includeCount, includeTransactions, includeQuoteDetails, includeExternal
 *   - trash             'False' | 'True' | 'All'
 *
 * There is NO guestName/guestEmail filter on this endpoint (confirmed
 * against Lodgify's official docs on 2026-08-18) — filter by guest
 * client-side with findBookingsByGuest() below.
 */
async function listBookings({
  propertyId,
  stayFilter,
  stayFilterDate,
  page,
  size,
  updatedSince,
  includeCount,
  includeTransactions,
  includeQuoteDetails,
  includeExternal,
  trash,
} = {}) {
  return _get('/v2/reservations/bookings', {
    query: {
      propertyId,
      stayFilter,
      stayFilterDate,
      page,
      size,
      updatedSince,
      includeCount,
      includeTransactions,
      includeQuoteDetails,
      includeExternal,
      trash,
    },
    identifier: propertyId ? `propertyId=${propertyId}` : `page=${page ?? 1}`,
  });
}

/** Convenience wrapper: all bookings for one property. */
async function getBookingsForProperty(propertyId, opts = {}) {
  if (!propertyId) throw new Error('getBookingsForProperty requires a propertyId');
  return listBookings({ ...opts, propertyId });
}

/**
 * Convenience wrapper for a date-range-style query using Lodgify's
 * stayFilter/stayFilterDate params. `dateType` selects whether stayFilterDate
 * anchors on arrival or departure.
 */
async function getBookingsByDate(stayFilterDate, { dateType = 'ArrivalDate', propertyId, ...rest } = {}) {
  if (!stayFilterDate) throw new Error('getBookingsByDate requires a stayFilterDate (YYYY-MM-DD)');
  return listBookings({
    ...rest,
    propertyId,
    stayFilter: dateType,
    stayFilterDate,
  });
}

/** Get a single booking by id. */
async function getBooking(bookingId, opts = {}) {
  if (!bookingId) throw new Error('getBooking requires a bookingId');
  return _get(`/v2/reservations/bookings/${encodeURIComponent(bookingId)}`, {
    query: opts,
    identifier: `bookingId=${bookingId}`,
  });
}

// ---------------------------------------------------------------------------
// Guests
// ---------------------------------------------------------------------------

/**
 * Lodgify has no separate "guest" endpoint — guest name/email/phone are
 * embedded in the booking object under `guest`. This fetches the booking
 * and returns just that piece, so call sites read cleanly as "get the
 * guest for this booking" without knowing that detail.
 */
async function getGuestForBooking(bookingId) {
  const booking = await getBooking(bookingId);
  logEvent('info', 'lodgify_guest_extracted_from_booking', {
    bookingId,
    hasGuest: Boolean(booking && booking.guest),
  });
  return booking ? booking.guest ?? null : null;
}

/**
 * Client-side filter over an already-fetched array of bookings, matching on
 * guest name (substring, case-insensitive) and/or exact guest email. Not an
 * API call — no rate limit or logging concerns; Lodgify's API has no
 * server-side guest filter, so callers should fetch the relevant bookings
 * (e.g. via getBookingsForProperty) and pass them here.
 */
function findBookingsByGuest(bookings, { name, email } = {}) {
  if (!Array.isArray(bookings)) return [];
  const nameNeedle = name ? name.toLowerCase() : null;
  const emailNeedle = email ? email.toLowerCase() : null;
  return bookings.filter((booking) => {
    const guest = booking && booking.guest;
    if (!guest) return false;
    const nameMatches = nameNeedle ? (guest.name || '').toLowerCase().includes(nameNeedle) : false;
    const emailMatches = emailNeedle ? (guest.email || '').toLowerCase() === emailNeedle : false;
    if (nameNeedle && emailNeedle) return nameMatches && emailMatches;
    return nameMatches || emailMatches;
  });
}

module.exports = {
  listProperties,
  getProperty,
  listBookings,
  getBookingsForProperty,
  getBookingsByDate,
  getBooking,
  getGuestForBooking,
  findBookingsByGuest,
};
