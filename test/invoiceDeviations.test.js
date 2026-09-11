'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeInvoiceDeviations } = require('../src/invoiceDeviations');

test('describeInvoiceDeviations: a known single deviation names the article and asks for a Medius comment', () => {
  const text = describeInvoiceDeviations(['Quantity deviation'], 'ART-1');
  assert.match(text, /Antallet på fakturaen avviker fra innkjøpsordre for ART-1/);
  assert.match(text, /Gi beskjed til Finance og legg igjen en kommentar i Medius/);
});

test('describeInvoiceDeviations: each known deviation_name maps to a distinct Norwegian fragment', () => {
  assert.match(describeInvoiceDeviations(['Unit price deviation'], 'ART-1'), /^Enhetsprisen/);
  assert.match(describeInvoiceDeviations(['Line amount deviation'], 'ART-1'), /^Linjebeløpet/);
  assert.match(describeInvoiceDeviations(['Total amount deviation'], 'ART-1'), /^Totalbeløpet/);
  assert.match(describeInvoiceDeviations(['Unit price additional charge deviation'], 'ART-1'), /^Enhetsprisen \(tilleggskostnad\)/);
  assert.match(describeInvoiceDeviations(['Line amount additional charge deviation'], 'ART-1'), /^Linjebeløpet \(tilleggskostnad\)/);
});

test('describeInvoiceDeviations: multiple deviations on the same line are joined with "og"', () => {
  const text = describeInvoiceDeviations(['Quantity deviation', 'Unit price deviation'], 'ART-1');
  assert.match(text, /^Antallet og enhetsprisen på fakturaen avviker fra innkjøpsordre for ART-1\./);
});

test('describeInvoiceDeviations: no deviations, or none recognized, falls back to null', () => {
  assert.equal(describeInvoiceDeviations([], 'ART-1'), null);
  assert.equal(describeInvoiceDeviations(undefined, 'ART-1'), null);
  assert.equal(describeInvoiceDeviations(['Noe helt ukjent'], 'ART-1'), null);
});
