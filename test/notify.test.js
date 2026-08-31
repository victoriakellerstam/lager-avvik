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

test('a Finance-only case never needs a notification, however overdue', () => {
  const avvik = {
    resolved: false,
    discrepancyType: 'Spesielle caser - Finance',
    lastNotifiedAt: null,
  };
  assert.equal(needsNotification(avvik, new Date()), false);
});

test('the email preview names the order and article in the subject, and never claims to have sent anything real', () => {
  const preview = buildEmailPreview({
    orderId: 'SO-1',
    articleNumber: 'ART-123',
    purchaserName: 'Kari Nordmann',
    purchaserEmail: 'kari.nordmann@example.com',
    discrepancyType: 'Ikke mottatt faktura i Medius',
    daysWaiting: 25,
  });
  assert.equal(preview.to, 'kari.nordmann@example.com');
  assert.match(preview.subject, /SO-1/);
  assert.match(preview.subject, /ART-123/);
  assert.match(preview.body, /mockup/);
});

test('the email preview includes the type-specific fix instruction', () => {
  const preview = buildEmailPreview({
    orderId: 'SO-2',
    articleNumber: 'ART-2',
    purchaserName: 'Ola Hansen',
    purchaserEmail: 'ola.hansen@example.com',
    discrepancyType: 'Kostnadsfaktura — reverser',
    daysWaiting: 30,
  });
  assert.match(preview.body, /Send informasjon om fakturaen til Finance/);
});

test('an unknown discrepancy type still gets a generic fix instruction', () => {
  const preview = buildEmailPreview({
    orderId: 'SO-3',
    articleNumber: 'ART-3',
    purchaserName: 'Test Person',
    purchaserEmail: 'test.person@example.com',
    discrepancyType: 'Noe helt annet',
    daysWaiting: 22,
  });
  assert.match(preview.body, /Undersøk avviket/);
});

test('the email follows the requested shape: order+SKU in the subject, the scenario, days waiting, the fix, and who to contact', () => {
  const preview = buildEmailPreview({
    orderId: 'SO-99999-12345',
    articleNumber: 'ART-99',
    purchaserName: 'Kari Nordmann',
    purchaserEmail: 'kari.nordmann@example.com',
    discrepancyType: 'Manuell ordre',
    daysWaiting: 40,
  });
  assert.match(preview.subject, /innkjøpsordrenummer SO-99999-12345/);
  assert.match(preview.subject, /SKU ART-99/);
  assert.match(preview.body, /Avviket gjelder at Manuell ordre\./);
  assert.match(preview.body, /40 dager/);
  assert.match(preview.body, /Gi beskjed til Finance om hva som er status på faktura/);
  assert.match(preview.body, /kontakt med Finance/);
});
