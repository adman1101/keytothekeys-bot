'use strict';

/**
 * Hard-backstop redaction filter — runs BEFORE anything reaches Zep.
 *
 * Scope: exactly the five categories that are the agreed spec (there is
 * no separate written policy doc beyond these five):
 *   1. payment_info        — card numbers (Luhn-validated), CVV, bank/routing
 *   2. door_gate_lock_code  — gate/door/lock/keypad/garage/lockbox codes
 *   3. wifi_password        — wifi/network passwords
 *   4. government_id        — SSN, passport, driver's license, EIN/tax ID
 *   5. health_info          — keyword-based (diagnosis, medication, etc.)
 *
 * This is explicitly a BEST-EFFORT backstop, not a guarantee. Regex/keyword
 * matching will miss creatively-formatted real sensitive data and will
 * occasionally flag innocuous text (especially health_info, which has no
 * fixed shape to match against structurally). It's intentionally biased
 * toward over-blocking rather than under-blocking.
 *
 * This module has ZERO dependency on the Zep SDK or the network — it's a
 * pure function over strings/objects, so it can be tested in complete
 * isolation (see scripts/test-zep.js).
 */

// ---------------------------------------------------------------------------
// Payment info
// ---------------------------------------------------------------------------

function luhnValid(digitsOnly) {
  if (digitsOnly.length < 13 || digitsOnly.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let n = Number(digitsOnly[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// Candidate digit runs (13-19 digits) allowing space/dash separators between
// digits, e.g. "4111 1111 1111 1111" or "4111-1111-1111-1111" or bare digits.
const CARD_CANDIDATE_REGEX = /(?:\d[ -]?){12,18}\d/g;

function hasPaymentCardNumber(text) {
  const matches = text.match(CARD_CANDIDATE_REGEX) || [];
  return matches.some((m) => {
    const digitsOnly = m.replace(/[ -]/g, '');
    return digitsOnly.length >= 13 && digitsOnly.length <= 19 && luhnValid(digitsOnly);
  });
}

const CVV_KEYWORD_REGEX = /\b(cvv2?|cvc2?|card verification (value|code)|security code)\b/gi;
const CVV_VALUE_REGEX = /\b\d{3,4}\b/;

const BANK_KEYWORD_REGEX = /\b(account|routing)\s*(number|no\.?|#)?\b/gi;
const BANK_VALUE_REGEX = /\b\d{6,17}\b/;

// ---------------------------------------------------------------------------
// Door / gate / lock codes
// ---------------------------------------------------------------------------

const CODE_KEYWORD_REGEX =
  /\b(gate|door|lock|keypad|garage|lockbox|entry|access)\s*code\b|\bcombo(?:nation)?\b/gi;
const CODE_VALUE_REGEX = /\b[A-Za-z0-9]{3,8}\b/;

// ---------------------------------------------------------------------------
// WiFi passwords
// ---------------------------------------------------------------------------

const WIFI_KEYWORD_REGEX = /\b(wi[- ]?fi|wireless|network|ssid)\b/gi;
// Lazily allow a short filler gap ("is", "=", ":") between the
// password/code keyword and the actual value token, so "wifi password is
// Sunshine2024" matches just as well as "wifi password: Sunshine2024".
const WIFI_VALUE_KEYWORD_REGEX = /\b(password|pass\s*word|passcode|code|key)\b[\s\S]{0,15}?\S{4,}/i;

// ---------------------------------------------------------------------------
// Government IDs
// ---------------------------------------------------------------------------

const SSN_FORMATTED_REGEX = /\b\d{3}-\d{2}-\d{4}\b/;
const SSN_KEYWORD_REGEX = /\b(ssn|social security(\s*number)?)\b/gi;
const SSN_VALUE_REGEX = /\b\d{9}\b/;

const PASSPORT_KEYWORD_REGEX = /\bpassport\s*(no\.?|number|#)?\b/gi;
const PASSPORT_VALUE_REGEX = /\b[A-Za-z0-9]{6,9}\b/;

const LICENSE_KEYWORD_REGEX = /\bdriver'?s?\s*licen[cs]e\s*(no\.?|number|#)?\b/gi;
const LICENSE_VALUE_REGEX = /\b[A-Za-z0-9]{5,12}\b/;

const EIN_FORMATTED_REGEX = /\b\d{2}-\d{7}\b/;
const EIN_KEYWORD_REGEX = /\b(tax id|ein|employer identification number)\b/gi;

// ---------------------------------------------------------------------------
// Health information — keyword list only; no fixed shape to match structurally.
// Deliberately broad / over-inclusive.
// ---------------------------------------------------------------------------

const HEALTH_KEYWORD_PATTERNS = [
  /diagnos(is|ed)/i,
  /medication/i,
  /prescription/i,
  /allerg/i, // allergy, allergic, allergies
  /disab(led|ility)/i,
  /medical condition/i,
  /wheelchair/i,
  /chemotherapy/i,
  /\bcancer\b/i,
  /diabet/i, // diabetes, diabetic
  /\bhiv\b/i,
  /pregnan/i, // pregnant, pregnancy
  /seizure/i,
  /epilepsy/i,
  /psychiatric/i,
  /\bdepression\b/i,
  /anxiety disorder/i,
  /autis/i, // autism, autistic
  /\badhd\b/i,
  /\bsurgery\b/i,
];

// ---------------------------------------------------------------------------
// Shared proximity-matching helper
// ---------------------------------------------------------------------------

/**
 * Finds every occurrence of keywordRegex (must have 'g' flag) and checks
 * whether valueRegex matches within `window` characters before/after it.
 * Returns true on first hit. Does not report the matched substrings.
 */
function keywordNearValue(text, keywordRegex, valueRegex, window = 30) {
  let match;
  keywordRegex.lastIndex = 0;
  while ((match = keywordRegex.exec(text)) !== null) {
    const start = Math.max(0, match.index - window);
    const end = Math.min(text.length, match.index + match[0].length + window);
    const windowText = text.slice(start, end);
    if (valueRegex.test(windowText)) return true;
    // Guard against zero-width matches causing an infinite loop.
    if (match.index === keywordRegex.lastIndex) keywordRegex.lastIndex++;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scans a single string and returns the set of category names (a subset of
 * ['payment_info', 'door_gate_lock_code', 'wifi_password', 'government_id',
 * 'health_info']) that matched. Never returns matched substrings.
 */
function scanText(text) {
  const categories = new Set();
  if (typeof text !== 'string' || !text) return categories;

  // 1. Payment info
  if (
    hasPaymentCardNumber(text) ||
    keywordNearValue(text, CVV_KEYWORD_REGEX, CVV_VALUE_REGEX) ||
    keywordNearValue(text, BANK_KEYWORD_REGEX, BANK_VALUE_REGEX)
  ) {
    categories.add('payment_info');
  }

  // 2. Door / gate / lock codes
  if (keywordNearValue(text, CODE_KEYWORD_REGEX, CODE_VALUE_REGEX)) {
    categories.add('door_gate_lock_code');
  }

  // 3. WiFi passwords
  if (keywordNearValue(text, WIFI_KEYWORD_REGEX, WIFI_VALUE_KEYWORD_REGEX)) {
    categories.add('wifi_password');
  }

  // 4. Government IDs
  if (
    SSN_FORMATTED_REGEX.test(text) ||
    keywordNearValue(text, SSN_KEYWORD_REGEX, SSN_VALUE_REGEX) ||
    keywordNearValue(text, PASSPORT_KEYWORD_REGEX, PASSPORT_VALUE_REGEX) ||
    keywordNearValue(text, LICENSE_KEYWORD_REGEX, LICENSE_VALUE_REGEX) ||
    EIN_FORMATTED_REGEX.test(text) ||
    EIN_KEYWORD_REGEX.test(text)
  ) {
    categories.add('government_id');
  }

  // 5. Health info
  if (HEALTH_KEYWORD_PATTERNS.some((re) => re.test(text))) {
    categories.add('health_info');
  }

  return categories;
}

/**
 * Recursively scans every string value in an object/array and returns the
 * union of matched categories across all of them.
 */
function scanObject(value) {
  const categories = new Set();
  const visit = (v) => {
    if (typeof v === 'string') {
      for (const c of scanText(v)) categories.add(c);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(visit);
    }
  };
  visit(value);
  return categories;
}

/**
 * Throws RedactionBlockedError if the given string or object matches any
 * deny-list category. This is the fail-closed entry point callers should
 * use — it deliberately does not return a "cleaned" version of the input,
 * because the design decision (per product owner) is to block the whole
 * write, not silently strip and continue.
 */
function assertSafe(input) {
  // Lazy require to avoid a require cycle (zep-errors.js has no deps on this file).
  const { RedactionBlockedError } = require('./zep-errors');
  const categories = typeof input === 'string' ? scanText(input) : scanObject(input);
  if (categories.size > 0) {
    throw new RedactionBlockedError(Array.from(categories));
  }
}

module.exports = {
  scanText,
  scanObject,
  assertSafe,
  // exported for direct unit testing / test-zep.js
  luhnValid,
};
