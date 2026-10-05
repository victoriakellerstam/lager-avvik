'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dwhQueries = require('../src/dwhQueries');

// With no keys there is nothing to look up, so each narrowed lookup must answer
// [] without opening a dwh connection (these would hang or throw without one).
for (const name of [
  'fetchMediusLinks',
  'fetchMediusCostInvoiceLinks',
  'fetchStockMovementBreakdownByLot',
  'fetchOrderDeviations',
  'fetchMediusOrderLines',
  'fetchUnconnectedInvoiceLines',
  'fetchMediusInvoiceHeadByNumber',
]) {
  test(`${name}: an empty key list returns nothing without querying dwh`, async () => {
    assert.deepEqual(await dwhQueries[name]([]), []);
  });
}
