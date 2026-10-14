'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// index.js pulls its dwh sync functions in from avvikSync.js, so the stub has to
// be in place before index.js is first loaded.
const avvikSyncPath = require.resolve('../src/avvikSync');
// index.js destructures these at load time, so each export delegates to a
// handler the tests can swap.
const handlers = {
  avvik: async () => [],
  history: async () => [],
  customerOrders: async () => [],
};
const stub = {
  syncAvvikFromDwh: (...a) => handlers.avvik(...a),
  syncResolvedHistory: (...a) => handlers.history(...a),
  syncCustomerOrdersFromDwh: (...a) => handlers.customerOrders(...a),
  resolveDepartmentForPurchaser: async () => null,
};
require.cache[avvikSyncPath] = { id: avvikSyncPath, filename: avvikSyncPath, loaded: true, exports: stub, children: [], paths: [], path: path.dirname(avvikSyncPath) };

const store = require('../src/store');
const { refreshFromDwh } = require('../src/index');

const ORDER = { visma_customer_order_number: 1001, order_at: '2026-01-10T00:00:00.000Z', owner_name: 'Kari', department_name: 'D', oms_order_url: '', total_amount: 10 };

test('kundeordre is refreshed even when the avvik sync fails, and the avvik error still surfaces', async () => {
  store._reset();
  handlers.avvik = async () => { throw new Error('Query timeout expired'); };
  handlers.customerOrders = async () => [ORDER];
  await assert.rejects(refreshFromDwh(), /Query timeout expired/);
  assert.equal(store.listCustomerOrders().length, 1);
  assert.ok(store.getLastCustomerOrdersRefreshAt());
  assert.equal(store.getLastDwhRefreshAt(), null); // the avvik side did not refresh
});

test('a kundeordre failure keeps the previous list and does not fail the refresh', async () => {
  store._reset();
  handlers.avvik = async () => [];
  handlers.customerOrders = async () => [ORDER];
  await refreshFromDwh();
  handlers.customerOrders = async () => { throw new Error('boom'); };
  const result = await refreshFromDwh();
  assert.equal(result.customerOrders, null);
  assert.equal(store.listCustomerOrders().length, 1);
  assert.ok(store.getLastDwhRefreshAt());
});
