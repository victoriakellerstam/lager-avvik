'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fillCustomerOrderDepartments, blankNonPersonOwners, fillOwnersFromPo } = require('../src/avvikSync');

test('fillOwnersFromPo only fills an order that has no person as innkjøper', () => {
  const rows = fillOwnersFromPo(
    blankNonPersonOwners([
      { owner_name: 'Intility Webshop', po_owner_name: 'Kari Nordmann' },
      { owner_name: 'Ola Hansen', po_owner_name: 'Kari Nordmann' },
      { owner_name: 'VismaAPI', po_owner_name: null },
    ])
  );
  assert.deepEqual(rows.map((r) => r.owner_name), ['Kari Nordmann', 'Ola Hansen', null]);
});

test('blankNonPersonOwners blanks the webshop, service-account and VismaAPI owners only', () => {
  const rows = blankNonPersonOwners([
    { owner_name: 'Intility Webshop' },
    { owner_name: 'Ball serviceaccount' },
    { owner_name: ' intility  webshop ' },
    { owner_name: 'Kari Nordmann' },
    { owner_name: 'VismaAPI' },
  ]);
  assert.deepEqual(rows.map((r) => r.owner_name), [null, null, null, 'Kari Nordmann', null]);
});

const users = [
  { user_full_name: 'Kari Nordmann', department: 'Collaboration Technologies' },
  { user_full_name: 'Ola  Hansen', department: 'Network Services' },
];

test('fillCustomerOrderDepartments fills a missing department from the sakseier', () => {
  const rows = fillCustomerOrderDepartments(
    [
      { visma_customer_order_number: 1, owner_name: 'kari nordmann', department_name: null },
      { visma_customer_order_number: 2, owner_name: 'Ola Hansen', department_name: '' },
    ],
    users
  );
  assert.deepEqual(rows.map((r) => r.department_name), ['Collaboration Technologies', 'Network Services']);
});

test('fillCustomerOrderDepartments prefers the sakseier\'s own department over the order\'s', () => {
  const rows = fillCustomerOrderDepartments(
    [{ visma_customer_order_number: 1, owner_name: 'Kari Nordmann', department_name: 'Logistics' }],
    users
  );
  assert.equal(rows[0].department_name, 'Collaboration Technologies');
});

test('fillCustomerOrderDepartments keeps the order\'s department for an owner not in the directory', () => {
  const rows = fillCustomerOrderDepartments(
    [
      { visma_customer_order_number: 1, owner_name: 'Ukjent Person', department_name: 'Network Services - Projects' },
      { visma_customer_order_number: 2, owner_name: 'Intility Webshop', department_name: null },
    ],
    users
  );
  assert.equal(rows[0].department_name, 'Network Services - Projects');
  assert.equal(rows[1].department_name, null);
});

test('fillCustomerOrderDepartments shows "Collaboration Technologies" for both names of that department', () => {
  const rows = fillCustomerOrderDepartments(
    [
      { visma_customer_order_number: 1, owner_name: 'Intility Webshop', department_name: 'Collaboration & AV Technologies' },
      { visma_customer_order_number: 2, owner_name: 'Kari Nordmann', department_name: 'Collaboration Technologies' },
    ],
    users
  );
  assert.deepEqual(rows.map((r) => r.department_name), ['Collaboration Technologies', 'Collaboration Technologies']);
});
