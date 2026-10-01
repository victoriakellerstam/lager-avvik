'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const persistence = require('../src/persistence');
const store = require('../src/store');

let tmpDir;

test.beforeEach(() => {
  store._reset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-avvik-state-'));
  store._enablePersistenceAt(path.join(tmpDir, 'state.json'));
});

test.afterEach(() => {
  delete process.env.LAGER_AVVIK_STATE_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function stateOnDisk() {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'state.json'), 'utf8'));
}

test('a comment is on disk as soon as it is added, before any sync has run', () => {
  const [existing] = store.listAvvik();

  const commentsBefore = store.getAvvik(existing.id).comments.length;

  store.addComment(existing.id, 'Kari', 'Fakturaen ligger i posten, sjekker i morgen.');

  const onDisk = stateOnDisk();
  const row = onDisk.avvikList.find((a) => a.id === existing.id);
  assert.equal(row.comments.length, commentsBefore + 1);
  assert.equal(row.comments.at(-1).author, 'Kari');
  assert.equal(row.comments.at(-1).text, 'Fakturaen ligger i posten, sjekker i morgen.');
});

test('comments, resolved state and manual purchaser corrections survive a restart', () => {
  const [existing] = store.listAvvik();
  const seededComments = existing.comments.length;
  store.addComment(existing.id, 'Kari', 'Første kommentar.');
  store.addComment(existing.id, 'Ole', 'Andre kommentar.');
  store.resolveAvvik(existing.id);
  const other = store.listAvvik()[1];
  store.setManualPurchaser(other.id, 'Manuelt Rettet Navn', 'manuelt@intility.no');

  // Simulate a process restart: fresh module state, then load from disk.
  store._reset();
  store.initPersistence();

  const restored = store.getAvvik(existing.id);
  assert.equal(restored.comments.length, seededComments + 2, 'both comments survived the restart');
  assert.deepEqual(
    restored.comments.slice(-2).map((c) => c.text),
    ['Første kommentar.', 'Andre kommentar.']
  );
  assert.equal(restored.resolved, true);
  assert.ok(restored.resolvedAt);
  assert.equal(restored.resolvedSource, 'manual');

  const restoredOther = store.getAvvik(other.id);
  assert.equal(restoredOther.purchaserName, 'Manuelt Rettet Navn');
  assert.equal(restoredOther.purchaserEmail, 'manuelt@intility.no');
});

test('an archived avvik is still in the archive after a restart, with its dwh fields and comments', () => {
  const [existing] = store.listAvvik();
  const commentsBefore = existing.comments.length;
  store.addComment(existing.id, 'Kari', 'Lukket fordi fakturaen kom.');
  const orderIdBefore = store.getAvvik(existing.id).orderId;

  // The row leaves dwh's result set -> archived. dwh no longer knows about it.
  const result = store.mergeFromDwh([], new Date('2026-08-20T00:00:00.000Z'));
  assert.equal(result.archived >= 1, true);

  store._reset();
  store.initPersistence();

  const restored = store.getAvvik(existing.id);
  assert.ok(restored, 'an archived avvik must not be dropped on restart');
  assert.equal(restored.resolved, true);
  assert.equal(restored.resolvedAt, '2026-08-20T00:00:00.000Z');
  assert.equal(restored.orderId, orderIdBefore, 'the dwh fields it was archived with are still renderable');
  assert.equal(restored.comments.length, commentsBefore + 1);
});

