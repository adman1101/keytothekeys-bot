#!/usr/bin/env node
'use strict';

/**
 * Standalone smoke test for the Zep write-path client + redaction filter.
 *
 * NOT a Netlify function, not wired into chat.js, and does not touch live
 * Lodgify data — uses a fake test guest, never a real one.
 *
 * Usage:
 *   export ZEP_API_KEY=your_real_key
 *   export GUEST_ID_HASH_SECRET=the_secret_saved_in_netlify
 *   node scripts/test-zep.js
 *
 *   # or: node --env-file=.env scripts/test-zep.js
 */

const path = require('node:path');
const zep = require(path.join('..', 'netlify', 'functions', 'lib', 'zep-client'));
const redaction = require(path.join('..', 'netlify', 'functions', 'lib', 'redaction'));
const {
  ZepAuthError,
  ZepPermissionError,
  ZepRateLimitError,
  ZepValidationError,
  ZepServerError,
  ZepApiError,
  ZepConfigError,
  RedactionBlockedError,
} = require(path.join('..', 'netlify', 'functions', 'lib', 'zep-errors'));

// Fake test guest — never a real one. Randomized per run via timestamp so
// repeated runs don't collide, but stays obviously fake.
const TEST_EMAIL = `test-guest-${Date.now()}@kttk-superbot-test.invalid`;
const TEST_FIRST_NAME = 'Test';
const TEST_LAST_NAME = 'Guest';

const results = [];

async function step(name, fn) {
  process.stdout.write(`\n▶ ${name}\n`);
  const startedAt = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - startedAt;
    console.log(`  ✅ passed (${ms}ms)`);
    results.push({ name, status: 'pass', ms });
    return result;
  } catch (err) {
    const ms = Date.now() - startedAt;
    const kind =
      err instanceof ZepAuthError
        ? 'auth (401)'
        : err instanceof ZepPermissionError
        ? 'permission (403)'
        : err instanceof ZepRateLimitError
        ? 'rate limit (429)'
        : err instanceof ZepValidationError
        ? 'validation error'
        : err instanceof ZepServerError
        ? 'server error (5xx)'
        : err instanceof ZepConfigError
        ? 'config error'
        : err instanceof RedactionBlockedError
        ? 'redaction blocked'
        : err instanceof ZepApiError
        ? `api error (${err.status ?? 'unknown status'})`
        : 'unexpected error';
    console.log(`  ❌ failed (${kind}, ${ms}ms): ${err.message}`);
    results.push({ name, status: 'fail', ms, kind, message: err.message });
    return null;
  }
}

function expectStep(name, fn) {
  // Like step(), but for a case where THROWING is the expected/correct
  // outcome (e.g. the redaction filter should block a fake card number).
  process.stdout.write(`\n▶ ${name}\n`);
  const startedAt = Date.now();
  return fn()
    .then(() => {
      const ms = Date.now() - startedAt;
      console.log(`  ❌ failed (${ms}ms): expected this to throw RedactionBlockedError, but it did not`);
      results.push({ name, status: 'fail', ms, message: 'expected a throw that did not happen' });
      return false;
    })
    .catch((err) => {
      const ms = Date.now() - startedAt;
      if (err instanceof RedactionBlockedError) {
        console.log(`  ✅ passed (${ms}ms) — correctly blocked. Categories: ${err.categories.join(', ')}`);
        results.push({ name, status: 'pass', ms });
        return true;
      }
      console.log(`  ❌ failed (${ms}ms): threw, but not RedactionBlockedError — ${err.name}: ${err.message}`);
      results.push({ name, status: 'fail', ms, message: err.message });
      return false;
    });
}

