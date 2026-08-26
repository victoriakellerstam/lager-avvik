'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { runWeeklyJob } = require('../src/job');
const { isFinanceCase } = require('../src/financeTypes');

test.beforeEach(() => {
  store._reset();
});

test('runWeeklyJob only notifies unresolved, non-Finance avvik that are due, and logs a preview for each', () => {
  const before = store.listAvvik();
  const due = before.filter((a) => !a.resolved && !isFinanceCase(a.discrepancyType)).length;

  const sent = runWeeklyJob(new Date('2100-01-01T00:00:00Z'));

  // Far in the future, every unresolved, non-Finance seed avvik is overdue.
  assert.equal(sent.length, due);
  for (const entry of sent) {
    assert.ok(entry.to);
    assert.ok(entry.subject);
    assert.equal(entry.simulated, true);
  }
  assert.equal(store.listNotifications().length, sent.length);
});

test('a Finance-only case never gets emailed to the purchaser', () => {
  const financeCase = store.listAvvik().find((a) => isFinanceCase(a.discrepancyType));
  assert.ok(financeCase, 'expected a seeded Finance case');

  const sent = runWeeklyJob(new Date('2100-01-01T00:00:00Z'));

  assert.ok(!sent.some((entry) => entry.avvikId === financeCase.id));
});

test('resolving an avvik removes it from future runs', () => {
  const [first] = store.listAvvik();
  store.resolveAvvik(first.id);

  const sent = runWeeklyJob(new Date('2100-01-01T00:00:00Z'));

  assert.ok(!sent.some((entry) => entry.avvikId === first.id));
});

test('running the job twice in a row does not double-notify', () => {
  const now = new Date('2100-01-01T00:00:00Z');
  const first = runWeeklyJob(now);
  const second = runWeeklyJob(now);

  assert.ok(first.length > 0);
  assert.equal(second.length, 0);
});
