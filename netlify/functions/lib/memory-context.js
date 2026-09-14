'use strict';

/**
 * Guest context builder — Step 3, read/merge only.
 *
 * The only file in this codebase that touches both lodgify-client.js and
 * zep-client.js. Pulls a live booking (Lodgify, always fresh, never
 * cached) and stored guest memory (Zep) for one conversation turn, and
 * hands back a single object for a future prompt-building step to use.
 *
 * NOT wired into chat.js. NOT a caching layer — every call re-fetches
 * both sources live.
 *
 * Merge policy (deliberate design choice, confirmed with product owner):
 * liveBooking and guestMemory are kept as two structurally separate
 * namespaces that are never field-merged into each other. Zep facts come
 * back as unstructured natural-language strings (e.g. "usually stays in
 * Unit 3") — there is no reliable way for this module to detect that such
 * a fact disagrees with Lodgify's structured `propertyId` without doing
 * NLP this codebase has no way to verify. So instead of attempting
 * (and likely getting wrong) automatic conflict resolution, this module
 * documents the rule in `authorityNote` and pushes the actual judgment
 * call to whatever consumes this object later (the bot's prompt-building
 * layer, a future step) — live Lodgify data always governs anything
 * booking-related; guest memory is color/continuity/preference only.
 */

const lodgify = require('./lodgify-client');
const zep = require('./zep-client');

const AUTHORITY_NOTE =
  'liveBooking (Lodgify) is authoritative for anything booking-related — property, unit, dates, ' +
  'balance, status. guestMemory (Zep) facts are unstructured stored notes about preference, past ' +
  'stays, party context, friction points, and repeat-guest status — they are color/continuity only ' +
  'and must NEVER be treated as overriding liveBooking, even when a fact appears to reference the ' +
  'same thing (e.g. a remembered "usually books Unit 3" vs. a liveBooking in Unit 7 — Unit 7 wins ' +
  'for anything booking-related). This module does not attempt to detect or resolve such conflicts ' +
  'programmatically; that judgment belongs to whatever consumes this object.';

/**
 * Normalizes a raw Lodgify booking object into the liveBooking shape.
 * NOTE: Lodgify's confirmed-via-docs booking fields are id/propertyId/
 * checkIn/checkOut/guest{name,email,phone}. Fields like balance/status
 * were NOT independently confirmed against Lodgify's official reference
 * (blocked by robots.txt) — they're included here defensively (several
 * common alternate names checked), but `raw` always carries the untouched
 * original object so nothing is lost if a field name guess is wrong.
 * Verify field names against scripts/test-memory-context.js's live output.
 */
function normalizeBooking(booking, matchedVia) {
  if (!booking) return null;
  return {
    source: 'lodgify',
    matchedVia,
    bookingId: booking.id ?? null,
    propertyId: booking.propertyId ?? null,
    checkIn: booking.checkIn ?? booking.arrival ?? null,
    checkOut: booking.checkOut ?? booking.departure ?? null,
    status: booking.status ?? null,
    balanceDue: booking.balanceDue ?? booking.balance ?? booking.due ?? null,
    guest: booking.guest ?? null,
    fetchedAt: new Date().toISOString(),
    raw: booking,
  };
}

/**
 * Resolves the live booking for this guest, always fetched fresh:
 *   - bookingId given -> direct getBooking() lookup
 *   - propertyId given (no bookingId) -> list that property's bookings,
 *     match by guest email client-side (Lodgify has no server-side guest
 *     filter — confirmed Step 1), pick the most recent by checkIn
 *   - neither given -> null (e.g. a pre-booking inquiry with no booking yet)
 */
async function resolveLiveBooking({ email, propertyId, bookingId }) {
  if (bookingId) {
    const booking = await lodgify.getBooking(bookingId);
    return normalizeBooking(booking, 'bookingId');
  }

  if (propertyId) {
    const bookingsPage = await lodgify.getBookingsForProperty(propertyId, { stayFilter: 'All', size: 50 });
    const items = Array.isArray(bookingsPage) ? bookingsPage : bookingsPage?.items ?? [];
    const matches = lodgify.findBookingsByGuest(items, { email });
    if (!matches.length) return null;

    const chosen = [...matches].sort((a, b) => {
      const aDate = new Date(a.checkIn ?? a.arrival ?? 0).getTime();
      const bDate = new Date(b.checkIn ?? b.arrival ?? 0).getTime();
      return bDate - aDate; // most recent/upcoming checkIn first
    })[0];

    return normalizeBooking(chosen, 'propertyId+guestEmail match');
  }

  return null;
}

/**
 * Builds a merged guest context for one conversation turn.
 *
 * @param {object} params
 * @param {string} params.email - guest email (required)
 * @param {string|number} [params.propertyId]
 * @param {string|number} [params.bookingId]
 * @returns {Promise<{
 *   email: string,
 *   liveBooking: object|null,
 *   guestMemory: { userId: string, hasHistory: boolean, context: string, facts: Array },
 *   authorityNote: string,
 *   generatedAt: string,
 * }>}
 */
async function buildGuestContext({ email, propertyId, bookingId } = {}) {
  if (!email) throw new Error('buildGuestContext requires an email');

  // Independent lookups — a Zep-side failure shouldn't block on a Lodgify
  // call finishing first or vice versa. Both still throw loudly on a real
  // failure (auth/rate-limit/5xx); only "no history yet" and "no matching
  // booking" are treated as non-error, empty-shaped results.
  const [liveBooking, guestMemory] = await Promise.all([
    resolveLiveBooking({ email, propertyId, bookingId }),
    zep.getGuestMemory({ email }),
  ]);

  return {
    email,
    liveBooking,
    guestMemory,
    authorityNote: AUTHORITY_NOTE,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  buildGuestContext,
};
