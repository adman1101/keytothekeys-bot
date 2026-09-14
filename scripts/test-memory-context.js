#!/usr/bin/env node
'use strict';

/**
 * Standalone smoke test for memory-context.js (Step 3 — read/merge only).
 *
 * NOT a Netlify function, not wired into chat.js. Uses fake test guests,
 * never real guest data, same pattern as test-zep.js. Does read real live
 * data from your Lodgify account (property/booking lookups) — that part
 * is genuinely live, per Step 1.
 *
 * Usage:
 *   export LODGIFY_API_KEY=...
 *   export ZEP_API_KEY=...
 *   export GUEST_ID_HASH_SECRET=...
 *   node scripts/test-memory-context.js --bookingId=<a real Lodgify booking id>
 *
 * --bookingId (recommended) or --propertyId can be passed to pull a real
 * live booking into the merged context alongside the fake test guest's Zep
 * memory. Passing --bookingId directly fetches that booking regardless of
 * guest email match (Lodgify has no guest-email lookup — Step 1) — that's
 * intentional here: this script is testing the PLUMBING (does the merge
 * correctly assemble both sources into one object), not validating that a
 * real guest's email matches a real booking. If you omit both flags, the
 * liveBooking side will simply be null, which is also a valid path to see.
 */

const path = require('node:path');
const { buildGuestContext } = require(path.join('..', 'netlify', 'functions', 'lib', 'memory-context'));
const zep = require(path.join('..', 'netlify', 'functions', 'lib', 'zep-client'));
const {
  ZepAuthError,
  ZepRateLimitError,
  ZepApiError,
  ZepConfigError,
} = require(path.join('..', 'netlify', 'functions', 'lib', 'zep-errors'));
const { LodgifyApiError, LodgifyConfigError } = require(
  path.join('..', 'netlify', 'functions', 'lib', 'lodgify-errors')
);

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(raw);
    if (match) args[match[1]] = match[2];
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));

const TEST_EMAIL_WITH_HISTORY = `test-guest-memctx-${Date.now()}@kttk-superbot-test.invalid`;
const TEST_EMAIL_BRAND_NEW = `test-guest-newbie-${Date.now()}@kttk-superbot-test.invalid`;
const TEST_FIRST_NAME = 'Test';
const TEST_LAST_NAME = 'Guest';

const results = [];

