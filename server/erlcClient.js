'use strict';
/**
 * server/erlcClient.js — HOST-ONLY client for the official ER:LC
 * Private Server API v2 (https://api.erlc.gg).
 *
 * This module is only ever required by the Server Owner Host process.
 * The Player Client has no copy of this file's credentials path and the
 * packaged player build does not ship a key at all (see docs/SECURITY.md).
 *
 * Verified against https://apidocs.erlc.gg (ER:LC Private Server API v2):
 *  - GET  /v2/server                 consolidated snapshot; optional boolean
 *                                    query params Players, Staff, JoinLogs,
 *                                    Queue, KillLogs, CommandLogs, ModCalls,
 *                                    EmergencyCalls, Vehicles (each `=true`)
 *  - GET  /v2/server/players         (+ /vehicles /emergencycalls /commandlogs
 *                                    /modcalls /killlogs /joinlogs /queue)
 *  - POST /v2/server/command         {"command": ":h ..."} remote management
 *  - Auth: `Server-Key: <key>` on every request; `Authorization: <token>`
 *          OPTIONAL, only for registered public apps (Global App Token).
 */

const BASE_URL = 'https://api.erlc.gg';

class ErlcApiError extends Error {
  constructor(message, { status = 0, code = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ErlcApiError';
    this.status = status; this.code = code; this.retryAfterMs = retryAfterMs;
  }
}

class ErlcClient {
  /**
   * @param {{serverKey: string, globalToken?: string, baseUrl?: string,
   *          fetchImpl?: Function, timeoutMs?: number}} opts
   */
  constructor({ serverKey, globalToken = '', baseUrl = BASE_URL, fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
    if (!serverKey || typeof serverKey !== 'string') throw new Error('ErlcClient requires a Server-Key.');
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required (Node >= 18).');
    this._serverKey = serverKey;         // never logged, never serialised
    this._globalToken = globalToken || '';
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this._fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /** Redacted fingerprint so the Host UI can confirm WHICH key is loaded. */
  keyHint() {
    const tail = this._serverKey.split('-').pop() || '';
    return `••••-${tail.slice(-4)}`;
  }

  _headers(extra = {}) {
    const h = { 'Server-Key': this._serverKey, 'Accept': 'application/json', ...extra };
    if (this._globalToken) h.Authorization = this._globalToken;
    return h;
  }

  async _request(path, { method = 'GET', body = null, retries = 1 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this._fetch(this.baseUrl + path, {
          method, signal: ctrl.signal,
          headers: this._headers(body ? { 'Content-Type': 'application/json' } : {}),
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
        if (res.status === 429 && attempt < retries) {
          const wait = Number(res.headers.get('retry-after')) * 1000 || 1500;
          await new Promise((r) => setTimeout(r, Math.min(wait, 10000)));
          continue;
        }
        if (!res.ok) {
          throw new ErlcApiError(
            (data && (data.message || data.error)) || `ER:LC API error (HTTP ${res.status})`,
            { status: res.status, code: data && data.code != null ? data.code : null },
          );
        }
        return data;
      } catch (err) {
        lastErr = err.name === 'AbortError'
          ? new ErlcApiError('ER:LC API request timed out.', { status: 0 })
          : err;
        if (lastErr instanceof ErlcApiError && lastErr.status >= 400 && lastErr.status < 500) throw lastErr;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
      } finally { clearTimeout(timer); }
    }
    throw lastErr;
  }

  /** Validate a key cheaply (used by the Host "Validate" button). */
  async validateKey() {
    const data = await this.getServer();
    return { ok: true, serverName: data && data.Name ? String(data.Name) : 'ER:LC Private Server' };
  }

  getServer(include = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(include)) if (v) qs.set(k, 'true');
    const q = qs.toString();
    return this._request(`/v2/server${q ? `?${q}` : ''}`);
  }

  /** One consolidated poll — far kinder to rate limits than 8 calls. */
  getSnapshot() {
    return this.getServer({
      Players: true, Vehicles: true, EmergencyCalls: true,
      CommandLogs: true, ModCalls: true, KillLogs: true,
      JoinLogs: true, Queue: true, Staff: true,
    });
  }

  // Focused endpoints (kept for completeness / debugging in the Host UI).
  getPlayers() { return this._request('/v2/server/players'); }
  getVehicles() { return this._request('/v2/server/vehicles'); }
  getEmergencyCalls() { return this._request('/v2/server/emergencycalls'); }
  getCommandLogs() { return this._request('/v2/server/commandlogs'); }
  getModCalls() { return this._request('/v2/server/modcalls'); }
  getKillLogs() { return this._request('/v2/server/killlogs'); }

  /** Remote Server Management — OWNER ONLY, enforced again by the host. */
  async runCommand(command) {
    return this._request('/v2/server/command', { method: 'POST', body: { command }, retries: 0 });
  }
}

module.exports = { ErlcClient, ErlcApiError, BASE_URL };
