'use strict';

/**
 * Lodgify "guest_message_received" listener — STEP 1: LISTEN ONLY.
 *
 * Approved by Damian (Oct 29, 2026). This function only records incoming
 * guest messages so we can confirm Airbnb / Vrbo / direct messages arrive.
 * It never replies, never posts notes, never writes to Lodgify.
 *
 * Security: every request must carry Lodgify's `ms-signature` header
 * (sha256=HEX, HMAC-SHA256 of the raw body using the secret Lodgify returned
 * when we subscribed). The secret is stored in Netlify Blobs by
 * lodgify-admin.js at subscribe time. Unsigned/invalid requests are rejected.
 */

const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');

const ok = (body = 'ok') => ({ statusCode: 200, body });

function validSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const received = String(header).split('=').pop().trim().toUpperCase();
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex').toUpperCase();
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  connectLambda(event);

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const config = getStore('lodgify-webhook');
  const sub = await config.get('subscription', { type: 'json' });
  const header = event.headers['ms-signature'] || event.headers['Ms-Signature'];

  if (!validSignature(raw, header, sub && sub.secret)) {
    console.warn(JSON.stringify({ event: 'lodgify_webhook_bad_signature', hasHeader: Boolean(header), hasSecret: Boolean(sub && sub.secret) }));
    return { statusCode: 401, body: 'invalid signature' };
  }

  let payload;
  try { payload = JSON.parse(raw); } catch { return ok('ignored: not json'); }
  if (payload.action !== 'guest_message_received') return ok('ignored: ' + payload.action);

  const record = {
    received_at: new Date().toISOString(),
    creation_time: payload.creation_time || null,
    inbox_uid: payload.inbox_uid || null, // booking/enquiry id, e.g. "B12345"
    thread_uid: payload.thread_uid || null,
    message_id: payload.message_id || null,
    guest_name: payload.guest_name || null,
    subject: payload.subject || null,
    message: payload.message || '',
    has_attachments: Boolean(payload.has_attachments),
  };

  const log = getStore('guest-messages');
  const key = `${record.received_at}_${record.message_id || crypto.randomUUID()}`;
  await log.setJSON(key, record);
  console.log(JSON.stringify({ event: 'guest_message_logged', inbox_uid: record.inbox_uid, chars: record.message.length }));
  return ok();
};