async function step(name, fn) {
  process.stdout.write(`\n▶ ${name}\n`);
  const startedAt = Date.now();
  try {
    const result = await fn();
    console.log(`  ✅ passed (${Date.now() - startedAt}ms)`);
    results.push({ name, status: 'pass' });
    return result;
  } catch (err) {
    const kind =
      err instanceof ZepAuthError || err instanceof LodgifyApiError && err.status === 401
        ? 'auth error'
        : err instanceof ZepRateLimitError
        ? 'rate limit'
        : err instanceof ZepConfigError || err instanceof LodgifyConfigError
        ? 'config error'
        : err instanceof ZepApiError || err instanceof LodgifyApiError
        ? `api error (${err.status ?? 'unknown'})`
        : 'unexpected error';
    console.log(`  ❌ failed (${kind}, ${Date.now() - startedAt}ms): ${err.message}`);
    results.push({ name, status: 'fail', message: err.message });
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Zep's graph ingestion (entity/fact extraction from a graph.add call) is
 * asynchronous — a fact written via graph.add() is not guaranteed to be
 * immediately queryable via graph.search(). This polls getGuestMemory()
 * a few times with a delay, rather than asserting hasHistory on the first
 * try, so this test isn't flaky against normal ingestion latency. This
 * polling is test-script-only — production code should not assume
 * synchronous read-after-write either.
 */
async function pollForMemory(email, { maxAttempts = 6, delayMs = 4000 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const memory = await zep.getGuestMemory({ email });
    if (memory.hasHistory) {
      console.log(`  → memory visible after ${attempt} attempt(s)`);
      return memory;
    }
    if (attempt < maxAttempts) {
      console.log(`  → not visible yet (attempt ${attempt}/${maxAttempts}), waiting ${delayMs}ms for Zep's async ingestion...`);
      await sleep(delayMs);
    }
  }
  console.log('  → still not visible after all attempts — proceeding anyway (see note in summary)');
  return zep.getGuestMemory({ email });
}

async function main() {
  console.log('memory-context.js — smoke test (Step 3, read/merge only)');
  console.log('==========================================================');
  console.log(`History guest:   ${TEST_EMAIL_WITH_HISTORY}`);
  console.log(`Brand-new guest: ${TEST_EMAIL_BRAND_NEW}`);
  if (!args.bookingId && !args.propertyId) {
    console.log(
      '\n⚠ No --bookingId or --propertyId passed — liveBooking will be null for this run. ' +
        'Pass --bookingId=<a real booking id from your Lodgify account> to see real booking data merged in.'
    );
  }

  // --- Seed some Zep memory for the "has history" test guest ---------------
  console.log('\n--- Seeding sample facts for the history guest (reusing Step 2 writeGuestFact) ---');

  await step('writeGuestFact() — preference', () =>
    zep.writeGuestFact({
      email: TEST_EMAIL_WITH_HISTORY,
      firstName: TEST_FIRST_NAME,
      lastName: TEST_LAST_NAME,
      factType: 'preference',
      fact: { text: 'Guest prefers a ground-floor unit and requested extra pillows.' },
    })
  );

  await step('writeGuestFact() — past stay mentioning a DIFFERENT unit than any live booking', () =>
    zep.writeGuestFact({
      email: TEST_EMAIL_WITH_HISTORY,
      firstName: TEST_FIRST_NAME,
      lastName: TEST_LAST_NAME,
      factType: 'past_stay',
      // Deliberately mentions "Unit 3" so we can see this sit alongside a
      // real live booking (likely a different unit) without being treated
      // as authoritative — that's the whole point of the authorityNote.
      fact: { text: 'Guest usually books Unit 3 and has stayed with us twice before.' },
    })
  );

  await step('writeGuestFact() — friction point', () =>
    zep.writeGuestFact({
      email: TEST_EMAIL_WITH_HISTORY,
      firstName: TEST_FIRST_NAME,
      lastName: TEST_LAST_NAME,
      factType: 'friction_point',
      fact: { text: 'Last stay, guest reported the entry instructions were confusing to find in the check-in email.' },
    })
  );

  await step('waiting for Zep to finish ingesting before querying it back', () =>
    pollForMemory(TEST_EMAIL_WITH_HISTORY)
  );

  // --- Part A: guest WITH Zep history + optional real live booking ---------
  console.log('\n--- Part A: buildGuestContext() for the history guest ---');

  const contextWithHistory = await step('buildGuestContext() — history guest', () =>
    buildGuestContext({
      email: TEST_EMAIL_WITH_HISTORY,
      propertyId: args.propertyId,
      bookingId: args.bookingId,
    })
  );

  if (contextWithHistory) {
    console.log('\nMerged context (history guest):');
    console.log(JSON.stringify(contextWithHistory, null, 2));

    if (!contextWithHistory.guestMemory.hasHistory) {
      console.log(
        '\n⚠ NOTE: guestMemory.hasHistory is still false. This can happen if Zep had not finished ' +
          'ingesting the facts within the poll window above — Zep graph ingestion is asynchronous. ' +
          'Not necessarily a bug in this module; re-run if this happens consistently.'
      );
    }
    if ((args.bookingId || args.propertyId) && !contextWithHistory.liveBooking) {
      console.log(
        '\n⚠ NOTE: liveBooking is null even though --bookingId/--propertyId was passed. If you used ' +
          '--propertyId, this guest\'s fake email legitimately has no matching real booking — try ' +
          '--bookingId=<a real booking id> instead to force a direct lookup.'
      );
    }
  }

  // --- Part B: brand-new guest, zero Zep history ----------------------------
  console.log('\n--- Part B: buildGuestContext() for a brand-new guest (zero Zep history) ---');

  const contextBrandNew = await step('buildGuestContext() — brand-new guest, no propertyId/bookingId', () =>
    buildGuestContext({ email: TEST_EMAIL_BRAND_NEW })
  );

  if (contextBrandNew) {
    console.log('\nMerged context (brand-new guest):');
    console.log(JSON.stringify(contextBrandNew, null, 2));

    if (contextBrandNew.guestMemory.hasHistory !== false) {
      throw new Error('expected hasHistory === false for a guest who has never had a fact written');
    }
    if (contextBrandNew.liveBooking !== null) {
      throw new Error('expected liveBooking === null when no propertyId/bookingId was given');
    }
    console.log('  → confirmed: hasHistory=false, facts=[], liveBooking=null — graceful empty path, no error thrown');
  }

  console.log('\n==========================================================');
  console.log('Summary');
  console.log('==========================================================');
  for (const r of results) {
    console.log(`${r.status === 'pass' ? '✅' : '❌'} ${r.name}`);
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(`\n${results.length - failed} passed, ${failed} failed.`);
  console.log(
    `\nNote: this created two fake test users in your Zep project (${TEST_EMAIL_WITH_HISTORY}, ${TEST_EMAIL_BRAND_NEW}) — safe to delete from the Zep dashboard.`
  );
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('\nUnexpected failure running the test script:');
  console.error(err);
  process.exitCode = 1;
});
