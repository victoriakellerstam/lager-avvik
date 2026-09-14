'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveStockBreakdown, resolveResoldStatus, resolveWrittenOffStatus } = require('../src/avvikSync');

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
