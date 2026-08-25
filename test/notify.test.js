'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { needsNotification, buildEmailPreview, ONE_WEEK_MS } = require('../src/notify');

test('a resolved avvik never needs a notification', () => {
  const avvik = { resolved: true, lastNotifiedAt: null };
  assert.equal(needsNotification(avvik, new Date()), false);
});

test('an unresolved, never-notified avvik needs a notification', () => {
  const avvik = { resolved: false, lastNotifiedAt: null };
  assert.equal(needsNotification(avvik, new Date()), true);
});

test('an avvik notified less than a week ago does not need another one', () => {
  const now = new Date('2026-08-25T00:00:00Z');
  const avvik = {
    resolved: false,
    lastNotifiedAt: new Date(now.getTime() - (ONE_WEEK_MS - 1)).toISOString(),
  };
  assert.equal(needsNotification(avvik, now), false);
});

test('an avvik notified a week or more ago needs another notification', () => {
  const now = new Date('2026-08-25T00:00:00Z');
  const avvik = {
    resolved: false,
    lastNotifiedAt: new Date(now.getTime() - ONE_WEEK_MS).toISOString(),
  };
  assert.equal(needsNotification(avvik, now), true);
});

test('the email preview names the order, the purchaser, and never claims to have sent anything real', () => {
  const preview = buildEmailPreview({
    orderId: 'SO-1',
    purchaserName: 'Kari Nordmann',
    purchaserEmail: 'kari.nordmann@example.com',
    discrepancyType: 'Ikke mottatt faktura i Medius',
  });
  assert.equal(preview.to, 'kari.nordmann@example.com');
  assert.match(preview.subject, /SO-1/);
  assert.match(preview.body, /Kari Nordmann/);
  assert.match(preview.body, /mockup/);
});

test('the email preview includes numbered, type-specific instructions', () => {
  const preview = buildEmailPreview({
    orderId: 'SO-2',
    purchaserName: 'Ola Hansen',
    purchaserEmail: 'ola.hansen@example.com',
    discrepancyType: 'Kostnadsfaktura — reverser',
  });
  assert.match(preview.body, /1\. Reverser kostnadsfakturaen/);
  assert.match(preview.body, /innkjøpsordre/);
});

test('an unknown discrepancy type still gets generic, numbered instructions', () => {
  const preview = buildEmailPreview({
    orderId: 'SO-3',
    purchaserName: 'Test Person',
    purchaserEmail: 'test.person@example.com',
    discrepancyType: 'Noe helt annet',
  });
  assert.match(preview.body, /1\. Undersøk avviket/);
});

test('the email follows the requested shape: order, what the discrepancy is, required action, and who to contact', () => {
  const preview = buildEmailPreview({
    orderId: 'SO-99999-12345',
    purchaserName: 'Kari Nordmann',
    purchaserEmail: 'kari.nordmann@example.com',
    discrepancyType: 'Manuell ordre',
  });
  assert.match(preview.body, /Avvik på din ordre SO-99999-12345\./);
  assert.match(preview.body, /Avviket gjelder: Manuell ordre\./);
  assert.match(preview.body, /Tiltak som kreves fra deg:/);
  assert.match(preview.body, /kontakt med Finance/);
});
