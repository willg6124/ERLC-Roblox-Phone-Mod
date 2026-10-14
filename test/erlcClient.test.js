'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ErlcClient } = require('../server/erlcClient');

function fakeFetch(capture, body = { Name: 'Stub Server' }) {
  return async (url, opts) => {
    capture.push({ url, opts });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
}

test('ErlcClient: consolidated snapshot URL + Server-Key header (host-side only)', async () => {
  const calls = [];
  const client = new ErlcClient({ serverKey: 'private-segment-PUBSEG', globalToken: 'gtoken', fetchImpl: fakeFetch(calls) });
  await client.getSnapshot();
  assert.match(calls[0].url, /^https:\/\/api\.erlc\.gg\/v2\/server\?/);
  for (const k of ['Players', 'Vehicles', 'EmergencyCalls', 'CommandLogs', 'ModCalls']) assert.match(calls[0].url, new RegExp(`${k}=true`));
  assert.equal(calls[0].opts.headers['Server-Key'], 'private-segment-PUBSEG');
  assert.equal(calls[0].opts.headers.Authorization, 'gtoken');
  assert.equal(client.keyHint(), '••••-BSEG', 'UI hint must never expose the private segment');
});

test('ErlcClient: runCommand posts {"command": ...} to /v2/server/command', async () => {
  const calls = [];
  const client = new ErlcClient({ serverKey: 'a-b', fetchImpl: fakeFetch(calls, { ok: true }) });
  await client.runCommand(':h hello');
  assert.equal(calls[0].url, 'https://api.erlc.gg/v2/server/command');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { command: ':h hello' });
});

test('ErlcClient: API errors surface message without the key', async () => {
  const client = new ErlcClient({
    serverKey: 'super-secret-key', fetchImpl: async () => ({
      ok: false, status: 403, headers: { get: () => null },
      text: async () => JSON.stringify({ message: 'Invalid Server-Key', code: 1001 }),
    }),
  });
  await assert.rejects(() => client.validateKey(), (e) => {
    assert.match(e.message, /Invalid Server-Key/);
    assert.ok(!e.message.includes('super-secret-key'));
    return true;
  });
});
