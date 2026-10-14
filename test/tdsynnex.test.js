'use strict';

// Exercises src/tdsynnex.js with a fake fetch and made-up credentials, so no
// network call is made and no real credential is involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const { getAccessToken } = require('../src/tdsynnex');

const FAKE_ID = 'fake-client-id-123';
const FAKE_SECRET = 'fake-client-secret-456';
const GOOD_URL = 'https://api.tdsynnex.com/eu/auth/token';

function withEnv(env, fn) {
  const keys = ['TD_SYNNEX_CLIENT_ID', 'TECH_DATA', 'TD_SYNNEX_TOKEN_URL'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  const realFetch = global.fetch;
  return Promise.resolve(fn()).finally(() => {
    global.fetch = realFetch;
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}

const GOOD_ENV = { TD_SYNNEX_CLIENT_ID: FAKE_ID, TECH_DATA: FAKE_SECRET, TD_SYNNEX_TOKEN_URL: GOOD_URL };

test('success: posts client_credentials as a form to the token URL and returns only the token', () =>
  withEnv(GOOD_ENV, async () => {
    let call;
    global.fetch = async (url, init) => { call = { url: String(url), init }; return { ok: true, status: 200, json: async () => ({ access_token: 'fake-token-789' }) }; };
    const token = await getAccessToken();
    assert.equal(token, 'fake-token-789');
    assert.equal(call.url, GOOD_URL);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(call.init.body));
    assert.equal(body.get('grant_type'), 'client_credentials');
    assert.equal(body.get('client_id'), FAKE_ID);
    assert.equal(body.get('client_secret'), FAKE_SECRET);
    assert.ok(call.init.signal, 'has a timeout signal');
  }));

test('missing configuration fails before any network call, without naming values', () =>
  withEnv({ TD_SYNNEX_CLIENT_ID: FAKE_ID }, async () => {
    let called = false;
    global.fetch = async () => { called = true; };
    await assert.rejects(getAccessToken(), (e) => /Mangler/.test(e.message) && !e.message.includes(FAKE_ID));
    assert.equal(called, false);
  }));

for (const [label, url] of [
  ['http instead of https', 'http://api.tdsynnex.com/eu/auth/token'],
  ['another host', 'https://evil.example.com/eu/auth/token'],
  ['look-alike host', 'https://api.tdsynnex.com.evil.example/eu/auth/token'],
  ['another path', 'https://api.tdsynnex.com/us/auth/token'],
  ['credentials in the URL', 'https://user:pw@api.tdsynnex.com/eu/auth/token'],
  ['query string', 'https://api.tdsynnex.com/eu/auth/token?x=1'],
  ['fragment', 'https://api.tdsynnex.com/eu/auth/token#x'],
]) {
  test(`rejects a token URL with ${label}, before any network call`, () =>
    withEnv({ ...GOOD_ENV, TD_SYNNEX_TOKEN_URL: url }, async () => {
      let called = false;
      global.fetch = async () => { called = true; };
      await assert.rejects(getAccessToken(), /Ugyldig TD Synnex token-adresse/);
      assert.equal(called, false);
    }));
}

test('the test host is allowed, with the same path', () =>
  withEnv({ ...GOOD_ENV, TD_SYNNEX_TOKEN_URL: 'https://test.api.tdsynnex.com/eu/auth/token' }, async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 't' }) });
    assert.equal(await getAccessToken(), 't');
  }));

test('a failed login reports only the HTTP status, never the credentials or the response body', () =>
  withEnv(GOOD_ENV, async () => {
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_client', echoed: FAKE_SECRET }) });
    await assert.rejects(getAccessToken(), (e) => e.message.includes('HTTP 401') && !e.message.includes(FAKE_SECRET) && !e.message.includes(FAKE_ID));
  }));

test('a response without access_token is an error that does not echo the response', () =>
  withEnv(GOOD_ENV, async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ token_type: 'bearer', access_token: '' }) });
    await assert.rejects(getAccessToken(), /uten forventet access_token/);
  }));

test('nothing is written to stdout/stderr while logging in', () =>
  withEnv(GOOD_ENV, async () => {
    const writes = [];
    const outW = process.stdout.write, errW = process.stderr.write;
    process.stdout.write = (c) => { writes.push(String(c)); return true; };
    process.stderr.write = (c) => { writes.push(String(c)); return true; };
    try {
      global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'fake-token-789' }) });
      await getAccessToken();
    } finally { process.stdout.write = outW; process.stderr.write = errW; }
    assert.deepEqual(writes.filter((w) => /fake-/.test(w)), []);
  }));
