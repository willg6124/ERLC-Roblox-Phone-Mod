'use strict';
/**
 * server/webhook.js — ER:LC Event Webhook verification (HOST ONLY).
 *
 * Per https://apidocs.erlc.gg/event-webhooks the game POSTs JSON events
 * (Emergency Calls, and messages starting with ";") signed with Ed25519:
 *   message = X-Signature-Timestamp (utf8) || raw request body bytes
 *   signature = X-Signature-Ed25519 (hex)
 * Verification MUST use the raw body — never a re-serialised JSON object.
 */
const crypto = require('node:crypto');

// ER:LC Event Webhook public key (base64, SPKI) — published in the docs.
const ERLC_WEBHOOK_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAjSICb9pp0kHizGQtdG8ySWsDChfGqi+gyFCttigBNOA=';

function erlcPublicKey() {
  return crypto.createPublicKey({ key: Buffer.from(ERLC_WEBHOOK_PUBLIC_KEY_B64, 'base64'), format: 'der', type: 'spki' });
}

/** @returns {boolean} true only if the signature is genuinely valid. */
function verifyErlcWebhook({ rawBody, timestamp, signatureHex }) {
  try {
    if (!rawBody || !timestamp || !signatureHex) return false;
    const sig = Buffer.from(String(signatureHex), 'hex');
    const msg = Buffer.concat([Buffer.from(String(timestamp), 'utf8'), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)]);
    return crypto.verify(null, msg, erlcPublicKey(), sig);
  } catch { return false; }
}

/** Normalise a verified webhook payload into our internal event shape. */
function parseWebhookEvent(json) {
  if (!json || typeof json !== 'object') return null;
  // Emergency-call webhooks carry the call object; ";" messages carry text.
  if (json.CallNumber || json.Description || json.Position) {
    return { kind: 'emergency', call: json };
  }
  const text = json.Message || json.Content || json.Text || '';
  if (typeof text === 'string' && text.startsWith(';')) return { kind: 'custom-command', text, raw: json };
  return { kind: 'unknown', raw: json };
}

module.exports = { verifyErlcWebhook, parseWebhookEvent, ERLC_WEBHOOK_PUBLIC_KEY_B64 };
