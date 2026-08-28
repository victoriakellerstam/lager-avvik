'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractPoCodesFromTicketTitle,
  pickWinningSakseier,
  normalizeOurRef,
  normalizeFullNameForMatching,
  resolvePurchaser,
} = require('../src/purchaser');

test('extractPoCodesFromTicketTitle: a single valid PO-code after one "#"', () => {
  assert.deepEqual(extractPoCodesFromTicketTitle('Sak #146789 gjelder mottak'), ['146789']);
});

test('extractPoCodesFromTicketTitle: no "#" at all yields no codes', () => {
  assert.deepEqual(extractPoCodesFromTicketTitle('ingen hashtag her'), []);
});

test('extractPoCodesFromTicketTitle: multiple "#"-segments, one invalid prefix mixed in', () => {
  assert.deepEqual(
    extractPoCodesFromTicketTitle('prefix #146789 mellomtekst #999999 slutt #157777'),
    ['146789', '157777']
  );
});

test('extractPoCodesFromTicketTitle: a "cancl" note within the first 20 characters excludes the code', () => {
  assert.deepEqual(extractPoCodesFromTicketTitle('#146789cancl'), []);
});

test('extractPoCodesFromTicketTitle: a segment shorter than 6 characters is excluded', () => {
  assert.deepEqual(extractPoCodesFromTicketTitle('#1467'), []);
});

test('extractPoCodesFromTicketTitle: non-string input yields no codes', () => {
  assert.deepEqual(extractPoCodesFromTicketTitle(null), []);
  assert.deepEqual(extractPoCodesFromTicketTitle(undefined), []);
});

test('pickWinningSakseier: no candidates = no winner', () => {
  assert.equal(pickWinningSakseier([]), null);
  assert.equal(pickWinningSakseier(null), null);
});

test('pickWinningSakseier: Egenbestillinger always wins over everything else', () => {
  const candidates = [
    { category_name: 'Noe annet', category_top_level: 'Support', intility_worker_fullname: 'Ole Olsen' },
    { category_name: 'Egenbestillinger', category_top_level: 'Logistics', intility_worker_fullname: 'Kari Nordmann' },
  ];
  assert.deepEqual(pickWinningSakseier(candidates), candidates[1]);
});

test('pickWinningSakseier: excludes Logistics and Warehouse-titled candidates when no Egenbestillinger match', () => {
  const candidates = [
    { category_top_level: 'Logistics', intility_worker_fullname: 'Lager Person' },
    { category_top_level: 'Support', intility_worker_title: 'Warehouse Coordinator', intility_worker_fullname: 'Warehouse Person' },
    { category_top_level: 'Support', intility_worker_title: 'IT Konsulent', intility_worker_fullname: 'Ola Hansen' },
  ];
  assert.deepEqual(pickWinningSakseier(candidates), candidates[2]);
});

test('pickWinningSakseier: Setup category without a classification is excluded', () => {
  const candidates = [
    { category_top_level: 'Setup', classification_name: null, intility_worker_fullname: 'Uklassifisert Person' },
  ];
  assert.equal(pickWinningSakseier(candidates), null);
});

test('pickWinningSakseier: Setup category WITH a classification is not excluded', () => {
  const candidates = [
    { category_top_level: 'Setup', classification_name: 'Ny PC', intility_worker_fullname: 'Klassifisert Person' },
  ];
  assert.deepEqual(pickWinningSakseier(candidates), candidates[0]);
});

test('pickWinningSakseier: ties broken by the alphabetically-greatest full name', () => {
  const candidates = [
    { category_name: 'Egenbestillinger', intility_worker_fullname: 'Bernt' },
    { category_name: 'Egenbestillinger', intility_worker_fullname: 'Anna' },
  ];
  assert.deepEqual(pickWinningSakseier(candidates), candidates[0]);
});

test('normalizeOurRef: "Intility Webshop" and blanks become no-owner (null)', () => {
  assert.equal(normalizeOurRef('Intility Webshop'), null);
  assert.equal(normalizeOurRef(''), null);
  assert.equal(normalizeOurRef(null), null);
  assert.equal(normalizeOurRef(undefined), null);
});

test('normalizeOurRef: a real name passes through unchanged', () => {
  assert.equal(normalizeOurRef('Kari Nordmann'), 'Kari Nordmann');
});

test('normalizeFullNameForMatching: trims, lowercases, and collapses internal whitespace', () => {
  assert.equal(normalizeFullNameForMatching('  Kari   Nordmann  '), 'kari nordmann');
});

test('resolvePurchaser: manual order (no PO-nummer) resolves via Vår ref', () => {
  const row = { poNumber: null, supplierOrderNumber: 'BEST-1' };
  const indexes = {
    ourRefBySupplierOrderNumber: new Map([['BEST-1', 'Kari Nordmann']]),
    sakseierByPoCode: new Map(),
    emailByFullName: new Map([['kari nordmann', 'kari.nordmann@intility.no']]),
  };
  assert.deepEqual(resolvePurchaser(row, indexes), {
    purchaserName: 'Kari Nordmann',
    purchaserEmail: 'kari.nordmann@intility.no',
  });
});

test('resolvePurchaser: manual order with no Vår ref match resolves to no owner/email', () => {
  const row = { poNumber: null, supplierOrderNumber: 'BEST-UNKNOWN' };
  const indexes = {
    ourRefBySupplierOrderNumber: new Map(),
    sakseierByPoCode: new Map(),
    emailByFullName: new Map(),
  };
  assert.deepEqual(resolvePurchaser(row, indexes), { purchaserName: null, purchaserEmail: null });
});

test('resolvePurchaser: PO-based order resolves via the pre-resolved sakseier map', () => {
  const row = { poNumber: '146789', supplierOrderNumber: 'BEST-2' };
  const indexes = {
    ourRefBySupplierOrderNumber: new Map(),
    sakseierByPoCode: new Map([['146789', { intility_worker_fullname: 'Ola Hansen' }]]),
    emailByFullName: new Map([['ola hansen', 'ola.hansen@intility.no']]),
  };
  assert.deepEqual(resolvePurchaser(row, indexes), {
    purchaserName: 'Ola Hansen',
    purchaserEmail: 'ola.hansen@intility.no',
  });
});

test('resolvePurchaser: a resolved name with no matching email still returns the name', () => {
  const row = { poNumber: '146789', supplierOrderNumber: 'BEST-2' };
  const indexes = {
    ourRefBySupplierOrderNumber: new Map(),
    sakseierByPoCode: new Map([['146789', { intility_worker_fullname: 'Ukjent Person' }]]),
    emailByFullName: new Map(),
  };
  assert.deepEqual(resolvePurchaser(row, indexes), { purchaserName: 'Ukjent Person', purchaserEmail: null });
});
