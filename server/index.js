#!/usr/bin/env node
'use strict';
/**
 * Headless Host entry point (the Electron Host .exe wraps this same core).
 *
 *   node server/index.js --mock            # no key needed, simulated server
 *   node server/index.js --live            # reads ERLC_SERVER_KEY from env
 *   node server/index.js --live --port 3847 --demo
 *
 * Flags: --mock | --live   --port <n>   --demo (expose codes for web preview)
 * Env:   ERLC_SERVER_KEY, ERLC_GLOBAL_TOKEN, HOST_PORT, DEMO_MODE=1
 * The key is read ONLY here / in the Host process. It is never written to
 * disk by this app, never logged, and never sent to a phone.
 */
const { HostServer } = require('./hostServer');

async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const portArg = args.indexOf('--port');
  const port = Number((portArg >= 0 && args[portArg + 1]) || process.env.HOST_PORT || 3847);
  const demoMode = has('--demo') || process.env.DEMO_MODE === '1';
  const live = has('--live') && !has('--mock');

  const host = new HostServer({ port, demoMode });
  await host.start();

  const serverKey = process.env.ERLC_SERVER_KEY || '';
  try {
    const check = await host.configureSource(live && serverKey
      ? { serverKey, globalToken: process.env.ERLC_GLOBAL_TOKEN || '' }
      : { mock: true });
    console.log(`[host] Source ready: ${check.serverName} (${host.sourceKind})`);
    if (live && !serverKey) console.log('[host] --live given but ERLC_SERVER_KEY is not set; running in MOCK MODE instead.');
  } catch (e) {
    console.error(`[host] Could not start ER:LC source (${e.message}); falling back to MOCK MODE.`);
    await host.configureSource({ mock: true });
  }
  console.log(`[host] Manager UI (local, token-guarded): http://localhost:${port}/manager — admin token: ${host.adminToken}`);
  console.log('[host] Press Ctrl+C to stop. Keep this running while anyone uses a phone overlay.');

  const shutdown = async () => { await host.stop(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
