'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildXlsx, crc32 } = require('../src/xlsx');
const { filterKundeordre, selectOverdueKundeordre, kundeordreXlsxRows, sumKundeordreAmounts, parseFraDate, renderKundeordrePage } = require('../src/dashboard');

// Reads the stored entries back out of a zip, checking each CRC on the way.
function readZip(buf) {
  const entries = {};
  let pos = 0;
  while (buf.readUInt32LE(pos) === 0x04034b50) {
    const crc = buf.readUInt32LE(pos + 14);
    const size = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const name = buf.toString('utf8', pos + 30, pos + 30 + nameLen);
    const data = buf.subarray(pos + 30 + nameLen, pos + 30 + nameLen + size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    entries[name] = data.toString('utf8');
    pos += 30 + nameLen + size;
  }
  assert.equal(buf.readUInt32LE(pos), 0x02014b50, 'central directory follows the entries');
  return entries;
}

test('buildXlsx writes a workbook with a header, numbers, dates and escaped text', () => {
  const files = readZip(
    buildXlsx({
      sheetName: 'Kundeordre',
      columns: [{ header: 'Kundeordre' }, { header: 'Ordredato' }, { header: 'Innkjøper' }],
      rows: [[523714, { date: '2026-10-12' }, 'A & <B>']],
    })
  );
  assert.deepEqual(Object.keys(files).sort(), [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml',
  ]);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<c r="A2"><v>523714<\/v><\/c>/);
  assert.match(sheet, /<c r="B2" s="2"><v>46307<\/v><\/c>/); // 2026-10-12 as an Excel serial
  assert.match(sheet, /A &amp; &lt;B&gt;/);
  assert.match(sheet, /<autoFilter ref="A1:C2"\/>/);
});

const orders = [
  { orderNumber: '1001', orderStatus: 1030, totalAmount: 1000.5, orderDate: '2026-01-10', purchaser: 'Kari Nordmann', department: 'Sales', omsUrl: 'https://oms.example/1001' },
  { orderNumber: '1002', orderStatus: 1000, totalAmount: 250, orderDate: '2026-10-10', purchaser: 'Ola Hansen', department: 'Support', omsUrl: 'javascript:alert(1)' },
  { orderNumber: '1003', orderStatus: 1010, orderDate: '', purchaser: '', department: '', omsUrl: '' },
];
const now = new Date('2026-10-12T10:00:00Z');

test('selectOverdueKundeordre adds days since creation and lists the oldest first', () => {
  const selected = selectOverdueKundeordre([orders[1], orders[0]], '1', now);
  assert.deepEqual(selected.map((o) => [o.orderNumber, o.daysSinceCreated]), [['1001', 275], ['1002', 2]]);
});

test('selectOverdueKundeordre can keep just one of the two status views', () => {
  assert.deepEqual(selectOverdueKundeordre(orders, '1', now, 'behandling').map((o) => o.orderNumber), ['1002']);
  assert.deepEqual(selectOverdueKundeordre(orders, '1', now, 'fakturagrunnlag').map((o) => o.orderNumber), ['1001']);
});

test('selectOverdueKundeordre drops orders dated before the fra date', () => {
  assert.deepEqual(selectOverdueKundeordre(orders, '1', now, null, '2026-01-11').map((o) => o.orderNumber), ['1002']);
  assert.deepEqual(selectOverdueKundeordre(orders, '1', now, null, '2026-01-10').map((o) => o.orderNumber), ['1001', '1002']);
  assert.deepEqual(selectOverdueKundeordre(orders, '1', now, null, null).map((o) => o.orderNumber), ['1001', '1002']);
});

test('parseFraDate accepts only YYYY-MM-DD dates', () => {
  assert.equal(parseFraDate('2026-03-04'), '2026-03-04');
  assert.equal(parseFraDate('04.03.2026'), null);
  assert.equal(parseFraDate('2026-13-45'), null);
  assert.equal(parseFraDate(null), null);
});

test('the timeline starts at the earliest order and ends at today minus the avviksgrense minus one day', () => {
  const withThreads = orders.map((o) => ({ ...o, id: `k${o.orderNumber}`, comments: [] }));
  const html = renderKundeordrePage(withThreads, null, '60', { now, fra: '2026-02-01' });
  assert.match(html, /id="date-filter" data-min="2026-01-10" data-today="2026-10-12"/);
  assert.match(html, /id="fra-date"[^>]*value="2026-02-01"/);
  assert.match(html, /id="til-date"[^>]*value="2026-08-12"/); // 2026-10-12 minus 61 days
  assert.match(html, /fra 01\.02\.2026/);
  assert.match(renderKundeordrePage(withThreads, null, '0', { now }), /id="til-date"[^>]*value="2026-10-11"/);
});

test('selectOverdueKundeordre keeps only orders older than the limit', () => {
  assert.deepEqual(selectOverdueKundeordre(orders, '60', now).map((o) => o.orderNumber), ['1001']);
  assert.deepEqual(selectOverdueKundeordre(orders, '1', now).map((o) => o.orderNumber), ['1001', '1002']);
  assert.deepEqual(selectOverdueKundeordre(orders, 'abc', now).map((o) => o.orderNumber), ['1001']); // default 60
});

test('filterKundeordre matches case-insensitively on contains, across columns', () => {
  assert.deepEqual(filterKundeordre(orders, { purchaser: 'KARI' }).map((o) => o.orderNumber), ['1001']);
  assert.deepEqual(filterKundeordre(orders, { date: '.10.2026' }).map((o) => o.orderNumber), ['1002']);
  assert.deepEqual(filterKundeordre(orders, { order: '100', department: 'sup' }).map((o) => o.orderNumber), ['1002']);
  assert.deepEqual(filterKundeordre(orders, { status: 'behandling' }).map((o) => o.orderNumber), ['1002', '1003']);
  assert.deepEqual(filterKundeordre(orders, { status: 'faktura' }).map((o) => o.orderNumber), ['1001']);
  // blank innkjøper/avdeling is found with "-" (or "—", as shown in the table)
  assert.deepEqual(filterKundeordre(orders, { purchaser: '-' }).map((o) => o.orderNumber), ['1003']);
  assert.deepEqual(filterKundeordre(orders, { purchaser: '—', department: '-' }).map((o) => o.orderNumber), ['1003']);
  assert.equal(filterKundeordre(orders, {}).length, 3);
});

test('sumKundeordreAmounts adds the order amounts and treats a missing amount as 0', () => {
  assert.equal(sumKundeordreAmounts(orders), 1250.5);
  assert.equal(sumKundeordreAmounts([]), 0);
});

test('kundeordreXlsxRows drops non-http(s) OMS links', () => {
  const rows = kundeordreXlsxRows(selectOverdueKundeordre(orders, '1', now));
  assert.deepEqual(rows[0], [1001, { date: '2026-01-10' }, 275, 'Lagt til fakturagrunnlag', 'Kari Nordmann', 'Sales', { amount: 1000.5 }, '', 'https://oms.example/1001']);
  assert.equal(rows[1][3], 'Trenger behandling');
  assert.deepEqual(rows[1][6], { amount: 250 });
  assert.equal(rows[1][7], ''); // Sum levert: no data yet
  assert.equal(rows[1][8], ''); // OMS-link was not http(s)
});
