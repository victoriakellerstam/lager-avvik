'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFullNameForMatching, resolvePurchaserEmail } = require('../src/purchaser');

test('normalizeFullNameForMatching: trims, lowercases, and collapses internal whitespace', () => {
  assert.equal(normalizeFullNameForMatching('  Kari   Nordmann  '), 'kari nordmann');
});

test('normalizeFullNameForMatching: non-string input yields an empty string', () => {
  assert.equal(normalizeFullNameForMatching(null), '');
  assert.equal(normalizeFullNameForMatching(undefined), '');
});

test('resolvePurchaserEmail: a case_owner with a matching employee is resolved to their email', () => {
  const emailByFullName = new Map([['kari nordmann', 'kari.nordmann@intility.no']]);
  assert.equal(resolvePurchaserEmail('Kari Nordmann', emailByFullName), 'kari.nordmann@intility.no');
});

test('resolvePurchaserEmail: a case_owner with no matching employee resolves to null', () => {
  assert.equal(resolvePurchaserEmail('Ukjent Person', new Map()), null);
});

test('resolvePurchaserEmail: a null/blank case_owner (no sakseier resolved) resolves to null without matching anything', () => {
  assert.equal(resolvePurchaserEmail(null, new Map()), null);
  assert.equal(resolvePurchaserEmail('', new Map()), null);
});