test('a dwh sync after a restart refreshes open avvik without resurrecting archived ones', () => {
  const [archived, stillOpen] = store.listAvvik();
  store.mergeFromDwh([], new Date('2026-08-20T00:00:00.000Z'));

  store._reset();
  store.initPersistence();

  // Fresh batch: the archived row is gone from dwh for good, the still-open one
  // is still there with updated fields.
  const result = store.mergeFromDwh(
    [
      {
        id: stillOpen.id,
        orderId: 'Oppdatert Ordre',
        purchaserName: 'Oppdatert Navn',
        purchaserEmail: 'oppdatert@example.com',
        discrepancyType: 'Ikke mottatt faktura i Medius',
        createdAt: '2026-08-01T09:00:00.000Z',
        daysWaiting: 40,
      },
    ],
    new Date('2026-08-25T00:00:00.000Z')
  );

  const refreshed = store.getAvvik(stillOpen.id);
  assert.equal(refreshed.orderId, 'Oppdatert Ordre');
  assert.equal(refreshed.daysWaiting, 40);
  assert.equal(refreshed.resolved, false);

  // The archived row was absent from the batch and was already resolved, so it
  // is untouched - not re-archived with a new date.
  const stillArchived = store.getAvvik(archived.id);
  assert.equal(stillArchived.resolved, true);
  assert.equal(stillArchived.resolvedAt, '2026-08-20T00:00:00.000Z');
  assert.equal(result.inserted, 0);
});

test('an auto-archived avvik that is still in dwh after a restart reopens rather than showing as løst', () => {
  const [existing] = store.listAvvik();
  store.mergeFromDwh([], new Date('2026-08-20T00:00:00.000Z'));

  store._reset();
  store.initPersistence();
  assert.equal(store.getAvvik(existing.id).resolved, true, 'archived before the restart');

  const result = store.mergeFromDwh(
    [
      {
        id: existing.id,
        orderId: 'SO-10245',
        purchaserName: 'Kari Nordmann',
        purchaserEmail: 'kari.nordmann@example.com',
        discrepancyType: 'Ikke mottatt faktura i Medius',
        createdAt: '2026-08-01T09:00:00.000Z',
        daysWaiting: 41,
      },
    ],
    new Date('2026-08-25T00:00:00.000Z')
  );

  const after = store.getAvvik(existing.id);
  assert.equal(after.resolved, false);
  assert.equal(result.reopened, 1);
});

test('a corrupt state file is reported and ignored rather than crashing startup', () => {
  const file = path.join(tmpDir, 'state.json');
  fs.writeFileSync(file, '{ this is not json', 'utf8');

  store._reset();
  const seedLength = store.listAvvik().length;

  assert.doesNotThrow(() => store.initPersistence());
  assert.equal(store.listAvvik().length, seedLength, 'falls back to the seeded test state');
});

test('a state file written by an unknown version is ignored rather than trusted', () => {
  const file = path.join(tmpDir, 'state.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 999, avvikList: [{ id: 'x', orderId: 'SKAL IGNORERES' }], notifications: [] }),
    'utf8'
  );

  store._reset();
  store.initPersistence();

  assert.equal(store.getAvvik('x'), null, 'an unrecognized version is not fed into the store');
});

test('a missing state file is not an error - first run starts empty', () => {
  store._reset();

  assert.doesNotThrow(() => store.initPersistence());
  assert.equal(fs.existsSync(path.join(tmpDir, 'state.json')), false, 'no file is invented by loading');
});

test('state is written via a temp file and rename, so no partial file is left behind', () => {
  const [existing] = store.listAvvik();

  store.addComment(existing.id, 'Kari', 'Kommentar.');

  const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'the temp file is renamed away, not left in the directory');
  assert.deepEqual(stateOnDisk().version, persistence.STATE_VERSION);
});

test('the notification log survives a restart', () => {
  const [existing] = store.listAvvik();
  const avvik = store.getAvvik(existing.id);
  store.recordNotification(avvik, { to: 'kari@example.com', subject: 'Avvik', body: 'Hei' }, new Date('2026-08-20T09:00:00.000Z'));

  store._reset();
  store.initPersistence();

  const notifications = store.listNotifications();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].to, 'kari@example.com');
  assert.equal(store.getAvvik(existing.id).lastNotifiedAt, '2026-08-20T09:00:00.000Z');
});

test('notification ids do not collide with ones restored from disk', () => {
  const [existing] = store.listAvvik();
  const avvik = store.getAvvik(existing.id);
  store.recordNotification(avvik, { to: 'a@example.com', subject: 's', body: 'b' }, new Date());

  store._reset();
  store.initPersistence();
  store.recordNotification(store.getAvvik(existing.id), { to: 'b@example.com', subject: 's', body: 'b' }, new Date());

  const ids = store.listNotifications().map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids after a restart');
});