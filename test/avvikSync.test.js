'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveStockBreakdown, classifyOutgoingStatus } = require('../src/avvikSync');

function breakdownMap(lotNumber, totalQuantity, resoldQuantity, writtenOffQuantity) {
  return new Map([[String(lotNumber).trim().toLowerCase(), { totalQuantity, resoldQuantity, writtenOffQuantity }]]);
}

test('classifyOutgoingStatus: no units in this category hides the card', () => {
  assert.equal(classifyOutgoingStatus(0, 0, 10), null);
});

test('classifyOutgoingStatus: this category alone covers the total is Ja', () => {
  assert.equal(classifyOutgoingStatus(10, 0, 10), 'Ja');
});

test('classifyOutgoingStatus: this category short of the total is Delvis', () => {
  assert.equal(classifyOutgoingStatus(7, 0, 10), 'Delvis');
});

test('classifyOutgoingStatus: the other category having units forces Delvis, even at the full total', () => {
  assert.equal(classifyOutgoingStatus(10, 1, 10), 'Delvis');
});

// Scenario 1 (delvis videresolgt og delvis skrevet ut): +10 (3030), -3 og -4
// (videresalgstyper), -1 (type 0).
test('resolveStockBreakdown: scenario 1 - partially resold and partially written off', () => {
  const breakdown = resolveStockBreakdown('LOT-1', breakdownMap('LOT-1', 10, 7, 1));
  assert.equal(breakdown.totalQuantity, 10);
  assert.equal(breakdown.resoldQuantity, 7);
  assert.equal(breakdown.writtenOffQuantity, 1);
  assert.equal(breakdown.resoldStatus, 'Delvis');
  assert.equal(breakdown.writtenOffStatus, 'Delvis');
});

// Scenario 2 (alt videresolgt): +10 inn, -10 videresolgt.
test('resolveStockBreakdown: scenario 2 - fully resold hides Skrevet ut av lager', () => {
  const breakdown = resolveStockBreakdown('LOT-2', breakdownMap('LOT-2', 10, 10, 0));
  assert.equal(breakdown.resoldStatus, 'Ja');
  assert.equal(breakdown.writtenOffStatus, null);
});

// Scenario 3 (alt skrevet ut): +10 inn, -10 med type 0.
test('resolveStockBreakdown: scenario 3 - fully written off hides Videresolgt', () => {
  const breakdown = resolveStockBreakdown('LOT-3', breakdownMap('LOT-3', 10, 0, 10));
  assert.equal(breakdown.writtenOffStatus, 'Ja');
  assert.equal(breakdown.resoldStatus, null);
});

// Scenario 4 (blandet, uten restlager): +10 inn, -8 videresolgt, -2 type 0 -
// begge skal likevel vise Delvis, ikke Ja, selv om de sammen dekker totalen.
test('resolveStockBreakdown: scenario 4 - mixed with no remaining stock still shows Delvis for both', () => {
  const breakdown = resolveStockBreakdown('LOT-4', breakdownMap('LOT-4', 10, 8, 2));
  assert.equal(breakdown.resoldStatus, 'Delvis');
  assert.equal(breakdown.writtenOffStatus, 'Delvis');
});

// Scenario 5 (ingen utgående bevegelser): +10 inn, ingenting ut.
test('resolveStockBreakdown: scenario 5 - no outgoing movements hides both cards', () => {
  const breakdown = resolveStockBreakdown('LOT-5', breakdownMap('LOT-5', 10, 0, 0));
  assert.equal(breakdown.resoldStatus, null);
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
