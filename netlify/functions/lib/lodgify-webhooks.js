'use strict';

/**
 * Lodgify webhook subscription management — the ONLY Lodgify write surface
 * in this repo, and it is limited to webhook subscriptions.
 *
 * Kept separate from lodgify-client.js on purpose: that module is read-only
 * by construction and must stay that way. Nothing here touches bookings,
 * rates, availability or guest messages. It can only:
 *   - list the account's webhooks
 *   - subscribe one target URL to one event
 *   - unsubscribe a webhook by id
 *
 * Docs: https://docs.lodgify.com/reference/webhooks
 */

const BASE_URL = 'https://api.lodgify.com/webhooks/v1';

function apiKey() {
  const key = process.env.LODGIFY_API_KEY;
  if (!key) throw new Error('LODGIFY_API_KEY is not set');
  return key;
}

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'X-ApiKey': apiKey(),
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`Lodgify webhooks ${method} ${path} -> ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const listWebhooks = () => call('GET', '/list');
const subscribe = (targetUrl, event) => call('POST', '/subscribe', { target_url: targetUrl, event });
const unsubscribe = (id) => call('DELETE', '/unsubscribe', { id });

module.exports = { listWebhooks, subscribe, unsubscribe };