async function main() {
  console.log('Zep write-path client — smoke test');
  console.log('===================================');
  console.log(`Using fake test guest: ${TEST_EMAIL}`);

  // --- Part A: redaction filter, offline, no network at all ---------------
  console.log('\n--- Part A: redaction filter (pure functions, no network) ---');

  await step('redaction.scanText() detects a Luhn-valid fake test card number', () => {
    // 4111 1111 1111 1111 is a well-known, publicly documented test Visa
    // number used by payment processors for sandbox testing — not a real card.
    const categories = redaction.scanText('my card number is 4111 1111 1111 1111 thanks');
    if (!categories.has('payment_info')) {
      throw new Error(`expected payment_info to be detected, got: ${Array.from(categories).join(', ') || '(none)'}`);
    }
    return categories;
  });

  await step('redaction.scanText() does NOT flag an ordinary booking confirmation number', () => {
    // Sanity check against false positives on similarly-shaped but benign data.
    const categories = redaction.scanText('Your booking confirmation number is 8827301');
    if (categories.size > 0) {
      throw new Error(`expected no match, got: ${Array.from(categories).join(', ')}`);
    }
    return categories;
  });

  await step('redaction.scanText() detects a door code mention', () => {
    const categories = redaction.scanText('the gate code is 4471 for the west entrance');
    if (!categories.has('door_gate_lock_code')) {
      throw new Error(`expected door_gate_lock_code, got: ${Array.from(categories).join(', ') || '(none)'}`);
    }
    return categories;
  });

  await step('redaction.scanText() detects health information', () => {
    const categories = redaction.scanText('guest mentioned a medical condition requiring a wheelchair-accessible room');
    if (!categories.has('health_info')) {
      throw new Error(`expected health_info, got: ${Array.from(categories).join(', ') || '(none)'}`);
    }
    return categories;
  });

  // --- Part B: live Zep calls, using only fake test data -------------------
  console.log('\n--- Part B: live Zep calls (fake test guest, no real guest data) ---');

  await step(`ensureUser() creates the test user (${TEST_EMAIL})`, async () => {
    const { userId, created } = await zep.ensureUser({
      email: TEST_EMAIL,
      firstName: TEST_FIRST_NAME,
      lastName: TEST_LAST_NAME,
    });
    if (!created) throw new Error('expected created=true on first call for a brand-new email');
    console.log(`  → userId: ${userId}`);
    return userId;
  });

  await step('ensureUser() is idempotent — second call finds the existing user', async () => {
    const { userId, created } = await zep.ensureUser({
      email: TEST_EMAIL,
      firstName: TEST_FIRST_NAME,
      lastName: TEST_LAST_NAME,
    });
    if (created) throw new Error('expected created=false on second call for the same email — got a fresh create instead');
    console.log(`  → userId: ${userId} (found existing, not recreated)`);
    return userId;
  });

  await step('hashGuestId() is stable for the same email regardless of case/whitespace', () => {
    const a = zep.hashGuestId(TEST_EMAIL);
    const b = zep.hashGuestId(`  ${TEST_EMAIL.toUpperCase()}  `);
    if (a !== b) throw new Error(`expected identical hashes, got ${a} vs ${b}`);
    return a;
  });

  await step('writeGuestFact() writes a safe sample preference', () =>
    zep.writeGuestFact({
      email: TEST_EMAIL,
      firstName: TEST_FIRST_NAME,
      lastName: TEST_LAST_NAME,
      factType: 'preference',
      fact: { text: 'Guest prefers a ground-floor unit and requested extra pillows.' },
    })
  );

  await step('writeGuestFact() writes a safe sample past-stay fact', () =>
    zep.writeGuestFact({
      email: TEST_EMAIL,
      firstName: TEST_FIRST_NAME,
      lastName: TEST_LAST_NAME,
      factType: 'past_stay',
      fact: { text: 'Stayed at Ocean Breeze Cottage in June for a 5-night trip, celebrated an anniversary.' },
    })
  );

  await step('writeGuestFact() writes a safe sample repeat-guest-status fact', () =>
    zep.writeGuestFact({
      email: TEST_EMAIL,
      firstName: TEST_FIRST_NAME,
      lastName: TEST_LAST_NAME,
      factType: 'repeat_guest_status',
      fact: { text: 'Second stay with us this year; first stay was well-reviewed.' },
    })
  );

  // --- Part C: prove the redaction filter is a REAL backstop, not just docs -
  console.log('\n--- Part C: prove the redaction filter blocks a write end-to-end ---');

  await expectStep('writeGuestFact() blocks a fact containing a fake credit card number', () =>
    zep.writeGuestFact({
      email: TEST_EMAIL,
      firstName: TEST_FIRST_NAME,
      lastName: TEST_LAST_NAME,
      factType: 'friction_point',
      // Same well-known test Visa number as above — fake, not a real card.
      fact: { text: 'Guest asked us to store their card number 4111 1111 1111 1111 for incidentals.' },
    })
  );

  await expectStep('writeGuestFact() blocks a fact containing a door code', () =>
    zep.writeGuestFact({
      email: TEST_EMAIL,
      firstName: TEST_FIRST_NAME,
      lastName: TEST_LAST_NAME,
      factType: 'friction_point',
      fact: { text: 'Guest was told the lockbox code is 9284 ahead of check-in.' },
    })
  );

  console.log('\n===================================');
  console.log('Summary');
  console.log('===================================');
  for (const r of results) {
    const marker = r.status === 'pass' ? '✅' : '❌';
    console.log(`${marker} ${r.name}`);
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(`\n${results.length - failed} passed, ${failed} failed.`);
  console.log(
    `\nNote: this created a real (but obviously fake) test user in your Zep project: ${TEST_EMAIL} — safe to delete from the Zep dashboard.`
  );
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('\nUnexpected failure running the test script:');
  console.error(err);
  process.exitCode = 1;
});
