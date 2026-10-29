'use strict';

/**
 * Admin endpoint for the Lodgify message listener (step 1, listen only).
 * Protected by the ADMIN_SECRET env var, sent as the `x-admin-secret` header.
 *
 *   GET  ?action=status       -> our stored subscription (id only) + Lodgify's webhook list
 *   POST ?action=subscribe    -> subscribe guest_message_received to lodgify-webhook
 *   POST ?action=unsubscribe  -> remove our subscription (the off switch)
 *   GET  ?action=messages&limit=50 -> most recent logged guest messages
 */

const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');
const webhooks = require('./lib/lodgify-webhooks');

const TARGET_URL = 'https://concierge.thekeytothekeys.com/.netlify/functions/lodgify-webhook';
const EVENT = 'guest_message_received';

const json = (statusCode, data) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(data, null, 2),
});

function authorized(event) {
  const want = process.env.ADMIN_SECRET;
  const got = event.headers['x-admin-secret'] || '';
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

exports.handler = async (event) => {
  if (!authorized(event)) return json(401, { error: 'unauthorized' });
  connectLambda(event);
  const action = (event.queryStringParameters || {}).action;
  const config = getStore('lodgify-webhook');

  try {
    if (action === 'status') {
      const sub = await config.get('subscription', { type: 'json' });
      const list = await webhooks.listWebhooks();
      return json(200, { stored: sub ? { id: sub.id, target_url: sub.target_url, created: sub.created } : null, lodgify: list });
    }

    if (action === 'subscribe' && event.httpMethod === 'POST') {
      const existing = await config.get('subscription', { type: 'json' });
      if (existing) return json(409, { error: 'already subscribed', id: existing.id });
      const res = await webhooks.subscribe(TARGET_URL, EVENT);
      if (!res || !res.secret) return json(502, { error: 'Lodgify did not return a secret', res });
      await config.setJSON('subscription', { id: res.id, secret: res.secret, target_url: TARGET_URL, event: EVENT, created: new Date().toISOString() });
      return json(200, { subscribed: true, id: res.id });
    }

    if (action === 'unsubscribe' && event.httpMethod === 'POST') {
      const existing = await config.get('subscription', { type: 'json' });
      if (!existing) return json(404, { error: 'no stored subscription' });
      await webhooks.unsubscribe(existing.id);
      await config.delete('subscription');
      return json(200, { unsubscribed: true, id: existing.id });
    }

    if (action === 'messages') {
      const limit = Math.min(parseInt((event.queryStringParameters || {}).limit, 10) || 50, 200);
      const log = getStore('guest-messages');
      const { blobs } = await log.list();
      const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
      const items = await Promise.all(keys.map((k) => log.get(k, { type: 'json' })));
      return json(200, { total: blobs.length, items });
    }

    return json(400, { error: 'unknown action' });
  } catch (err) {
    console.error(JSON.stringify({ event: 'lodgify_admin_error', action, status: err.status, message: err.message }));
    return json(500, { error: err.message, status: err.status, data: err.data });
  }
};
