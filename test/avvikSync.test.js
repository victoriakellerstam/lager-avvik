'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveStockBreakdown,
  resolveResoldStatus,
  resolveWrittenOffStatus,
  pickBestMediusInvoice,
  buildMediusLinkKey,
  buildMediusCostLinkKey,
} = require('../src/avvikSync');

function breakdownMap(lotNumber, totalQuantity, resoldQuantity, writtenOffQuantity) {
  return new Map([[String(lotNumber).trim().toLowerCase(), { totalQuantity, resoldQuantity, writtenOffQuantity }]]);
}

test('resolveResoldStatus: nothing resold or written off yet is Nei, not hidden', () => {
  assert.equal(resolveResoldStatus(0, 0, 10), 'Nei');
});

test('resolveResoldStatus: some resold, short of the total, is Delvis', () => {
  assert.equal(resolveResoldStatus(7, 0, 10), 'Delvis');
});

test('resolveResoldStatus: fully resold with nothing written off is Ja', () => {
  assert.equal(resolveResoldStatus(10, 0, 10), 'Ja');
});

test('resolveResoldStatus: resold covers the total but something is also written off is Delvis, not Ja', () => {
  assert.equal(resolveResoldStatus(10, 1, 10), 'Delvis');
});

test('resolveResoldStatus: fully written off with nothing resold hides Videresolgt entirely', () => {
  assert.equal(resolveResoldStatus(0, 10, 10), null);
});

test('resolveWrittenOffStatus: nothing written off hides the card', () => {
  assert.equal(resolveWrittenOffStatus(0, 0, 10), null);
});

test('resolveWrittenOffStatus: fully written off with nothing resold is Ja', () => {
  assert.equal(resolveWrittenOffStatus(0, 10, 10), 'Ja');
});

test('resolveWrittenOffStatus: partially written off (nothing resold) is Delvis', () => {
  assert.equal(resolveWrittenOffStatus(0, 4, 10), 'Delvis');
});

test('resolveWrittenOffStatus: written off covers the total but something is also resold is Delvis, not Ja', () => {
  assert.equal(resolveWrittenOffStatus(1, 10, 10), 'Delvis');
});

// Scenario 1: total = 10, videresolgt = 0, skrevet ut = 0.
test('resolveStockBreakdown: scenario 1 - nothing resold or written off yet', () => {
  const breakdown = resolveStockBreakdown('LOT-1', breakdownMap('LOT-1', 10, 0, 0));
  assert.equal(breakdown.resoldStatus, 'Nei');
  assert.equal(breakdown.writtenOffStatus, null);
});

// Scenario 2: total = 10, videresolgt = 0, skrevet ut = 10.
test('resolveStockBreakdown: scenario 2 - fully written off hides Videresolgt entirely', () => {
  const breakdown = resolveStockBreakdown('LOT-2', breakdownMap('LOT-2', 10, 0, 10));
  assert.equal(breakdown.resoldStatus, null);
  assert.equal(breakdown.writtenOffStatus, 'Ja');
});

// Scenario 3: total = 10, videresolgt = 0, skrevet ut = 4.
test('resolveStockBreakdown: scenario 3 - partially written off, nothing resold', () => {
  const breakdown = resolveStockBreakdown('LOT-3', breakdownMap('LOT-3', 10, 0, 4));
  assert.equal(breakdown.resoldStatus, 'Nei');
  assert.equal(breakdown.writtenOffStatus, 'Delvis');
});

// Scenario 4: total = 10, videresolgt = 7, skrevet ut = 1.
test('resolveStockBreakdown: scenario 4 - both resold and written off show Delvis', () => {
  const breakdown = resolveStockBreakdown('LOT-4', breakdownMap('LOT-4', 10, 7, 1));
  assert.equal(breakdown.resoldStatus, 'Delvis');
  assert.equal(breakdown.writtenOffStatus, 'Delvis');
});

// Scenario 5: total = 10, videresolgt = 10, skrevet ut = 0.
test('resolveStockBreakdown: scenario 5 - fully resold hides Skrevet ut av lager', () => {
  const breakdown = resolveStockBreakdown('LOT-5', breakdownMap('LOT-5', 10, 10, 0));
  assert.equal(breakdown.resoldStatus, 'Ja');
  assert.equal(breakdown.writtenOffStatus, null);
});

