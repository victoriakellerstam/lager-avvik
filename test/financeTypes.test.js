'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isFinanceCase } = require('../src/financeTypes');

test('the Finance scenario is recognized as a Finance-only case', () => {
  assert.equal(isFinanceCase('Spesielle caser - Finance'), true);
});

test('other scenario types are not Finance-only cases', () => {
  assert.equal(isFinanceCase('Manuell ordre'), false);
  assert.equal(isFinanceCase('Noe helt annet'), false);
});
