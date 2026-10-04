#!/usr/bin/env node
'use strict';

/**
 * Standalone smoke test for fact-extraction.js (Step 5 — write path).
 *
 * NOT a Netlify function. Uses fake test exchanges and a fake test guest —
 * never real guest data — same pattern as test-zep.js / test-memory-context.js.
 * Part A exercises extractGuestFacts() directly (a real Claude API call).
 * Part B chains extraction -> zep.writeGuestFact() for each extracted fact,
 * the same sequence chat.js's saveFactsFromTurn() runs after a real guest
 * turn, so this is the closest thing to an integration test for Step 5
 * short of hitting the live chat.js endpoint.
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=...
 *   export ZEP_API_KEY=...
 *   export GUEST_ID_HASH_SECRET=...
 *   node scripts/test-fact-extraction.js
 */

const path = require('node:path');
const { extractGuestFacts } = require(path.join('..', 'netlify', 'functions', 'lib', 'fact-extraction'));
const zep = require(path.join('..', 'netlify', 'functions', 'lib', 'zep-client'));
const { RedactionBlockedError } = require(path.join('..', 'netlify', 'functions', 'lib', 'zep-errors'));

const TEST_EMAIL = `test-guest-factext-${Date.now()}@kttk-superbot-test.invalid`;
const TEST_FIRST_NAME = 'Test';

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
    console.log(`  ❌ failed (${Date.now() - startedAt}ms): ${err.message}`);
    results.push({ name, status: 'fail', message: err.message });
    return null;
  }
}

async function main() {
  console.log('fact-extraction.js — smoke test (Step 5, write path)');
  console.log('======================================================');
  console.log(`Using fake test guest: ${TEST_EMAIL}`);

  // --- Part A: extraction should find something worth remembering ----------
  console.log('\n--- Part A: a turn WITH a durable fact ---');

  const factsFromRealExchange = await step('extractGuestFacts() finds a preference in a realistic exchange', async () => {
    const facts = await extractGuestFacts({
      guestMessage:
        "We'll be celebrating my wife's birthday during our stay, and we'd really prefer a ground-floor unit since she's recovering from a knee injury and stairs are tough right now.",
      assistantReply:
        "Happy early birthday to your wife, and congratulations on finding the perfect spot for a relaxing celebration! I've made a note that a ground-floor unit works best for you — several of our properties, like Manatee Hideout, have ground-floor bedroom options. Let us know if you'd like help picking the best fit!",
    });
    if (facts.length === 0) {
      throw new Error('expected at least one fact (preference and/or party_context), got zero');
    }
    console.log(`  → extracted ${facts.length} fact(s):`, JSON.stringify(facts, null, 2));
    return facts;
  });

  // --- Part B: extraction should find NOTHING for pure small talk ----------
  console.log('\n--- Part B: a turn with NOTHING worth remembering ---');

  await step('extractGuestFacts() returns [] for routine small talk', async () => {
    const facts = await extractGuestFacts({
      guestMessage: 'What time is check-in?',
      assistantReply:
        'Check-in details and your door code are sent automatically through the platform you booked on, on the day of check-in at 8:00 AM. If it is after 8 AM and you have not received it, call or text the team at (786) 551-4855!',
    });
    if (facts.length !== 0) {
      throw new Error(`expected zero facts for routine small talk, got ${facts.length}: ${JSON.stringify(facts)}`);
    }
    console.log('  → correctly extracted nothing');
  });

  // --- Part C: extraction must not surface sensitive data as a "fact" ------
  console.log('\n--- Part C: a turn that mentions a door code (must not be extracted) ---');

  await step('extractGuestFacts() does not extract a door code as a fact', async () => {
    const facts = await extractGuestFacts({
      guestMessage: 'Can you remind me of the gate code? I think it was 4471.',
      assistantReply:
        "I'm not able to share door or gate codes here — those are sent automatically through your booking platform on the day of check-in. If you haven't received it, call or text the team at (786) 551-4855!",
    });
    const leaked = facts.some((f) => /\b4471\b/.test(f.text));
    if (leaked) {
      throw new Error(`a fact leaked the door code: ${JSON.stringify(facts)}`);
    }
    console.log(`  → ${facts.length} fact(s) extracted, none contain the code`);
  });

  // --- Part D: full chain — extraction -> writeGuestFact(), one by one -----
  console.log('\n--- Part D: full Step 5 chain (extraction -> Zep write), same sequence as chat.js ---');

  if (factsFromRealExchange && factsFromRealExchange.length > 0) {
    for (const fact of factsFromRealExchange) {
      await step(`writeGuestFact() — ${fact.factType}: "${fact.text.slice(0, 60)}..."`, async () => {
        try {
          return await zep.writeGuestFact({
            email: TEST_EMAIL,
            firstName: TEST_FIRST_NAME,
            factType: fact.factType,
            fact: { text: fact.text },
          });
        } catch (err) {
          if (err instanceof RedactionBlockedError) {
            console.log(`  (redaction blocked this one — categories: ${err.categories.join(', ')} — that's the filter working, not a bug)`);
            return null;
          }
          throw err;
        }
      });
    }
  } else {
    console.log('  (skipped — Part A did not produce facts to chain)');
  }

  console.log('\n======================================================');
  console.log('Summary');
  console.log('======================================================');
  for (const r of results) {
    console.log(`${r.status === 'pass' ? '✅' : '❌'} ${r.name}`);
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(`\n${results.length - failed} passed, ${failed} failed.`);
  console.log(`\nNote: this may have created a fake test user in your Zep project (${TEST_EMAIL}) — safe to delete from the Zep dashboard.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('\nUnexpected failure running the test script:');
  console.error(err);
  process.exitCode = 1;
});
