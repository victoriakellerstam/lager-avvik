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

test('mergeFromDwh: an open avvik missing from a fresh fetch is archived, not deleted', () => {
  const [existing] = store.listAvvik();
  const before = store.listAvvik().length;
  const openCountBefore = store.listAvvik().filter((a) => !a.resolved).length;

  const result = store.mergeFromDwh([], new Date('2026-08-20T00:00:00.000Z'));

  assert.equal(store.listAvvik().length, before, 'nothing should ever be deleted');
  const after = store.getAvvik(existing.id);
  // Leaving dwh's result set means the order line stopped being 3030, which is
  // how a case normally closes (the line got matched against its invoice), so
  // it goes straight to the archive - no waiting period.
  assert.equal(after.resolved, true);
  assert.equal(after.resolvedAt, '2026-08-20T00:00:00.000Z');
  assert.equal(after.resolvedSource, 'auto');
  // Only the still-open seed avvik get archived - the seeded resolved one
  // (see mockData.js) must not be counted again.
  assert.equal(result.archived, openCountBefore);
});

test('mergeFromDwh: resolvedAt records the FIRST sync the row went missing, not a later one', () => {
  const [existing] = store.listAvvik();

  store.mergeFromDwh([], new Date('2026-08-01T00:00:00.000Z'));
  store.mergeFromDwh([], new Date('2026-08-22T00:00:00.000Z'));

  const after = store.getAvvik(existing.id);
  assert.equal(after.missingFromLastSyncAt, '2026-08-01T00:00:00.000Z');
  assert.equal(after.resolvedAt, '2026-08-01T00:00:00.000Z', 'the archive date is when it was first seen gone');
});

test('mergeFromDwh: a manually-resolved avvik missing from a fresh fetch is left completely untouched', () => {
  const [existing] = store.listAvvik();
  store.resolveAvvik(existing.id);
  const before = { ...store.getAvvik(existing.id) };
  const stillOpenBefore = store.listAvvik().filter((a) => !a.resolved).length;

  const result = store.mergeFromDwh([], new Date('2026-08-20T00:00:00.000Z'));

  const after = store.getAvvik(existing.id);
  assert.equal(after.resolved, before.resolved);
  assert.equal(after.resolvedAt, before.resolvedAt);
  assert.equal(after.resolvedSource, 'manual', 'a person\'s decision is not re-attributed to dwh');
  assert.equal(after.missingFromLastSyncAt, null, 'an already-resolved avvik should not get the missing-flag at all');
  assert.equal(result.archived, stillOpenBefore, 'this one was not among the rows archived');
});

test('mergeFromDwh: an auto-archived avvik that reappears from dwh reopens', () => {
  const [existing] = store.listAvvik();
  store.mergeFromDwh([], new Date('2026-08-01T00:00:00.000Z'));
  assert.equal(store.getAvvik(existing.id).resolved, true);
  assert.equal(store.getAvvik(existing.id).resolvedSource, 'auto');

  const result = store.mergeFromDwh([freshRow({ id: existing.id })], new Date('2026-08-08T00:00:00.000Z'));

  const after = store.getAvvik(existing.id);
  assert.equal(after.resolved, false, 'dwh says it is open again, so it must not sit in the archive');
  assert.equal(after.resolvedSource, null);
  assert.equal(after.resolvedAt, null);
  assert.equal(after.missingFromLastSyncAt, null);
  assert.equal(result.reopened, 1);
});

test('mergeFromDwh: a manually-resolved avvik that reappears from dwh stays resolved', () => {
  const [existing] = store.listAvvik();
  store.resolveAvvik(existing.id);
  const commentsBefore = store.getAvvik(existing.id).comments.length;
  store.addComment(existing.id, 'Ole', 'Lukket fordi innkjøper svarte.');

  const result = store.mergeFromDwh([freshRow({ id: existing.id })], new Date('2026-08-08T00:00:00.000Z'));

  const after = store.getAvvik(existing.id);
  assert.equal(after.resolved, true, 'a human resolving a case outranks dwh showing the line again');
  assert.equal(after.resolvedSource, 'manual');
  assert.equal(result.reopened, 0);
  assert.equal(after.comments.length, commentsBefore + 1, 'comments survive the reopen attempt too');
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
