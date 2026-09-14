#!/usr/bin/env node
'use strict';

/**
 * Standalone smoke test for the read-only Lodgify client.
 *
 * This is intentionally NOT a Netlify function and is not wired into
 * chat.js or any guest-facing code path — it's a plain Node script for
 * exercising the client against live Lodgify data before Phase 2 (Zep
 * memory layer / bot integration) touches any of this.
 *
 * Usage:
 *   export LODGIFY_API_KEY=your_real_key
 *   node scripts/test-lodgify.js
 *
 *   # or, if you keep it in a .env file (Node 20.6+ supports --env-file):
 *   node --env-file=.env scripts/test-lodgify.js
 *
 * Optional args to target specific records once you've seen the property
 * list output (all optional — the script skips a test if the id it needs
 * wasn't supplied and couldn't be inferred from an earlier step):
 *   node scripts/test-lodgify.js --propertyId=123 --bookingId=456
 */

const path = require('node:path');
const lodgify = require(path.join('..', 'netlify', 'functions', 'lib', 'lodgify-client'));
const {
  LodgifyAuthError,
  LodgifyPermissionError,
  LodgifyRateLimitError,
  LodgifyServerError,
  LodgifyApiError,
  LodgifyConfigError,
} = require(path.join('..', 'netlify', 'functions', 'lib', 'lodgify-errors'));

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(raw);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

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
      err instanceof LodgifyAuthError
        ? 'auth (401)'
        : err instanceof LodgifyPermissionError
        ? 'permission (403)'
        : err instanceof LodgifyRateLimitError
        ? 'rate limit (429)'
        : err instanceof LodgifyServerError
        ? 'server error (5xx)'
        : err instanceof LodgifyConfigError
        ? 'config error'
        : err instanceof LodgifyApiError
        ? `api error (${err.status ?? 'unknown status'})`
        : 'unexpected error';
    console.log(`  ❌ failed (${kind}, ${ms}ms): ${err.message}`);
    results.push({ name, status: 'fail', ms, kind, message: err.message });
    return null;
  }
}

function skip(name, reason) {
  console.log(`\n▶ ${name}\n  ⏭  skipped: ${reason}`);
  results.push({ name, status: 'skip', reason });
}

async function main() {
  console.log('Lodgify read-only client — smoke test');
  console.log('======================================');
  console.log('This will make a handful of live GET requests against your Lodgify account.');

  // 1. List properties
  const propertiesPage = await step('listProperties()', () => lodgify.listProperties({ size: 10 }));

  const discoveredPropertyId =
    args.propertyId ||
    (propertiesPage && Array.isArray(propertiesPage.items ?? propertiesPage) &&
      (propertiesPage.items ?? propertiesPage)[0]?.id);

  if (propertiesPage) {
    const items = propertiesPage.items ?? propertiesPage;
    console.log(`  → got ${Array.isArray(items) ? items.length : '?'} properties back`);
  }

  // 2. Get a single property
  if (discoveredPropertyId) {
    await step(`getProperty(${discoveredPropertyId})`, () => lodgify.getProperty(discoveredPropertyId));
  } else {
    skip('getProperty()', 'no propertyId available (pass --propertyId=... or ensure listProperties returns items)');
  }

  // 3. List bookings for that property
  let bookingsForProperty = null;
  if (discoveredPropertyId) {
    bookingsForProperty = await step(`getBookingsForProperty(${discoveredPropertyId})`, () =>
      lodgify.getBookingsForProperty(discoveredPropertyId, { stayFilter: 'All', size: 10 })
    );
    if (bookingsForProperty) {
      const items = bookingsForProperty.items ?? bookingsForProperty;
      console.log(`  → got ${Array.isArray(items) ? items.length : '?'} bookings back`);
    }
  } else {
    skip('getBookingsForProperty()', 'no propertyId available');
  }

  // 4. Get a single booking
  const items = bookingsForProperty && (bookingsForProperty.items ?? bookingsForProperty);
  const discoveredBookingId = args.bookingId || (Array.isArray(items) && items[0]?.id);

  let singleBooking = null;
  if (discoveredBookingId) {
    singleBooking = await step(`getBooking(${discoveredBookingId})`, () => lodgify.getBooking(discoveredBookingId));
  } else {
    skip('getBooking()', 'no bookingId available (pass --bookingId=... or ensure a booking was found above)');
  }

  // 5. Get guest details for that booking
  if (discoveredBookingId) {
    await step(`getGuestForBooking(${discoveredBookingId})`, async () => {
      const guest = await lodgify.getGuestForBooking(discoveredBookingId);
      if (!guest) throw new Error('booking had no guest object');
      console.log(`  → guest: ${guest.name ?? '(no name)'} <${guest.email ?? 'no email'}>`);
      return guest;
    });
  } else {
    skip('getGuestForBooking()', 'no bookingId available');
  }

  // 6. Client-side guest filtering (no extra API call — reuses bookingsForProperty)
  if (Array.isArray(items) && items.length) {
    await step('findBookingsByGuest() [client-side, no API call]', () => {
      const sampleGuestName = items[0]?.guest?.name;
      if (!sampleGuestName) throw new Error('no guest name on first booking to test against');
      const matches = lodgify.findBookingsByGuest(items, { name: sampleGuestName.split(' ')[0] });
      if (!matches.length) throw new Error('expected at least one match filtering by a known guest name');
      console.log(`  → found ${matches.length} booking(s) for "${sampleGuestName.split(' ')[0]}"`);
      return matches;
    });
  } else {
    skip('findBookingsByGuest()', 'no bookings with guest data available to test against');
  }

  // 7. Error-path sanity check: deliberately bad property id should raise cleanly
  await step('error handling: getProperty() with an invalid id fails loudly (not silently)', async () => {
    try {
      await lodgify.getProperty('this-property-id-should-not-exist-000000');
      throw new Error('expected an error to be thrown for an invalid property id, but none was');
    } catch (err) {
      if (err instanceof LodgifyApiError) {
        console.log(`  → correctly threw ${err.name} (status ${err.status})`);
        return err;
      }
      throw err;
    }
  });

  console.log('\n======================================');
  console.log('Summary');
  console.log('======================================');
  for (const r of results) {
    const marker = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⏭ ';
    console.log(`${marker} ${r.name}`);
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('\nUnexpected failure running the test script:');
  console.error(err);
  process.exitCode = 1;
});
