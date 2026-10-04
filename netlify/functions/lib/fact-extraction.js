'use strict';

/**
 * Step 5 — fact extraction for the Zep write path.
 *
 * After a verified guest's conversation turn, chat.js makes ONE additional,
 * intentionally small Claude call whose only job is to decide whether
 * anything from THIS turn (the guest's latest message + the bot's reply)
 * is worth remembering long-term, in one of the factType categories
 * zep-client.js already defines: preference, past_stay, party_context,
 * friction_point, repeat_guest_status.
 *
 * Deliberately scoped to the latest exchange only, not the whole
 * conversation — re-scanning the full transcript every turn would
 * re-extract (and re-write) the same facts repeatedly. Over a multi-turn
 * conversation, each new exchange gets its own extraction pass, so
 * coverage still accumulates turn by turn.
 *
 * This module does NOT call Zep and does NOT run the redaction filter —
 * that happens in zep-client.js's writeGuestFact(), which every fact this
 * module returns must still pass through. This module only decides WHAT
 * might be worth saving; it is not the safety backstop.
 *
 * Never throws on a "normal" miss (nothing worth remembering, or a
 * malformed/non-JSON model response) — those just return []. A genuine
 * failure of the extraction API call itself (network, auth, non-2xx) DOES
 * throw. The caller (chat.js) is responsible for catching that so a
 * broken extraction step can never break the guest-facing reply.
 */

const EXTRACTION_SYSTEM_PROMPT = `You review ONE exchange from a vacation-rental concierge chat (a guest's message and the assistant's reply) and decide whether anything in it is worth remembering about this guest for future stays.

Only extract facts that are:
- Specific to THIS guest (not general property info, not something anyone could ask)
- Durable — true beyond this single conversation (a preference, a notable detail about their party, something that went wrong, a sign they're a repeat guest)
- Something the guest stated or clearly implied — never invent or infer beyond what's said

Do NOT extract:
- Check-in/check-out dates, booking details, balances, or anything already tracked by the booking system
- Door codes, wifi passwords, payment info, or any sensitive/private data
- Small talk with no durable content
- Anything you are not confident about

Respond with ONLY a JSON array (no prose, no markdown fences). Each item: {"factType": one of "preference"|"past_stay"|"party_context"|"friction_point"|"repeat_guest_status", "text": "one plain sentence stating the fact"}. If nothing is worth remembering, respond with exactly: []`;

const VALID_FACT_TYPES = new Set([
  'preference',
  'past_stay',
  'party_context',
  'friction_point',
  'repeat_guest_status',
]);

function buildUserPrompt({ guestMessage, assistantReply }) {
  return `Guest's message:\n${guestMessage}\n\nAssistant's reply:\n${assistantReply}`;
}

/**
 * Parses the model's response text into a validated facts array. Never
 * throws — any shape mismatch (not JSON, not an array, missing/invalid
 * fields) is treated as "nothing extractable" rather than an error, since
 * a model occasionally ignoring the "JSON only" instruction is expected
 * and should degrade quietly, not break the write path.
 */
function safeParseFacts(raw) {
  if (typeof raw !== 'string') return [];
  // Strip accidental markdown fences in case the model adds them anyway.
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        VALID_FACT_TYPES.has(item.factType) &&
        typeof item.text === 'string' &&
        item.text.trim().length > 0
    )
    .map((item) => ({ factType: item.factType, text: item.text.trim() }));
}

/**
 * @param {object} params
 * @param {string} params.guestMessage - the guest's latest message text
 * @param {string} params.assistantReply - the bot's reply text for that turn
 * @returns {Promise<Array<{factType: string, text: string}>>}
 */
async function extractGuestFacts({ guestMessage, assistantReply }) {
  if (!guestMessage || !assistantReply) return [];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      // Haiku on purpose: this call is a small yes/no-plus-category judgment
      // that runs on every verified guest turn, so the cheaper, faster model
      // is the right fit. The guest-facing reply in chat.js uses Sonnet.
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt({ guestMessage, assistantReply }) }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Fact-extraction call failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const textBlock = Array.isArray(data?.content) ? data.content.find((b) => b?.type === 'text') : null;
  return safeParseFacts(textBlock?.text);
}

module.exports = { extractGuestFacts };
