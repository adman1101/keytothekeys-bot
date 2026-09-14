'use strict';

/**
 * Zep Cloud client — write path (Step 2) + guest memory retrieval (Step 3).
 *
 * Write side: creates/ensures guest user records and writes durable facts
 * to a guest's graph. Read side (added Step 3): getGuestMemory() pulls a
 * guest's stored facts back via graph.search(scope:'auto') for use by
 * memory-context.js. Does NOT call user.warm() (gets wired to a Lodgify
 * booking-confirmation webhook in a later step), and this file itself is
 * still not imported by chat.js or connected to a live guest conversation.
 *
 * Every write funnels through writeGuestFact(), which runs the redaction
 * filter (redaction.js) FIRST, before anything touches the Zep SDK. A
 * redaction hit throws RedactionBlockedError and the graph.add() call is
 * never made — this is a fail-closed backstop, not best-effort stripping.
 *
 * IMPORTANT for whoever wires this into a caller later: writeGuestFact()
 * handles exactly ONE fact per call. There is no batching here. If a
 * future caller writes multiple facts from one conversation turn via
 * `Promise.all(facts.map(f => writeGuestFact(...)))`, ONE rejected
 * promise (e.g. a single blocked fact) will reject the whole Promise.all
 * and silently drop the other, perfectly fine facts too. Use a per-item
 * try/catch loop or Promise.allSettled instead, so a block on fact #3
 * only affects fact #3.
 */

const crypto = require('node:crypto');
const {
  ZepAuthError,
  ZepPermissionError,
  ZepRateLimitError,
  ZepValidationError,
  ZepServerError,
  ZepApiError,
  ZepConfigError,
} = require('./zep-errors');
const redaction = require('./redaction');

// Zep's Flex-tier documented limit is 600 requests/minute. Self-throttle
// below that for the same reason as the Lodgify client: don't rely on
// their 429 as the only guardrail.
const MAX_CALLS_PER_MINUTE = 500;
const WINDOW_MS = 60 * 1000;
const callTimestamps = [];

let cachedClient = null;

function getZepApiKey() {
  const key = process.env.ZEP_API_KEY;
  if (!key) {
    throw new ZepConfigError(
      'ZEP_API_KEY environment variable is not set. Set it in your Netlify env vars (or local shell) — it is never read from anywhere else.'
    );
  }
  return key;
}

function getHashSecret() {
  const secret = process.env.GUEST_ID_HASH_SECRET;
  if (!secret) {
    throw new ZepConfigError(
      'GUEST_ID_HASH_SECRET environment variable is not set. This is the HMAC pepper used to derive guest user IDs — required before any Zep write.'
    );
  }
  return secret;
}

function getClient() {
  if (cachedClient) return cachedClient;
  const apiKey = getZepApiKey();
  // eslint-disable-next-line global-require
  const { ZepClient } = require('@getzep/zep-cloud');
  cachedClient = new ZepClient({ apiKey });
  return cachedClient;
}

/** Structured, single-line JSON logging. Never pass the API key or hash secret in here. */
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

async function waitForRateLimitSlot() {
  const now = Date.now();
  while (callTimestamps.length && now - callTimestamps[0] > WINDOW_MS) {
    callTimestamps.shift();
  }
  if (callTimestamps.length >= MAX_CALLS_PER_MINUTE) {
    const oldest = callTimestamps[0];
    const waitMs = WINDOW_MS - (now - oldest) + 25;
    logEvent('warn', 'zep_client_throttling', { waitMs, callsInWindow: callTimestamps.length });
    await sleep(Math.max(waitMs, 0));
    return waitForRateLimitSlot();
  }
  callTimestamps.push(Date.now());
}

/**
 * Derives a stable, privacy-safe guest user ID from an email address.
 * HMAC-SHA256 keyed with GUEST_ID_HASH_SECRET — NOT a plain hash, because a
 * plain SHA-256 of an email is trivially reversible via a rainbow table of
 * common addresses. Without the secret (which lives only in env vars), the
 * output can't be reversed back to the email.
 *
 * Same email always produces the same ID (case/whitespace-insensitive), so
 * this is safe to call on every booking without creating duplicate users.
 */