test('resolveStockBreakdown: no breakdown row at all for the lot (never received, or no lot_number) hides both cards', () => {
  const breakdown = resolveStockBreakdown('LOT-UKJENT', new Map());
  assert.equal(breakdown.totalQuantity, 0);
  assert.equal(breakdown.resoldQuantity, 0);
  assert.equal(breakdown.writtenOffQuantity, 0);
  assert.equal(breakdown.resoldStatus, null);
  assert.equal(breakdown.writtenOffStatus, null);
});

test('resolveStockBreakdown: lot_number lookup is trimmed/lowercased the same way the sync builds the map', () => {
  const breakdown = resolveStockBreakdown('  Lot-6  ', breakdownMap('lot-6', 5, 5, 0));
  assert.equal(breakdown.resoldStatus, 'Ja');
});

// Known data-inconsistency case (duplicate stock_history rows / bad lot
// join): the raw computed values are kept as-is (not silently clamped), and
// a warning naming the lot and the three quantities is logged.
test('resolveStockBreakdown: resoldQuantity + writtenOffQuantity exceeding totalQuantity logs a warning without altering the values', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => warnings.push(msg));

  const breakdown = resolveStockBreakdown('LOT-7', breakdownMap('LOT-7', 10, 8, 5));

  assert.equal(breakdown.resoldQuantity, 8);
  assert.equal(breakdown.writtenOffQuantity, 5);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /LOT-7/);
  assert.match(warnings[0], /8/);
  assert.match(warnings[0], /5/);
  assert.match(warnings[0], /10/);
});

// Scenario 1: én arkivert og én makulert faktura med samme fakturanummer -
// lenken skal peke til den arkiverte fakturaen.
test('pickBestMediusInvoice: an Archived candidate wins over an Invalidated one with the same invoice_number', () => {
  const archived = { invoice_number: 'INV-1', medius_link: 'https://medius/archived', processing_status: 'Archived', document_id: 'D1' };
  const invalidated = { invoice_number: 'INV-1', medius_link: 'https://medius/invalidated', processing_status: 'Invalidated', document_id: 'D2' };

  assert.deepEqual(pickBestMediusInvoice([invalidated, archived]), archived);
  assert.deepEqual(pickBestMediusInvoice([archived, invalidated]), archived);
});

// Scenario 2: bare én makulert faktura - behold eksisterende oppførsel
// (den vises, siden det ikke finnes noe bedre alternativ).
test('pickBestMediusInvoice: a lone Invalidated candidate is still kept as-is', () => {
  const invalidated = { invoice_number: 'INV-2', medius_link: 'https://medius/invalidated', processing_status: 'Invalidated', document_id: 'D1' };
  assert.deepEqual(pickBestMediusInvoice([invalidated]), invalidated);
});

// Scenario 3: bare én arkivert faktura - lenken skal peke til den.
test('pickBestMediusInvoice: a lone Archived candidate is kept', () => {
  const archived = { invoice_number: 'INV-3', medius_link: 'https://medius/archived', processing_status: 'Archived', document_id: 'D1' };
  assert.deepEqual(pickBestMediusInvoice([archived]), archived);
});

// Scenario 4: flere arkiverte fakturaer med samme fakturanummer - velg
// deterministisk (document_id er en stabil, ikke-bekreftet-som-dato
// tiebreak - se avvikSync.js's pickBestMediusInvoice).
test('pickBestMediusInvoice: multiple Archived candidates pick the same one deterministically, regardless of input order', () => {
  const archived1 = { invoice_number: 'INV-4', medius_link: 'https://medius/a', processing_status: 'Archived', document_id: 'D1' };
  const archived2 = { invoice_number: 'INV-4', medius_link: 'https://medius/b', processing_status: 'Archived', document_id: 'D2' };

  const pickA = pickBestMediusInvoice([archived1, archived2]);
  const pickB = pickBestMediusInvoice([archived2, archived1]);
  assert.deepEqual(pickA, pickB);
  assert.deepEqual(pickA, archived2); // higher document_id, per the documented tiebreak
});

