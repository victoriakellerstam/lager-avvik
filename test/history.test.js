'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDailySeries, buildChartItems } = require('../src/history');
const store = require('../src/store');
const { renderOpenAvvikPage, renderArchivePage, ASSET_JS } = require('../src/dashboard');

test('buildDailySeries counts an avvik from its start day up to, not including, its end day', () => {
  const series = buildDailySeries([{ start: '2026-01-03', end: '2026-01-05' }], '2026-01-01', '2026-01-07');
  assert.deepEqual(
    series.map((p) => p.count),
    [0, 0, 1, 1, 0, 0, 0]
  );
  assert.equal(series[0].date, '2026-01-01');
  assert.equal(series[6].date, '2026-01-07');
});

test('buildDailySeries keeps an unresolved avvik counted through the last day', () => {
  const series = buildDailySeries([{ start: '2026-01-02', end: null }], '2026-01-01', '2026-01-04');
  assert.deepEqual(
    series.map((p) => p.count),
    [0, 1, 1, 1]
  );
});

test('buildDailySeries clamps items that start before or end after the range, and skips undated ones', () => {
  const series = buildDailySeries(
    [
      { start: '2025-12-01', end: '2026-01-03' },
      { start: '2026-01-04', end: '2026-03-01' },
      { start: null, end: null },
    ],
    '2026-01-01',
    '2026-01-04'
  );
  assert.deepEqual(
    series.map((p) => p.count),
    [1, 1, 0, 1]
  );
});

test('buildChartItems starts counting the day after the 21-day wait and ends on the resolved date', () => {
  const [item] = buildChartItems(
    [{ receivedAt: '2026-08-21', resolved: true, resolvedAt: '2026-10-02T00:00:00.000Z', orderId: 'A1', department: 'IT' }],
    '2026-10-05'
  );
  assert.equal(item.start, '2026-09-12');
  assert.equal(item.end, '2026-10-02');
  assert.equal(item.department, 'it');
  assert.equal(item.order, 'a1');
});

test('buildChartItems drops a resolved avvik without a receipt date but dates an open one from daysWaiting', () => {
  const items = buildChartItems(
    [
      { resolved: true, resolvedAt: '2026-10-02', daysWaiting: 30 },
      { resolved: false, daysWaiting: 30 },
    ],
    '2026-10-05'
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].start, '2026-09-27');
  assert.equal(items[0].end, null);
});

test('mergeHistoryFromDwh adds closed avvik, dates auto-archived ones, and leaves manual and open ones alone', () => {
  store._reset();
  const base = { poNumber: null, lotNumber: null, discrepancyType: 'Manuell ordre', daysWaiting: 5 };
  const list = store.listAvvik();
  list.length = 0;
  list.push(
    { ...base, id: 'auto1', orderId: 'O1', resolved: true, resolvedSource: 'auto', resolvedAt: '2026-10-05T10:00:00.000Z', comments: [] },
    { ...base, id: 'man1', orderId: 'O2', resolved: true, resolvedSource: 'manual', resolvedAt: '2026-09-01T10:00:00.000Z', comments: [] },
    { ...base, id: 'open1', orderId: 'O3', resolved: false, resolvedSource: null, resolvedAt: null, comments: [] }
  );
  const row = (id, resolvedAt) => ({
    id,
    orderId: id,
    receivedAt: '2026-08-21',
    resolvedAt,
    daysWaiting: 42,
    discrepancyType: 'Ukjent',
  });
  const result = store.mergeHistoryFromDwh([row('auto1', '2026-10-02'), row('man1', '2026-10-02'), row('open1', '2026-10-02'), row('new1', '2026-10-02')]);
  assert.deepEqual(result, { inserted: 1, dated: 1 });
  assert.equal(store.getAvvik('auto1').resolvedAt, '2026-10-02');
  assert.equal(store.getAvvik('man1').resolvedAt, '2026-09-01T10:00:00.000Z');
  assert.equal(store.getAvvik('open1').resolved, false);
  const added = store.getAvvik('new1');
  assert.equal(added.resolved, true);
  assert.equal(added.resolvedSource, 'auto');
  store._reset();
});

