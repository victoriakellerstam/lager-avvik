'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderUtviklingPage, renderOpenAvvikPage } = require('../src/dashboard');

const mk = (id, supplierName, extra = {}) => ({
  id,
  orderId: 'O' + id,
  poNumber: null,
  articleNumber: 'A',
  department: 'IT',
  purchaserName: 'Ola',
  supplierName,
  discrepancyType: 'Manuell ordre',
  comments: [],
  daysWaiting: 30,
  resolved: false,
  ...extra,
});

test('Utvikling-siden har trendgrafen og leverandørdiagrammet, sortert størst først', () => {
  const html = renderUtviklingPage([mk(1, 'B AS'), mk(2, 'A AS'), mk(3, 'A AS'), mk(4, null)]);
  assert.match(html, /id="trend-chart"/);
  assert.match(html, /Åpne avvik per leverandør/);
  const labels = [...html.matchAll(/class="bar-row[^"]*" data-label="([^"]*)" data-value="(\d+)"/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(labels[0], ['A AS', 2]);
  assert.ok(labels.some(([name]) => name === 'Ukjent leverandør'));
});

test('leverandører utover de største slås sammen til Andre, tabellen har alle', () => {
  const list = Array.from({ length: 20 }, (_, i) => mk(i + 1, 'Lev ' + String(i).padStart(2, '0')));
  const html = renderUtviklingPage(list);
  assert.equal((html.match(/class="bar-row/g) || []).length, 16);
  assert.match(html, /Andre \(5 leverandører\)/);
  assert.equal((html.match(/<tr><td>/g) || []).length, 20);
});

test('Utvikling ligger i menyen, og grafen er flyttet bort fra åpne avvik', () => {
  const utvikling = renderUtviklingPage([mk(1, 'A')]);
  assert.match(utvikling, /href="\/utvikling"/);
  const open = renderOpenAvvikPage([mk(1, 'A')], []);
  assert.doesNotMatch(open, /id="trend-chart"/);
  assert.match(open, /href="\/utvikling"/);
});

test('hver leverandørstolpe lenker til Åpne avvik filtrert på leverandøren, Andre gjør ikke det', () => {
  const list = [mk(100, 'Tech & Data AS'), ...Array.from({ length: 17 }, (_, i) => mk(i + 1, i === 0 ? 'Tech & Data AS' : 'Lev ' + String(i).padStart(2, '0')))];
  const html = renderUtviklingPage(list);
  assert.match(html, /href="\/\?leverandor=Tech%20%26%20Data%20AS"/);
  assert.equal((html.match(/class="bar-row bar-row-link"/g) || []).length, 15);
  assert.match(html, /<div class="bar-row" data-label="Andre/);
});

test('åpne-listen har leverandørfilter og radene bærer leverandøren (ukjent samles)', () => {
  const html = renderOpenAvvikPage([mk(1, 'Tech Data Norge AS'), mk(2, null)], []);
  assert.match(html, /data-col="supplier"/);
  assert.match(html, /data-supplier="tech data norge as"/);
  assert.match(html, /data-supplier="ukjent leverandør"/);
});
