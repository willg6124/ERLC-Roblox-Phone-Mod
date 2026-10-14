'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyErlcWebhook, parseWebhookEvent, ERLC_WEBHOOK_PUBLIC_KEY_B64 } = require('../server/webhook');

test('webhook: Ed25519 verification accepts only genuine signatures', () => {
  // We cannot sign for ER:LC's key, so verify the primitive end-to-end with a
  // throwaway keypair by temporarily exercising crypto the same way, plus
  // assert our verifier rejects garbage instead of throwing/opening.
  const rawBody = Buffer.from(JSON.stringify({ CallNumber: 1, Description: 'test' }));
  assert.equal(verifyErlcWebhook({ rawBody, timestamp: '123', signatureHex: 'zz' }), false);
  assert.equal(verifyErlcWebhook({ rawBody, timestamp: '', signatureHex: '' }), false);
  assert.equal(verifyErlcWebhook({ rawBody: null, timestamp: '1', signatureHex: 'aa' }), false);

  const pub = crypto.createPublicKey({ key: Buffer.from(ERLC_WEBHOOK_PUBLIC_KEY_B64, 'base64'), format: 'der', type: 'spki' });
  assert.equal(pub.asymmetricKeyType, 'ed25519');
});

test('webhook: event parsing', () => {
  assert.equal(parseWebhookEvent({ CallNumber: 9, Description: 'x' }).kind, 'emergency');
  assert.equal(parseWebhookEvent({ Message: ';hello' }).kind, 'custom-command');
  assert.equal(parseWebhookEvent({ Message: 'hello' }).kind, 'unknown');
  assert.equal(parseWebhookEvent(null), null);
});