function hashGuestId(email) {
  if (!email || typeof email !== 'string') {
    throw new Error('hashGuestId requires a non-empty email string');
  }
  const secret = getHashSecret();
  const normalized = email.trim().toLowerCase();
  const digest = crypto.createHmac('sha256', secret).update(normalized).digest('hex');
  return `guest_${digest}`;
}

/**
 * Wraps a Zep SDK call: applies the rate gate, logs start/success/error,
 * and re-throws the SDK's generic ZepError as one of our typed errors
 * based on .statusCode.
 */
async function callZep(event, identifier, fn) {
  logEvent('info', `${event}_start`, { identifier: identifier ?? null });
  await waitForRateLimitSlot();

  const startedAt = Date.now();
  try {
    const result = await fn();
    logEvent('info', `${event}_success`, {
      identifier: identifier ?? null,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const status = err && typeof err.statusCode === 'number' ? err.statusCode : null;
    const commonFields = {
      identifier: identifier ?? null,
      status,
      durationMs,
      zepMessage: err && err.message ? String(err.message).slice(0, 500) : null,
    };

    if (status === 401) {
      logEvent('error', `${event}_auth_failed`, commonFields);
      throw new ZepAuthError(`Zep rejected the API key (401) during ${event}. Check ZEP_API_KEY.`, {
        status: 401,
        endpoint: event,
      });
    }
    if (status === 403) {
      logEvent('error', `${event}_permission_denied`, commonFields);
      throw new ZepPermissionError(`Zep denied permission (403) during ${event}.`, {
        status: 403,
        endpoint: event,
      });
    }
    if (status === 429) {
      logEvent('error', `${event}_rate_limited`, commonFields);
      throw new ZepRateLimitError(`Zep rate limit hit (429) during ${event}. Flex tier limit is 600 calls/min.`, {
        status: 429,
        endpoint: event,
      });
    }
    if (status === 400 || status === 422) {
      logEvent('error', `${event}_validation_failed`, commonFields);
      throw new ZepValidationError(`Zep rejected the request (${status}) during ${event}.`, {
        status,
        endpoint: event,
      });
    }
    if (status && status >= 500) {
      logEvent('error', `${event}_server_error`, commonFields);
      throw new ZepServerError(`Zep server error (${status}) during ${event}. Safe to retry later.`, {
        status,
        endpoint: event,
      });
    }

    logEvent('error', `${event}_failed`, commonFields);
    throw new ZepApiError(`Zep call failed during ${event}${status ? ` (${status})` : ''}: ${err.message}`, {
      status,
      endpoint: event,
    });
  }
}

/**
 * Ensures a Zep user record exists for this guest, keyed by the hashed
 * user ID, with the REAL plaintext email/first/last name populated (per
 * Zep's entity-resolution requirement — the hashed ID is the identifier,
 * the plaintext email is what lets an incoming Lodgify booking auto-link
 * to the right guest graph). Idempotent — safe to call on every booking.
 */
async function ensureUser({ email, firstName, lastName } = {}) {
  if (!email) throw new Error('ensureUser requires an email');
  const userId = hashGuestId(email);
  const client = getClient();

  try {
    const existing = await callZep('zep_user_get', userId, () => client.user.get(userId));
    return { userId, created: false, user: existing };
  } catch (err) {
    if (err instanceof ZepApiError && err.status === 404) {
      const created = await callZep('zep_user_add', userId, () =>
        client.user.add({ userId, email, firstName, lastName })
      );
      return { userId, created: true, user: created };
    }
    throw err;
  }
}

/**
 * Writes ONE durable guest fact to that guest's graph via graph.add(type="json").
 * Redaction runs first — a match throws RedactionBlockedError and NOTHING
 * is sent to Zep. See the module-level comment above re: batching caveats.
 *
 * @param {object} params
 * @param {string} params.email - guest email (used to derive/ensure the user)
 * @param {string} params.firstName
 * @param {string} params.lastName
 * @param {'preference'|'past_stay'|'party_context'|'friction_point'|'repeat_guest_status'} params.factType
 * @param {object} params.fact - the actual structured fact payload, e.g. { text: '...', details: {...} }
 */
async function writeGuestFact({ email, firstName, lastName, factType, fact } = {}) {
  if (!email) throw new Error('writeGuestFact requires an email');
  if (!factType) throw new Error('writeGuestFact requires a factType');
  if (!fact || typeof fact !== 'object') throw new Error('writeGuestFact requires a fact object');

  // Redaction check runs BEFORE anything else — before we even ensure the
  // user exists — so a blocked fact never causes any side effect in Zep.
  redaction.assertSafe(fact);
  redaction.assertSafe(factType);

  const { userId } = await ensureUser({ email, firstName, lastName });

  const payload = {
    factType,
    ...fact,
    recordedAt: new Date().toISOString(),
  };

  const result = await callZep('zep_graph_add', userId, () =>
    getClient().graph.add({
      userId,
      type: 'json',
      data: JSON.stringify(payload),
    })
  );

  return { userId, factType, result };
}

// Fixed, broad search query used for "give me everything relevant" lookups.
// Zep's graph.search has no unfiltered-dump endpoint — `query` is required —
// so this deliberately spans the same categories Step 2 writes (preference,
// past_stay, party_context, friction_point, repeat_guest_status) rather than
// trying to guess a narrower query per call site.
const GUEST_MEMORY_QUERY = 'guest preferences, past stays, party context, friction points, repeat-guest status';

/**
 * Retrieves a guest's stored memory/facts from their Zep graph in a single
 * call: client.graph.search({ userId, query, scope: 'auto', returnRawResults: true }).
 * scope:'auto' makes Zep return a ready-composed `context` string; the
 * `returnRawResults: true` flag is REQUIRED to also get `edges`/`episodes`
 * back on the same response — confirmed against the SDK's actual type defs
 * (GraphSearchQuery.d.ts): those raw fields are server-gated behind that
 * flag when scope is 'auto' and are simply absent without it. Without this
 * flag, facts below would always come back empty even when context clearly
 * has data in it (this was a real bug here until it was added).
 *
 * Facts come from two different shapes and are merged into one array:
 *   - `episodes`: the raw documents we wrote via writeGuestFact()'s
 *     graph.add(type:'json') calls. episode.content is the exact JSON
 *     string we originally passed as `data` — parsed back into an object
 *     here so callers get structured facts, not a string to re-parse
 *     themselves. A non-JSON or unparseable episode (e.g. something else
 *     wrote a plain-text episode to this graph) is skipped, not thrown —
 *     one bad episode shouldn't break the whole memory read.
 *   - `edges`: Zep's own extracted entity/relationship facts (natural-
 *     language `fact` strings) derived from those episodes over time by
 *     Zep's own pipeline — included too since they may surface useful
 *     relationships episodes alone don't spell out. Extraction is
 *     asynchronous, so a freshly-written episode may show up in `episodes`
 *     before any corresponding `edges` exist yet — that's expected, not a bug.
 *     Deduped against episodeFacts: an edge is dropped if its `episodes`
 *     field (the source episode UUID(s) it was extracted from) overlaps
 *     with an episodeUuid already surfaced above, so the same underlying
 *     fact doesn't appear twice (once verbatim, once paraphrased).
 *
 * The two shapes are deliberately NOT normalized into one common shape —
 * an episodeFacts entry carries whatever fields writeGuestFact() wrote
 * (factType, text, recordedAt, ...); an edgeFacts entry carries raw
 * EntityEdge fields (fact, validAt, invalidAt, score). Check `.source`
 * ('episode' vs 'edge') to know which shape you're looking at.
 *
 * Brand-new guest with no history yet is NOT an error — this returns
 * { hasHistory: false, context: '', facts: [] } rather than throwing. A
 * real Zep failure (auth/rate-limit/5xx) still throws loudly, same as
 * every other call in this module — "no history" and "Zep is broken" must
 * stay distinguishable to the caller.
 *
 * @param {object} params
 * @param {string} params.email
 * @param {number} [params.limit=20] - max facts to return (applies per-scope on the server side)
 */
async function getGuestMemory({ email, limit = 20 } = {}) {
  if (!email) throw new Error('getGuestMemory requires an email');
  const userId = hashGuestId(email);
  const client = getClient();

  let result;
  try {
    result = await callZep('zep_graph_search', userId, () =>
      client.graph.search({
        userId,
        query: GUEST_MEMORY_QUERY,
        scope: 'auto',
        limit,
        returnRawResults: true,
      })
    );
  } catch (err) {
    // Treat a 404-shaped "nothing here yet" the same way ensureUser() does
    // for a missing user — gracefully, not as a failure. Everything else
    // (401/403/429/5xx/validation) still propagates as a typed error.
    if (err instanceof ZepApiError && err.status === 404) {
      logEvent('info', 'zep_graph_search_no_history', { identifier: userId });
      return { userId, hasHistory: false, context: '', facts: [] };
    }
    throw err;
  }

  const context = typeof result?.context === 'string' ? result.context : '';
  const rawEdges = Array.isArray(result?.edges) ? result.edges : [];
  const rawEpisodes = Array.isArray(result?.episodes) ? result.episodes : [];

  const episodeFacts = [];
  let unparsableEpisodeCount = 0;
  for (const episode of rawEpisodes) {
    if (episode?.source !== 'json' || typeof episode.content !== 'string') {
      // Not one of our structured writes (e.g. a plain-text or message-type
      // episode) — nothing to parse into a structured fact, skip quietly.
      continue;
    }
    try {
      const parsed = JSON.parse(episode.content);
      episodeFacts.push({
        source: 'episode',
        ...parsed,
        episodeUuid: episode.uuid ?? null,
        episodeCreatedAt: episode.createdAt ?? null,
      });
    } catch {
      // A malformed/partial JSON episode shouldn't break the whole read —
      // log it so it's investigable, but keep going.
      unparsableEpisodeCount += 1;
    }
  }
  if (unparsableEpisodeCount > 0) {
    logEvent('warn', 'zep_graph_search_unparsable_episode', {
      identifier: userId,
      unparsableEpisodeCount,
    });
  }

  // Dedup: an edge derived (by Zep's own extraction pipeline) from an
  // episode we've already surfaced via episodeFacts would otherwise show
  // the same underlying fact twice — once verbatim (the episode), once
  // paraphrased (the edge). EntityEdge carries an `episodes` field listing
  // the source episode UUID(s) it was extracted from; if any of those
  // UUIDs match an episodeUuid already in episodeFacts, drop the edge.
  const episodeUuidsAlreadySurfaced = new Set(episodeFacts.map((f) => f.episodeUuid).filter(Boolean));

  const edgeFacts = rawEdges
    .filter((edge) => {
      const sourceEpisodeUuids = Array.isArray(edge.episodes) ? edge.episodes : [];
      const isDerivedFromAnAlreadySurfacedEpisode = sourceEpisodeUuids.some((uuid) =>
        episodeUuidsAlreadySurfaced.has(uuid)
      );
      return !isDerivedFromAnAlreadySurfacedEpisode;
    })
    .map((edge) => ({
      source: 'edge',
      fact: edge.fact ?? null,
      validAt: edge.validAt ?? null,
      invalidAt: edge.invalidAt ?? null,
      score: edge.score ?? null,
    }));

  const facts = [...episodeFacts, ...edgeFacts];
  const hasHistory = facts.length > 0 || context.trim().length > 0;

  return { userId, hasHistory, context, facts };
}

module.exports = {
  hashGuestId,
  ensureUser,
  writeGuestFact,
  getGuestMemory,
};
