'use strict';

// Local-only durable state: comments, resolved/archived avvik, and the
// notification log, written to a JSON file so they survive a restart. Before
// this existed, everything lived in a module variable in store.js and a page
// refresh (or an `npm run dev` restart on file save) silently threw away every
// comment and every resolved case.
//
// Why a file and not Postgres: Postgres on Minato is the eventual answer, but
// this app is currently run only from a developer machine. A file needs no
// infrastructure, and Minato's own filesystem is ephemeral anyway - so this
// persistence deliberately does NOT pretend to survive a redeploy. The
// read/write pair is isolated behind this module's two functions so swapping in
// a database later touches only this file.
//
// Deliberately NOT persisted here: nothing derived from dwh alone. Those fields
// are re-derived on every sync (see store.js's mergeFromDwh), so persisting
// them would only risk showing stale dwh data. The one exception is an archived
// avvik's dwh-derived fields, which are persisted as-is because dwh no longer
// returns that row at all - the archive has to be able to render the line it
// saw when the case was still open, and there is nothing left to re-derive it
// from.

const fs = require('node:fs');
const path = require('node:path');

// Bump when the on-disk shape changes in a way loadState can't migrate. A
// version this module doesn't recognise is treated the same as a corrupt file
// (warn, start clean) rather than being fed into store.js as if it were valid.
const STATE_VERSION = 1;

function stateFilePath() {
  return process.env.LAGER_AVVIK_STATE_FILE || path.join(__dirname, '..', 'data', 'state.json');
}

// Returns the persisted state, or null when there is nothing usable to load -
// a missing file (first run), an unreadable/corrupt one, or a shape/this
// version mismatch. Never throws: losing the file is recoverable (the app just
// re-syncs from dwh and the local state starts empty again), while failing to
// start would not be.
function loadState() {
  const file = stateFilePath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`could not read state file ${file}: ${err.message} - starting with empty local state`);
    }
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`state file ${file} is not valid JSON (${err.message}) - starting with empty local state`);
    return null;
  }

  if (!parsed || parsed.version !== STATE_VERSION) {
    console.warn(
      `state file ${file} has version ${parsed && parsed.version}, expected ${STATE_VERSION} - starting with empty local state`
    );
    return null;
  }
  if (!Array.isArray(parsed.avvikList) || !Array.isArray(parsed.notifications)) {
    console.warn(`state file ${file} has an unexpected shape - starting with empty local state`);
    return null;
  }

  return parsed;
}

// Writes the whole state synchronously. Callers are request handlers (adding a
// comment) and the dwh sync, both of which are rare enough that a sync write
// costs nothing next to the dwh round trip - and a synchronous write means a
// comment is durable before the HTTP response goes out, with no window where a
// crash could lose it.
//
// Atomic via write-to-temp + rename: a half-written state.json would otherwise
// be indistinguishable from a corrupt one on next startup, losing every comment
// in the file rather than just the newest.
//
// Failures are logged, never thrown: this is local convenience state, and a
// read-only or full disk shouldn't turn "add a comment" into a 500.
function saveState(state) {
  const file = stateFilePath();
  const tmp = `${file}.tmp`;
  const payload = JSON.stringify({ version: STATE_VERSION, ...state }, null, 2);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`could not write state file ${file}: ${err.message}`);
  }
}

module.exports = { loadState, saveState, stateFilePath, STATE_VERSION };