// Scenario 5: samme fakturanummer hos forskjellige leverandører - ikke
// krysskoble. Grupperingen (buildMediusLinkKey) inkluderer supplier_id, så
// to ulike leverandører for samme PO+artikkel havner aldri i samme gruppe
// for pickBestMediusInvoice å velge mellom.
test('buildMediusLinkKey: different suppliers for the same PO+article never collide into the same key', () => {
  const keyA = buildMediusLinkKey('PO-1', 'ART-1', 'SUPPLIER-A');
  const keyB = buildMediusLinkKey('PO-1', 'ART-1', 'SUPPLIER-B');
  assert.notEqual(keyA, keyB);
});

// Scenario 6: internbestilling med både makulert og arkivert faktura -
// samme mekanisme som scenario 1, uavhengig av discrepancyType (denne
// funksjonen kjenner ikke avviksstatusen, kun medius_invoice_head-radene).
test('pickBestMediusInvoice: Archived wins over Invalidated regardless of which avvik type triggered the lookup', () => {
  const archived = { invoice_number: 'INV-6', medius_link: 'https://medius/archived', processing_status: 'Archived', document_id: 'D1' };
  const invalidated = { invoice_number: 'INV-6', medius_link: 'https://medius/invalidated', processing_status: 'Invalidated', document_id: 'D2' };
  assert.deepEqual(pickBestMediusInvoice([invalidated, archived]), archived);
});

test('pickBestMediusInvoice: an Open candidate (valid/active, neither Archived nor Invalidated) beats Invalidated', () => {
  const open = { invoice_number: 'INV-7', medius_link: 'https://medius/open', processing_status: 'Open', document_id: 'D1' };
  const invalidated = { invoice_number: 'INV-7', medius_link: 'https://medius/invalidated', processing_status: 'Invalidated', document_id: 'D2' };
  assert.deepEqual(pickBestMediusInvoice([invalidated, open]), open);
});

test('pickBestMediusInvoice: Archived still wins over an Open candidate', () => {
  const archived = { invoice_number: 'INV-8', medius_link: 'https://medius/archived', processing_status: 'Archived', document_id: 'D1' };
  const open = { invoice_number: 'INV-8', medius_link: 'https://medius/open', processing_status: 'Open', document_id: 'D2' };
  assert.deepEqual(pickBestMediusInvoice([open, archived]), archived);
});

// Confirmed against real dwh data (PO 148789's two "Non-PO invoice"
// candidates): a Kostnadsfaktura invoice_head row can have document_id
// NULL - the fallback to invoice_number must still pick deterministically,
// regardless of input order.
test('pickBestMediusInvoice: falls back to invoice_number when document_id is null on both candidates (Kostnadsfaktura case)', () => {
  const a = { invoice_number: '8281495964', medius_link: 'https://medius/a', processing_status: 'Archived', document_id: null };
  const b = { invoice_number: '8281668350', medius_link: 'https://medius/b', processing_status: 'Archived', document_id: null };

  const pickA = pickBestMediusInvoice([a, b]);
  const pickB = pickBestMediusInvoice([b, a]);
  assert.deepEqual(pickA, pickB);
  assert.deepEqual(pickA, b); // higher invoice_number, per the documented fallback tiebreak
});

// Scenario: a Kostnadsfaktura reversal matched via PO+supplier only (see
// dwhQueries.js's fetchMediusCostInvoiceLinks) - no article involved, unlike
// buildMediusLinkKey.
test('buildMediusCostLinkKey: same PO+supplier collide into the same key regardless of article', () => {
  const key = buildMediusCostLinkKey('PO-1', 'SUPPLIER-A');
  assert.equal(key, buildMediusCostLinkKey('PO-1', 'SUPPLIER-A'));
});

test('buildMediusCostLinkKey: different suppliers for the same PO never collide into the same key', () => {
  const keyA = buildMediusCostLinkKey('PO-1', 'SUPPLIER-A');
  const keyB = buildMediusCostLinkKey('PO-1', 'SUPPLIER-B');
  assert.notEqual(keyA, keyB);
});