test('the trend section lives on the Utvikling page; archive header and script parse', () => {
  store._reset();
  const open = renderOpenAvvikPage(store.listAvvik(), store.listNotifications());
  assert.doesNotMatch(open, /id="trend-chart"/);
  assert.match(open, /class="stats"/);
  const utvikling = require('../src/dashboard').renderUtviklingPage(store.listAvvik());
  assert.match(utvikling, /id="trend-data"/);
  assert.match(utvikling, /id="trend-chart"/);
  const archive = renderArchivePage(store.listAvvik(), store.listNotifications());
  assert.match(archive, /Dager siden mottak til løst/);
  assert.doesNotThrow(() => new Function(ASSET_JS));
});

test('syncResolvedHistory gives a closed avvik its ticket owner, email and the owner\'s department', async () => {
  const dwhQueries = require('../src/dwhQueries');
  const { syncResolvedHistory } = require('../src/avvikSync');
  const original = {
    fetchResolvedHistory: dwhQueries.fetchResolvedHistory,
    fetchIntilityUsers: dwhQueries.fetchIntilityUsers,
    fetchDepartments: dwhQueries.fetchDepartments,
  };
  dwhQueries.fetchResolvedHistory = async () => [
    { supplier_order_number: '312187', article_number: 'A', lot_number: 1, order_date: '2026-08-21', department_number: 0, project_number: 0, po_number: '151082', earliest_receipt_at: '2026-08-21', archived_at: '2026-10-02', case_owner: 'Stian Rydland', ticket_url: 'https://t/1' },
    { supplier_order_number: '312188', article_number: 'B', lot_number: 2, order_date: '2026-08-21', department_number: 35, project_number: 0, po_number: '151083', earliest_receipt_at: '2026-08-21', archived_at: '2026-10-02', case_owner: null, ticket_url: null },
  ];
  dwhQueries.fetchIntilityUsers = async () => [{ user_full_name: 'Stian Rydland', email: 'stian@example.test', department: 'Logistics' }];
  dwhQueries.fetchDepartments = async () => [{ department_number: 35, department_name: 'Collaboration' }];
  try {
    const [withOwner, withoutOwner] = await syncResolvedHistory();
    assert.equal(withOwner.purchaserName, 'Stian Rydland');
    assert.equal(withOwner.purchaserEmail, 'stian@example.test');
    assert.equal(withOwner.department, 'Logistics');
    assert.equal(withOwner.ticketUrl, 'https://t/1');
    assert.equal(withoutOwner.purchaserName, null);
    assert.equal(withoutOwner.department, 'Collaboration');
  } finally {
    Object.assign(dwhQueries, original);
  }
});

test('mergeHistoryFromDwh fills a blank owner on a held auto row but keeps a manual correction', () => {
  store._reset();
  const list = store.listAvvik();
  list.length = 0;
  const base = { orderId: 'O', resolved: true, resolvedSource: 'auto', resolvedAt: '2026-10-02', comments: [], discrepancyType: 'x' };
  list.push(
    { ...base, id: 'blank', purchaserName: null },
    { ...base, id: 'manual', purchaserName: 'Typed By Hand', purchaserManuallySet: true }
  );
  const row = (id) => ({ id, orderId: 'O', receivedAt: '2026-08-21', resolvedAt: '2026-10-02', daysWaiting: 42, purchaserName: 'Ticket Owner', purchaserEmail: 'o@example.test', department: 'Logistics', ticketUrl: 'https://t/2' });
  store.mergeHistoryFromDwh([row('blank'), row('manual')]);
  assert.equal(store.getAvvik('blank').purchaserName, 'Ticket Owner');
  assert.equal(store.getAvvik('blank').department, 'Logistics');
  assert.equal(store.getAvvik('manual').purchaserName, 'Typed By Hand');
  store._reset();
});

