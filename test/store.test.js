'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

test.beforeEach(() => {
  store._reset();
});

function freshRow(overrides = {}) {
  return {
    id: 'dwh-1',
    orderId: 'BEST-1',
    purchaserName: 'Ny Person',
    purchaserEmail: 'ny.person@intility.no',
    discrepancyType: 'Ikke mottatt faktura i Medius',
    createdAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

test('mergeFromDwh: an existing id is refreshed with dwh fields but local state (resolved/comments) is preserved', () => {
  const [existing] = store.listAvvik();
  store.addComment(existing.id, 'Ole', 'En kommentar fra laget');
  store.resolveAvvik(existing.id);
  const commentsBefore = store.getAvvik(existing.id).comments.length;

  store.mergeFromDwh([
    freshRow({
      id: existing.id,
      orderId: 'OPPDATERT-ORDRE',
      purchaserName: 'Oppdatert Navn',
      purchaserEmail: 'oppdatert@intility.no',
      discrepancyType: 'Kostnadsfaktura — reverser',
      createdAt: '2026-08-10T09:00:00.000Z',
    }),
  ]);

  const merged = store.getAvvik(existing.id);
  assert.equal(merged.orderId, 'OPPDATERT-ORDRE');
  assert.equal(merged.purchaserName, 'Oppdatert Navn');
  assert.equal(merged.purchaserEmail, 'oppdatert@intility.no');
  assert.equal(merged.discrepancyType, 'Kostnadsfaktura — reverser');
  assert.equal(merged.createdAt, '2026-08-10T09:00:00.000Z');
  // Local state must survive the refresh untouched.
  assert.equal(merged.resolved, true);
  assert.ok(merged.resolvedAt);
  assert.equal(merged.comments.length, commentsBefore);
});

test('mergeFromDwh: an id not seen before is inserted with fresh local-state defaults', () => {
  const before = store.listAvvik().length;

  store.mergeFromDwh([freshRow({ id: 'dwh-new-1' })]);

  const inserted = store.getAvvik('dwh-new-1');
  assert.ok(inserted, 'expected the new avvik to be present');
  assert.equal(store.listAvvik().length, before + 1);
  assert.equal(inserted.resolved, false);
  assert.equal(inserted.resolvedAt, null);
  assert.equal(inserted.lastNotifiedAt, null);
  assert.deepEqual(inserted.comments, []);
});

test('mergeFromDwh: an open avvik missing from a fresh fetch is kept (not deleted) and flagged missing, but not yet resolved', () => {
  const [existing] = store.listAvvik();
  const before = store.listAvvik().length;
  const unresolvedCountBefore = store.listAvvik().filter((a) => !a.resolved).length;

  const result = store.mergeFromDwh([], new Date('2026-08-20T00:00:00.000Z'));

  assert.equal(store.listAvvik().length, before, 'nothing should ever be deleted');
  const after = store.getAvvik(existing.id);
  assert.equal(after.missingFromLastSyncAt, '2026-08-20T00:00:00.000Z');
  // A single sync where it's missing isn't enough on its own - order_status
  // can blip for reasons unrelated to actually being fixed, so it must stay
  // missing for the full three weeks (see the next test) before this app
  // trusts the disappearance.
  assert.equal(after.resolved, false);
  assert.equal(after.resolvedAt, null);
  // Only the already-unresolved seed avvik get flagged - the seeded resolved
  // one (see mockData.js) must not be touched at all.
  assert.equal(result.markedMissing, unresolvedCountBefore);
});

test('mergeFromDwh: missingFromLastSyncAt records the FIRST sync it went missing, not the latest, and does not resolve before three weeks pass', () => {
  const [existing] = store.listAvvik();

  store.mergeFromDwh([], new Date('2026-08-20T00:00:00.000Z'));
  store.mergeFromDwh([], new Date('2026-08-27T00:00:00.000Z')); // only 7 days later

  const after = store.getAvvik(existing.id);
  assert.equal(after.missingFromLastSyncAt, '2026-08-20T00:00:00.000Z');
  assert.equal(after.resolved, false, 'less than three weeks missing - not resolved yet');
});

test('mergeFromDwh: auto-resolves once an avvik has stayed missing for at least three weeks (21 days)', () => {
  const [existing] = store.listAvvik();

  store.mergeFromDwh([], new Date('2026-08-01T00:00:00.000Z'));
  assert.equal(store.getAvvik(existing.id).resolved, false, 'not yet 21 days missing');

  store.mergeFromDwh([], new Date('2026-08-22T00:00:00.000Z')); // exactly 21 days later

  const after = store.getAvvik(existing.id);
  assert.equal(after.resolved, true);
  assert.equal(after.resolvedAt, '2026-08-22T00:00:00.000Z');
  // missingFromLastSyncAt keeps reading "missing since" the first sync, not
  // the sync that finally triggered auto-resolution.
  assert.equal(after.missingFromLastSyncAt, '2026-08-01T00:00:00.000Z');
});

test('mergeFromDwh: a previously-resolved avvik missing from a fresh fetch is left completely untouched', () => {
  const [existing] = store.listAvvik();
  store.resolveAvvik(existing.id);
  const before = { ...store.getAvvik(existing.id) };

  store.mergeFromDwh([], new Date('2026-08-20T00:00:00.000Z'));

  const after = store.getAvvik(existing.id);
  assert.equal(after.resolved, before.resolved);
  assert.equal(after.resolvedAt, before.resolvedAt);
  assert.equal(after.missingFromLastSyncAt, undefined, 'a resolved avvik should not get the missing-flag at all');
});

test('mergeFromDwh: an avvik that was flagged missing clears the flag if it reappears before three weeks are up, and is never resolved', () => {
  const [existing] = store.listAvvik();
  store.mergeFromDwh([], new Date('2026-08-20T00:00:00.000Z'));
  assert.ok(store.getAvvik(existing.id).missingFromLastSyncAt);
  assert.equal(store.getAvvik(existing.id).resolved, false);

  store.mergeFromDwh([freshRow({ id: existing.id })], new Date('2026-08-27T00:00:00.000Z')); // only 7 days later

  const after = store.getAvvik(existing.id);
  assert.equal(after.missingFromLastSyncAt, null);
  assert.equal(after.resolved, false, 'a status blip that reverses within three weeks must never auto-resolve');
});

test('mergeFromDwh: reappearing after auto-resolution clears the missing-flag but does not auto-reopen it', () => {
  const [existing] = store.listAvvik();
  store.mergeFromDwh([], new Date('2026-08-01T00:00:00.000Z'));
  store.mergeFromDwh([], new Date('2026-08-22T00:00:00.000Z')); // 21 days later - now auto-resolved
  assert.equal(store.getAvvik(existing.id).resolved, true);

  store.mergeFromDwh([freshRow({ id: existing.id })], new Date('2026-08-29T00:00:00.000Z'));

  const after = store.getAvvik(existing.id);
  assert.equal(after.missingFromLastSyncAt, null);
  // Reappearing clears the missing-flag but doesn't auto-reopen it - same as
  // any other resolved avvik, a human uses "Gjenåpne" for that.
  assert.equal(after.resolved, true);
});

test('mergeFromDwh: a manually-corrected purchaser survives a later refresh, everything else still updates', () => {
  const [existing] = store.listAvvik();
  store.setManualPurchaser(existing.id, 'Manuelt Rettet Navn', 'manuelt@intility.no');

  store.mergeFromDwh([
    freshRow({
      id: existing.id,
      orderId: 'OPPDATERT-ORDRE',
      purchaserName: 'Sakseier ikke funnet',
      purchaserEmail: null,
      discrepancyType: 'Kostnadsfaktura — reverser',
    }),
  ]);

  const merged = store.getAvvik(existing.id);
  assert.equal(merged.purchaserName, 'Manuelt Rettet Navn');
  assert.equal(merged.purchaserEmail, 'manuelt@intility.no');
  assert.equal(merged.orderId, 'OPPDATERT-ORDRE', 'non-purchaser fields still refresh from dwh as normal');
  assert.equal(merged.discrepancyType, 'Kostnadsfaktura — reverser');
});
