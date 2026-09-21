'use strict';

/**
 * verify-guest — Step 4.
 *
 * The one and only place a guest session token is minted. The concierge
 * page posts what the guest knows, this function checks it against the
 * LIVE Lodgify booking, and only on a match returns a signed token that
 * chat.js will trust for the rest of the stay.
 *
 * Two ways in (the page decides which to show):
 *   A) bookingId + lastName   — booking number pre-filled from the link in
 *                               Lodgify's automated pre-arrival message.
 *   B) lastName + checkIn     — no booking number available; we search
 *                               upcoming/current bookings for that arrival
 *                               date. If more than one booking matches
 *                               (two Garcias arriving the same day), we
 *                               return the property choices so the page
 *                               can ask which one, then retry with
 *                               propertyId included.
 *
 * Security posture:
 *   - Nothing is unlocked by a booking number alone; the last name on the
 *     live booking must match.
 *   - Every failure returns the SAME generic message, so the endpoint can't
 *     be used to discover whether a booking number exists.
 *   - Reads only. Uses the read-only Lodgify client; nothing is written to
 *     Lodgify or Zep here.
 */

const lodgify = require('./lib/lodgify-client');
const { LodgifyApiError } = require('./lib/lodgify-errors');
const { createGuestToken, GuestTokenError } = require('./lib/guest-token');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GENERIC_FAIL =
  "We couldn't match those details to a booking. Please double-check the spelling and try again, " +
  'or reach the team at (786) 551-4855 or info@thekeytothekeys.com.';