test('classifyResolvedType: prosjekt 14000 er Internbestilling, ekte our_ref er Manuell ordre, ellers ukjent', () => {
  const { classifyResolvedType, UNKNOWN_HISTORY_TYPE } = require('../src/avvikSync');
  assert.equal(classifyResolvedType({ project_number: 14000 }), 'Internbestilling');
  // 14000 vinner over our_ref, som for åpne avvik
  assert.equal(classifyResolvedType({ project_number: 14000, manual_order_owner: 'Ola Nordmann' }), 'Internbestilling');
  assert.equal(classifyResolvedType({ project_number: 11246, manual_order_owner: 'Ola Nordmann' }), 'Manuell ordre');
  assert.equal(classifyResolvedType({ project_number: 11246, manual_order_owner: null }), UNKNOWN_HISTORY_TYPE);
  assert.equal(classifyResolvedType({}), UNKNOWN_HISTORY_TYPE);
});

test('syncResolvedHistory gir arkivlinjer type fra prosjekt/our_ref, og manuell ordre får our_ref som sakseier uten ticket', async () => {
  const dwhQueries = require('../src/dwhQueries');
  const { syncResolvedHistory } = require('../src/avvikSync');
  const original = {
    fetchResolvedHistory: dwhQueries.fetchResolvedHistory,
    fetchIntilityUsers: dwhQueries.fetchIntilityUsers,
    fetchDepartments: dwhQueries.fetchDepartments,
  };
  const base = { article_number: 'A', lot_number: 1, order_date: '2026-08-21', department_number: 0, earliest_receipt_at: '2026-08-21', archived_at: '2026-10-02', ticket_url: null };
  dwhQueries.fetchResolvedHistory = async () => [
    { ...base, supplier_order_number: '1', po_number: 'P1', project_number: 14000, case_owner: null, manual_order_owner: null },
    { ...base, supplier_order_number: '2', po_number: 'P2', project_number: 11246, case_owner: null, manual_order_owner: 'Kari Hansen' },
    { ...base, supplier_order_number: '3', po_number: 'P3', project_number: 11246, case_owner: 'Stian Rydland', manual_order_owner: 'Kari Hansen' },
    { ...base, supplier_order_number: '4', po_number: 'P4', project_number: 11246, case_owner: null, manual_order_owner: null },
  ];
  dwhQueries.fetchIntilityUsers = async () => [];
  dwhQueries.fetchDepartments = async () => [];
  try {
    const rows = await syncResolvedHistory();
    assert.deepEqual(rows.map((r) => r.discrepancyType), ['Internbestilling', 'Manuell ordre', 'Manuell ordre', 'Ukjent (løst før appen fulgte saken)']);
    assert.deepEqual(rows.map((r) => r.purchaserName), [null, 'Kari Hansen', 'Stian Rydland', null]);
  } finally {
    Object.assign(dwhQueries, original);
  }
});

test('mergeHistoryFromDwh gir en lagret ukjent arkivrad riktig type, men overskriver aldri en type appen selv har satt', () => {
  const { UNKNOWN_HISTORY_TYPE } = require('../src/discrepancyTypes');
  store._reset();
  const mk = (id, type) => ({
    id, orderId: id, articleNumber: 'A', poNumber: 'P', department: null, purchaserName: null, purchaserEmail: null, ticketUrl: null,
    projectNumber: null, discrepancyType: type, createdAt: null, receivedAt: '2026-08-21T00:00:00.000Z', resolvedAt: '2026-10-02T00:00:00.000Z', daysWaiting: 42,
  });
  store.mergeHistoryFromDwh([mk('h1', UNKNOWN_HISTORY_TYPE), mk('h2', 'Varefaktura — under behandling')]);
  assert.equal(store.getAvvik('h1').discrepancyType, UNKNOWN_HISTORY_TYPE);
  store.mergeHistoryFromDwh([mk('h1', 'Internbestilling'), mk('h2', 'Manuell ordre')]);
  assert.equal(store.getAvvik('h1').discrepancyType, 'Internbestilling');
  assert.equal(store.getAvvik('h2').discrepancyType, 'Varefaktura — under behandling');
});
