'use strict';

/**
 * Guest session token — Step 4.
 *
 * Signs a verified guest's identity (bookingId + the email on that booking)
 * into an opaque, tamper-proof token. chat.js trusts ONLY this token as
 * proof of who the guest is — never an email or booking number typed into
 * the chat.
 *
 * A token is minted in exactly one place: verify-guest.js, and only AFTER
 * the guest has proven they belong to the booking (last name matches the
 * live Lodgify record). The email in the payload therefore comes from the
 * live booking at verification time, not from anything the guest typed.
 *
 * Why the email rides in the token: buildGuestContext() (memory-context.js)
 * requires the guest's email to look up Zep memory. Carrying it here means
 * chat.js doesn't need an extra Lodgify round-trip on every message just
 * to rediscover it. Booking data itself is still always fetched live.
 *
 * Format: base64url(payload JSON) + '.' + base64url(HMAC-SHA256 signature)
 * Signed with GUEST_TOKEN_SECRET — a separate secret from
 * GUEST_ID_HASH_SECRET. Token signing and guest-id hashing are different
 * concerns and must never share a secret.
 */

const crypto = require('node:crypto');

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days — covers pre-stay, stay, and a review window

class GuestTokenError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GuestTokenError';
    this.code = code; // 'config' | 'malformed' | 'signature' | 'expired'
  }
}

function getSecret() {
  const secret = process.env.GUEST_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new GuestTokenError(
      'GUEST_TOKEN_SECRET is missing or too short (min 32 chars) — cannot create or verify guest tokens.',
      'config'
    );
  }
  return secret;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
}

/**
 * Creates a signed guest session token. Call ONLY after the guest has been
 * verified against the live booking (see verify-guest.js).
 *
 * @param {object} params
 * @param {string|number} params.bookingId - required, the Lodgify booking id
 * @param {string} params.email - required, the guest email on that live booking
 * @param {number} [params.ttlSeconds] - defaults to 90 days
 * @returns {string} opaque token safe to keep in the browser and send with each chat request
 */
function createGuestToken({ bookingId, email, ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!bookingId) throw new GuestTokenError('createGuestToken requires a bookingId', 'malformed');
  if (!email) throw new GuestTokenError('createGuestToken requires the email on the live booking', 'malformed');

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    bookingId,
    email: String(email).trim().toLowerCase(),
    iat: now,
    exp: now + ttlSeconds,
  };

  const payloadB64 = base64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verifies a guest token and returns its payload, or throws GuestTokenError.
 * This is the ONLY function in the codebase that should read a token's
 * contents — never decode a token's payload anywhere else.
 *
 * @param {string} token
 * @returns {{ bookingId: string|number, email: string, iat: number, exp: number }}
 */
function verifyGuestToken(token) {
  if (typeof token !== 'string' || token.split('.').length !== 2) {
    throw new GuestTokenError('Malformed token — expected "<payload>.<signature>" shape.', 'malformed');
  }

  const [payloadB64, signature] = token.split('.');
  const expected = sign(payloadB64);

  // Constant-time comparison — never use === on signatures.
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new GuestTokenError('Token signature does not match — token was tampered with or forged.', 'signature');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new GuestTokenError('Token payload is not valid JSON after decoding.', 'malformed');
  }

  if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) {
    throw new GuestTokenError('Token has expired.', 'expired');
  }
  if (!payload.bookingId || !payload.email) {
    throw new GuestTokenError('Token payload is missing bookingId or email.', 'malformed');
  }

  return payload;
}

module.exports = {
  GuestTokenError,
  createGuestToken,
  verifyGuestToken,
};