function json(statusCode, body) {
  return { statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** Lowercase, trim, strip accents — so "García" matches "garcia". */
function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * True if the typed last name equals ANY word of the guest's name on the
 * booking. Tolerates "Maria Garcia Lopez" vs a typed "Garcia" or "Lopez",
 * and both `guest.name` and split `lastName` field shapes.
 */
function lastNameMatches(guest, typedLastName) {
  const typed = normalizeName(typedLastName);
  if (!typed || typed.length < 2) return false;
  const words = [guest?.lastName, guest?.last_name, guest?.name, guest?.fullName]
    .filter(Boolean)
    .flatMap((v) => normalizeName(v).split(/\s+/));
  return words.includes(typed);
}

function firstNameOf(guest) {
  const full = guest?.firstName ?? guest?.first_name ?? guest?.name ?? '';
  return String(full).trim().split(/\s+/)[0] || null;
}

/**
 * Lodgify's booking payload has used several names for the property id over
 * API versions (propertyId, property_id, PropertyId, rental_id, and per-room
 * ids). Check them all so a naming difference never blanks out the property.
 */
function propertyIdOf(booking) {
  if (!booking) return null;
  const raw = booking.raw ?? booking;
  const direct =
    booking.propertyId ?? raw.propertyId ?? raw.property_id ?? raw.PropertyId ??
    raw.rental_id ?? raw.rentalId ?? raw.RentalId ?? null;
  if (direct) return direct;
  const room = Array.isArray(raw.rooms) ? raw.rooms[0] : Array.isArray(raw.roomTypes) ? raw.roomTypes[0] : null;
  return room?.property_id ?? room?.propertyId ?? room?.PropertyId ?? null;
}

function dayOf(value) {
  return String(value ?? '').slice(0, 10); // 'YYYY-MM-DD'
}

/**
 * Lodgify displays reservation ids as "B22552956" and its {{BookingId}}
 * placeholder may render with or without the "B"; the API wants the bare
 * number. Accept "B22552956", "#22552956", " 22552956 " -> "22552956".
 */
function normalizeBookingId(value) {
  const cleaned = String(value ?? '').trim().replace(/^[#\s]*[bB]?/, '').trim();
  return /^\d+$/.test(cleaned) ? cleaned : null;
}

/**
 * The stable identity key the memory layer hashes to recognise a guest
 * across stays. Email when the booking has one; otherwise the phone number
 * (Airbnb bookings often reach Lodgify with a phone but no email). The
 * "phone:" prefix keeps the two namespaces from ever colliding.
 */
function guestKeyFor(guest) {
  const email = String(guest?.email ?? '').trim().toLowerCase();
  if (email) return email;
  const digits = String(guest?.phone ?? guest?.phoneNumber ?? guest?.mobile ?? '').replace(/\D/g, '');
  if (digits.length >= 7) return `phone:${digits}`;
  return null;
}

function itemsOf(page) {
  return Array.isArray(page) ? page : page?.items ?? [];
}

/** Path A: direct lookup by booking number. Not-found becomes a generic failure. */
async function findByBookingId(bookingId) {
  try {
    return await lodgify.getBooking(bookingId);
  } catch (err) {
    if (err instanceof LodgifyApiError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

/**
 * Path B: search upcoming + current bookings across all properties for the
 * given arrival date and last name. Runs property lookups in parallel.
 * Lodgify has no server-side guest filter (confirmed in Step 1), so the
 * name match is client-side.
 */
async function findByArrivalAndName({ checkIn, lastName, propertyId }) {
  const wantedDay = dayOf(checkIn);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wantedDay)) return [];

  let propertyIds;
  if (propertyId) {
    propertyIds = [propertyId];
  } else {
    const props = itemsOf(await lodgify.listProperties({ size: 100 }));
    propertyIds = props.map((p) => p.id).filter(Boolean);
  }

  const perProperty = await Promise.all(
    propertyIds.map(async (id) => {
      const [upcoming, current] = await Promise.all([
        lodgify.getBookingsForProperty(id, { stayFilter: 'Upcoming', size: 50 }),
        lodgify.getBookingsForProperty(id, { stayFilter: 'Current', size: 50 }),
      ]);
      return [...itemsOf(upcoming), ...itemsOf(current)];
    })
  );

  const seen = new Set();
  return perProperty.flat().filter((b) => {
    if (!b?.id || seen.has(b.id)) return false;
    seen.add(b.id);
    return dayOf(b.checkIn ?? b.arrival) === wantedDay && lastNameMatches(b.guest, lastName);
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Body must be JSON' });
  }

  const { bookingId: rawBookingId, lastName, checkIn, propertyId } = body;
  if (!lastName) return json(400, { error: 'lastName is required' });
  if (!rawBookingId && !checkIn) return json(400, { error: 'Provide bookingId, or checkIn (YYYY-MM-DD)' });

  try {
    let booking = null;

    if (rawBookingId) {
      const bookingId = normalizeBookingId(rawBookingId);
      booking = bookingId ? await findByBookingId(bookingId) : null;
      if (booking && !lastNameMatches(booking.guest, lastName)) booking = null;
    } else {
      const matches = await findByArrivalAndName({ checkIn, lastName, propertyId });
      if (matches.length > 1) {
        // Ambiguous — let the page ask which property, then retry with propertyId.
        const options = await Promise.all(
          matches.map(async (b) => {
            let name = null;
            try {
              const p = await lodgify.getProperty(propertyIdOf(b));
              name = p?.name ?? null;
            } catch {
              /* name is a nicety; the id is enough to retry */
            }
            return { propertyId: propertyIdOf(b), propertyName: name };
          })
        );
        return json(200, { ok: false, needsProperty: true, options });
      }
      booking = matches[0] ?? null;
    }

    if (!booking) {
      // Small fixed delay blunts rapid guessing without hurting a real guest.
      await new Promise((r) => setTimeout(r, 400));
      return json(200, { ok: false, message: GENERIC_FAIL });
    }

    const guestKey = guestKeyFor(booking.guest);
    if (!guestKey) {
      // No email AND no phone on the booking — nothing stable to key memory on.
      // Rare; treat as a team-assisted case rather than a silent partial experience.
      return json(200, {
        ok: false,
        message:
          "We found your booking but it's missing contact details on file. Please reach the team at " +
          '(786) 551-4855 so we can finish setting up your concierge.',
      });
    }

    const token = createGuestToken({ bookingId: booking.id, guestKey });

    return json(200, {
      ok: true,
      token,
      guest: {
        firstName: firstNameOf(booking.guest),
        checkIn: booking.checkIn ?? booking.arrival ?? null,
        checkOut: booking.checkOut ?? booking.departure ?? null,
        propertyId: propertyIdOf(booking),
      },
    });
  } catch (err) {
    if (err instanceof GuestTokenError && err.code === 'config') {
      console.error('[verify-guest] config error:', err.message);
      return json(500, { error: 'Concierge verification is not configured yet.' });
    }
    console.error('[verify-guest] unexpected error:', err);
    return json(500, { error: 'Verification is temporarily unavailable. Please try again in a moment.' });
  }
};
