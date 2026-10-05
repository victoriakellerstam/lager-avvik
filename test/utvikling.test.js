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

const many = (n) => Array.from({ length: n }, (_, i) => mk(i + 1, 'Lev ' + String(i).padStart(2, '0')));
const barRows = (html) => (html.match(/class="bar-row/g) || []).length;

test('de 10 største leverandørene vises, resten ligger under Vis alle (uten Andre-stolpe)', () => {
  const html = renderUtviklingPage(many(20));
  const [shown, all] = html.split('<details class="supplier-more">');
  assert.equal(barRows(shown), 10);
  assert.equal(barRows(all), 20);
  assert.match(html, /Vis alle 20 leverandører/);
  assert.doesNotMatch(html, /Andre \(/);
  assert.equal((html.match(/<tr><td>/g) || []).length, 20);
});

test('få leverandører gir ingen Vis alle', () => {
  const html = renderUtviklingPage(many(4));
  assert.doesNotMatch(html, /supplier-more/);
  assert.equal(barRows(html), 4);
});

test('leverandørgrafen har en akse med runde verdier', () => {
  const list = [...many(3), ...Array.from({ length: 11 }, (_, i) => mk(100 + i, 'Lev 00'))];
  const html = renderUtviklingPage(list);
  assert.match(html, /class="bar-axis"/);
  const ticks = [...html.split('<details')[0].matchAll(/class="bar-axis-tick"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
  assert.deepEqual(ticks, [0, 5, 10, 15]);
});

test('Utvikling ligger i menyen, og grafen er flyttet bort fra åpne avvik', () => {
  const utvikling = renderUtviklingPage([mk(1, 'A')]);
  assert.match(utvikling, /href="\/utvikling"/);
  const open = renderOpenAvvikPage([mk(1, 'A')], []);
  assert.doesNotMatch(open, /id="trend-chart"/);
  assert.match(open, /href="\/utvikling"/);
});

test('åpne-stolper lenker til Åpne avvik filtrert på leverandøren, andre visninger gjør ikke det', () => {
  const list = [mk(100, 'Tech & Data AS'), mk(1, 'Tech & Data AS'), mk(2, 'Lev 01')];
  const html = renderUtviklingPage(list);
  assert.match(html, /href="\/\?leverandor=Tech%20%26%20Data%20AS"/);
  assert.equal((html.match(/class="bar-row bar-row-link"/g) || []).length, 2);
  const registrert = renderUtviklingPage(list, { visning: 'registrert' });
  assert.doesNotMatch(registrert, /bar-row-link/);
});

test('periode, avdeling, leverandør og status filtrerer og vises som aktive filtre', () => {
  const list = [
    mk(1, 'A AS', { department: 'IT' }),
    mk(2, 'B AS', { department: 'Salg' }),
    mk(3, 'B AS', { department: 'Salg', resolved: true, resolvedAt: '2026-10-01', receivedAt: '2026-08-20' }),
  ];
  const today = '2026-10-05';
  const all = renderUtviklingPage(list, {}, today);
  assert.match(all, /Siste 90 dager/);
  const salg = renderUtviklingPage(list, { avdeling: 'Salg', leverandor: 'B AS', status: 'apne' }, today);
  assert.match(salg, /Avdeling: <strong>Salg<\/strong>/);
  assert.match(salg, /Leverandør: <strong>B AS<\/strong>/);
  assert.match(salg, /Status: <strong>Åpne<\/strong>/);
  assert.match(salg, /Nullstill filtre/);
  assert.equal(barRows(salg), 1);
  assert.doesNotMatch(all, /Nullstill filtre/);
});

test('perioden og hva grafen viser står i tittelen, og Registrert/Lukket er egne visninger', () => {
  const today = '2026-10-05';
  const list = [mk(1, 'A AS', { receivedAt: '2026-08-20' }), mk(2, 'A AS', { receivedAt: '2026-08-20', resolved: true, resolvedAt: '2026-10-01' })];
  const apne = renderUtviklingPage(list, { periode: '30' }, today);
  assert.match(apne, /Siste 30 dager · 6\. sep\.? 2026 – 5\. okt\.? 2026/);
  assert.match(apne, /Åpne avvik \(saldo per dag\)/);
  const lukket = renderUtviklingPage(list, { periode: '30', visning: 'lukket' }, today);
  assert.match(lukket, /Lukkede avvik \(per dag\)/);
  assert.match(lukket, /Lukkede avvik per leverandør/);
  assert.match(lukket, /1 lukkede avvik fordelt på 1 leverandører/);
  const reg = renderUtviklingPage(list, { periode: '30', visning: 'registrert' }, today);
  assert.match(reg, /Registrerte avvik \(per dag\)/);
});

test('lange perioder kuttes ved historikkens start og forklares', () => {
  const html = renderUtviklingPage([mk(1, 'A')], { periode: '365' }, '2026-10-05');
  assert.match(html, /Historikken starter/);
  const short = renderUtviklingPage([mk(1, 'A')], { periode: '30' }, '2026-10-05');
  assert.doesNotMatch(short, /Historikken starter/);
});

test('ukjente parametre faller tilbake til standarden', () => {
  const html = renderUtviklingPage([mk(1, 'A')], { periode: 'x', visning: 'y', status: 'z' });
  assert.match(html, /Siste 90 dager/);
  assert.match(html, /Åpne avvik \(saldo per dag\)/);
});

test('åpne-listen har leverandørfilter og radene bærer leverandøren (ukjent samles)', () => {
  const html = renderOpenAvvikPage([mk(1, 'Tech Data Norge AS'), mk(2, null)], []);
  assert.match(html, /data-col="supplier"/);
  assert.match(html, /data-supplier="tech data norge as"/);
  assert.match(html, /data-supplier="ukjent leverandør"/);
});
