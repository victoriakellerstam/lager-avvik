'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/store');

const ROW = (n) => ({ visma_customer_order_number: n, order_at: '2026-01-10T00:00:00.000Z', owner_name: 'A', department_name: 'D', oms_order_url: '' });

test('customer orders carry a thread id and their comments', () => {
  store._reset();
  store.setCustomerOrders([ROW(1001), ROW(1002)]);
  assert.deepEqual(store.listCustomerOrders().map((o) => [o.id, o.comments.length]), [['k1001', 0], ['k1002', 0]]);

  const first = store.addComment('k1001', 'Kari', 'Venter på kunde');
  assert.equal(first.id, 1);
  store.addComment('k1001', 'Ola', 'Purret');
  const orders = store.listCustomerOrders();
  assert.deepEqual(orders[0].comments.map((c) => c.author), ['Kari', 'Ola']);
  assert.equal(orders[1].comments.length, 0);
});

test('comments can be edited and attachments removed on a customer order', () => {
  store._reset();
  store.setCustomerOrders([ROW(1001)]);
  store.addComment('k1001', 'Kari', 'Hei', [{ id: 'abc-1', name: 'f.pdf', size: 10 }]);
  const edited = store.updateComment('k1001', 1, { author: 'Kari N', text: 'Rettet' });
  assert.equal(edited.text, 'Rettet');
  assert.ok(edited.editedAt);
  assert.deepEqual(store.removeAttachment('k1001', 1, 'abc-1'), { id: 'abc-1', name: 'f.pdf', size: 10 });
  assert.equal(store.getThread('k1001').comments[0].attachments, undefined);
});

test('an unknown customer order has no thread and rejects comments', () => {
  store._reset();
  store.setCustomerOrders([ROW(1001)]);
  assert.equal(store.getThread('k9999'), null);
  assert.equal(store.addComment('k9999', 'Kari', 'Hei'), null);
});

test('customer order comments survive a restart and outlive the order in dwh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-avvik-k-'));
  const file = path.join(dir, 'state.json');
  try {
    store._reset();
    store._enablePersistenceAt(file);
    store.setCustomerOrders([ROW(1001)]);
    store.addComment('k1001', 'Kari', 'Husk denne');

    store._reset();
    store._enablePersistenceAt(file);
    store.initPersistence();
    // The order is no longer in open_orders (invoiced), but the comment stays.
    assert.equal(store.getThread('k1001').comments[0].text, 'Husk denne');
    store.setCustomerOrders([ROW(1001)]);
    assert.equal(store.listCustomerOrders()[0].comments.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.LAGER_AVVIK_STATE_FILE;
    store._reset();
  }
});
