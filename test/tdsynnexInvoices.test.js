'use strict';

// TD Synnex invoice index: fake fetch and made-up values only, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const td = require('../src/tdsynnexInvoices');
const { renderAvvikDetailPage, renderOpenAvvikPage, renderFinancePage } = require('../src/dashboard');
const { SEED_AVVIK } = require('../src/mockData');
const { summarizeOrderLines } = require('../src/avvikSync');

const ENV_KEYS = ['TD_SYNNEX_CLIENT_ID', 'TECH_DATA', 'TD_SYNNEX_TOKEN_URL'];

async function withConfig(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  td._reset();
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    td._reset();
  }
}

const CONFIG = { TD_SYNNEX_CLIENT_ID: 'fake-id', TECH_DATA: 'fake-secret', TD_SYNNEX_TOKEN_URL: 'https://api.tdsynnex.com/eu/auth/token' };
const doc = (invoiceNumber, orderText, extra = {}) => ({ invoiceNumber, documentType: 'Invoice', billingDate: '2026-03-04T00:00:00', customerOrderNumbers: [orderText], netValue: 999, customer: { name: 'ACME' }, ...extra });
const page = (docs, pageNo, totalPages) => ({ totalResults: 3, totalPages, pageSize: 100, page: pageNo, data: docs });
const response = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] } });
const noSleep = async () => {};

test('reads every page, finds POs inside the free text, and keeps only invoice number, type and date', () =>
  withConfig(CONFIG, async () => {
    const urls = [];
    const pages = [page([doc('8278009015', '145480BZF')], 1, 2), page([doc('8281805845', 'Söderberg Stavanger PO 148621-DMG'), doc('8284689594', '148621', { documentType: 'CreditMemo' })], 2, 2)];
    const r = await td.refreshTdSynnexInvoices({
      getToken: async () => 'fake-token',
      sleep: noSleep,
      fetchImpl: async (url, init) => { urls.push(String(url)); assert.equal(init.headers.Authorization, 'Bearer fake-token'); return response(200, pages[urls.length - 1]); },
    });
    assert.equal(r.ok, true);
    assert.equal(r.documents, 3);
    assert.deepEqual(urls, [
      'https://api.tdsynnex.com/eu/resellers/v1/invoices?CreatedFrom=2026-01-01&PageSize=100&Page=1',
      'https://api.tdsynnex.com/eu/resellers/v1/invoices?CreatedFrom=2026-01-01&PageSize=100&Page=2',
    ]);
    assert.deepEqual(td.getInvoicesForPo('145480'), [{ invoiceNumber: '8278009015', documentType: 'Invoice', billingDate: '2026-03-04' }]);
    assert.deepEqual(td.getInvoicesForPo('148621').map((x) => [x.invoiceNumber, x.documentType]), [['8281805845', 'Invoice'], ['8284689594', 'CreditMemo']]);
    assert.ok(!JSON.stringify(td.getInvoicesForPo('145480')).includes('ACME'), 'no customer data kept');
    assert.deepEqual(td.getInvoicesForPo('999999'), []);
  }));

test('a refresh within 30 minutes is skipped; a later one only reads documents created since the last success (minus a margin) and merges', () =>
  withConfig(CONFIG, async () => {
    let clock = Date.parse('2026-10-14T10:00:00Z');
    const now = () => new Date(clock);
    const urls = [];
    const fetchImpl = (docs) => async (url) => { urls.push(String(url)); return response(200, page(docs, 1, 1)); };
    await td.refreshTdSynnexInvoices({ getToken: async () => 't', sleep: noSleep, now, fetchImpl: fetchImpl([doc('A1', '145480')]) });
    assert.deepEqual(await td.refreshTdSynnexInvoices({ getToken: async () => 't', sleep: noSleep, now, fetchImpl: fetchImpl([]) }), { skipped: 'recent' });
    clock += 31 * 60 * 1000;
    await td.refreshTdSynnexInvoices({ getToken: async () => 't', sleep: noSleep, now, fetchImpl: fetchImpl([doc('A1', '145480'), doc('B2', '145480 igjen')]) });
    assert.match(urls[1], /CreatedFrom=2026-10-12&/); // 2 days before the first success
    assert.deepEqual(td.getInvoicesForPo('145480').map((x) => x.invoiceNumber), ['A1', 'B2']); // no duplicate of A1
  }));

test('429 waits and retries; a failure keeps the previous list, never throws and reports only the HTTP status', () =>
  withConfig(CONFIG, async () => {
    const sleeps = [];
    let calls = 0;
    const ok = await td.refreshTdSynnexInvoices({
      getToken: async () => 't',
      sleep: async (ms) => sleeps.push(ms),
      fetchImpl: async () => (++calls === 1 ? response(429, {}, { 'retry-after': '2' }) : response(200, page([doc('A1', '145480')], 1, 1))),
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(sleeps, [2000]);

    const failed = await td.refreshTdSynnexInvoices({
      getToken: async () => 'fake-token',
      force: true,
      sleep: noSleep,
      fetchImpl: async () => response(500, { error: 'LEAKY-BODY', echo: 'fake-token' }),
    });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /HTTP 500/);
    assert.ok(!failed.error.includes('LEAKY-BODY') && !failed.error.includes('fake-token'));
    assert.equal(td.getInvoicesForPo('145480').length, 1); // previous list kept
  }));

test('a login failure is reported without throwing and without the credentials', () =>
  withConfig(CONFIG, async () => {
    const r = await td.refreshTdSynnexInvoices({ getToken: async () => { throw new Error('TD Synnex innlogging feilet: HTTP 401.'); }, sleep: noSleep });
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes('fake-secret'));
  }));

test('a cut-off read (page limit) does not count as a success, so the next one starts from the same date', () =>
  withConfig(CONFIG, async () => {
    const urls = [];
    const fetchImpl = async (url) => { urls.push(String(url)); return response(200, page([doc('A1', '145480')], urls.length, 5)); };
    const r = await td.refreshTdSynnexInvoices({ getToken: async () => 't', sleep: noSleep, maxPages: 2, fetchImpl });
    assert.equal(r.truncated, true);
    await td.refreshTdSynnexInvoices({ getToken: async () => 't', sleep: noSleep, maxPages: 2, force: true, fetchImpl });
    assert.match(urls[2], /CreatedFrom=2026-01-01&/);
  }));

test('nothing happens when TD Synnex is not configured', () =>
  withConfig({}, async () => {
    let called = false;
    const r = await td.refreshTdSynnexInvoices({ getToken: async () => { called = true; }, fetchImpl: async () => { called = true; } });
    assert.deepEqual(r, { skipped: 'not-configured' });
    assert.equal(called, false);
  }));

test('the invoice API host follows the token URL (test host stays on the test host)', () =>
  withConfig({ ...CONFIG, TD_SYNNEX_TOKEN_URL: 'https://test.api.tdsynnex.com/eu/auth/token' }, async () => {
    let url;
    await td.refreshTdSynnexInvoices({ getToken: async () => 't', sleep: noSleep, fetchImpl: async (u) => { url = String(u); return response(200, page([], 1, 1)); } });
    assert.match(url, /^https:\/\/test\.api\.tdsynnex\.com\/eu\/resellers\/v1\/invoices\?/);
  }));

test('only Tech Data / TD Synnex suppliers are recognised', () => {
  assert.equal(td.isTdSynnexSupplier('Tech Data Norge AS'), true);
  assert.equal(td.isTdSynnexSupplier('TD Synnex'), true);
  assert.equal(td.isTdSynnexSupplier('Arrow ECS'), false);
  assert.equal(td.isTdSynnexSupplier(null), false);
});

// --- article level: the invoice LINES are read for the POs of the open avvik ---

const detailDoc = (invoiceNumber, orderText, items, extra = {}) => ({ ...doc(invoiceNumber, orderText), items, documentCurrency: 'NOK', ...extra });
const item = (manuf, quantity, unitNetPrice) => ({ manufPartNumber: manuf, tdsynnexPartNumber: '9999', upcEan: '123', quantity, unitNetPrice, totalLineNetPrice: 12345.67, taxAmount: 1 });

// One refresh with a fake TD Synnex: the list pages hold the documents (no lines); a lookup
// by InvoiceNumber returns that document with its items.
async function loadTd(documents, relevant = null) {
  const byNumber = Object.fromEntries(documents.map((d) => [d.invoiceNumber, d]));
  const listDocs = documents.map(({ items, ...rest }) => rest);
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('InvoiceNumber=')) {
      const n = decodeURIComponent(/InvoiceNumber=([^&]+)/.exec(u)[1]);
      return response(200, { data: byNumber[n] ? [byNumber[n]] : [] });
    }
    return response(200, page(listDocs, 1, 1));
  };
  const pos = relevant || [...new Set(documents.flatMap((d) => d.customerOrderNumbers.flatMap((t) => String(t).match(/\d{6}/g) || [])))];
  return td.refreshTdSynnexInvoices({ getToken: async () => 't', sleep: noSleep, fetchImpl, force: true, getRelevantPos: () => pos });
}

test('invoice lines are read for the POs of the open avvik, and only part numbers, quantity and unit price are kept', () =>
  withConfig(CONFIG, async () => {
    const r = await loadTd([detailDoc('8278009015', '145480BZF', [item('952-000002', 2, 656.14)])]);
    assert.equal(r.details, 1);
    const found = td.getInvoicesForAvvik({ poNumber: '145480', articleNumber: '952-000002' });
    assert.equal(found.length, 1);
    assert.equal(found[0].invoiceNumber, '8278009015');
    assert.equal(found[0].currency, 'NOK');
    assert.deepEqual(found[0].lines, [{ quantity: 2, unitNetPrice: 656.14, matchKind: 'eksakt' }]);
    assert.ok(!JSON.stringify(found).includes('12345.67') && !JSON.stringify(found).includes('ACME'), 'no line amount or customer data kept');
  }));

test('an invoice belongs to an avvik only when one of its lines has the article (exact or dash suffix)', () =>
  withConfig(CONFIG, async () => {
    await loadTd([
      detailDoc('INV-A', 'PO 148789', [item('CW9164I-E-RF', 7, 6100.61)]),
      detailDoc('INV-B', 'PO 148789', [item('SOMETHING-ELSE', 1, 10)]),
      detailDoc('INV-C', 'PO 148789', [item('cw9164i e', 1, 6100.61)]),
    ]);
    const forArticle = (article) => td.getInvoicesForAvvik({ poNumber: '148789', articleNumber: article }).map((i) => [i.invoiceNumber, i.lines[0].matchKind]);
    assert.deepEqual(forArticle('CW9164I-E'), [['INV-A', 'suffiks'], ['INV-C', 'eksakt']]);
    assert.deepEqual(forArticle('ZZZ-999'), []);
    assert.deepEqual(td.getInvoicesForAvvik({ poNumber: '148789', articleNumber: '' }), []);
    assert.deepEqual(td.getInvoicesForAvvik({ poNumber: '', articleNumber: 'CW9164I-E' }), []);
  }));

test('invoices whose lines have not been read yet are left out instead of guessed', () =>
  withConfig(CONFIG, async () => {
    await loadTd([detailDoc('INV-A', '148789', [item('CW9164I-E', 1, 100)])], []); // no relevant POs: no lines read
    assert.equal(td.getInvoicesForPo('148789').length, 1);
    assert.deepEqual(td.getInvoicesForAvvik({ poNumber: '148789', articleNumber: 'CW9164I-E' }), []);
  }));

test('reading invoice lines is capped per refresh, stops at the first failure and keeps what it read', () =>
  withConfig(CONFIG, async () => {
    const docs = [1, 2, 3, 4].map((n) => detailDoc(`INV-${n}`, '148789', [item('CW9164I-E', 1, 100)]));
    const urls = [];
    const fetchImpl = async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('InvoiceNumber=')) {
        if (u.includes('INV-3')) return response(500, {});
        const n = decodeURIComponent(/InvoiceNumber=([^&]+)/.exec(u)[1]);
        return response(200, { data: [docs.find((d) => d.invoiceNumber === n)] });
      }
      return response(200, page(docs.map(({ items, ...rest }) => rest), 1, 1));
    };
    const r = await td.refreshTdSynnexInvoices({ getToken: async () => 't', sleep: noSleep, fetchImpl, getRelevantPos: () => ['148789'] });
    assert.equal(r.ok, true); // the list itself was read fine
    assert.equal(r.details, 2); // INV-1 and INV-2, then INV-3 failed and it stopped
    assert.equal(urls.filter((u) => u.includes('InvoiceNumber=')).length, 3);
    assert.deepEqual(td.getInvoicesForAvvik({ poNumber: '148789', articleNumber: 'CW9164I-E' }).map((i) => i.invoiceNumber), ['INV-1', 'INV-2']);
    // already-read invoices are not read again
    urls.length = 0;
    await td.refreshTdSynnexInvoices({ getToken: async () => 't', sleep: noSleep, fetchImpl, force: true, getRelevantPos: () => ['148789'] });
    assert.ok(!urls.some((u) => u.includes('InvoiceNumber=INV-1') || u.includes('InvoiceNumber=INV-2')));
  }));

test('invoiceChecks: unit price compared to the øre, quantity against what is still open, credit notes and other currencies left alone', () => {
  const inv = (documentType, currency, line) => ({ documentType, currency, lines: [line] });
  const order = { orderUnitPrice: 5627.04, orderOpenQuantity: 2 };
  assert.deepEqual(td.invoiceChecks(order, inv('Invoice', 'NOK', { quantity: 9, unitNetPrice: 6781.33 })), { priceDiffPercent: 20.5, coversOpenQuantity: false });
  assert.deepEqual(td.invoiceChecks(order, inv('Invoice', 'NOK', { quantity: 2, unitNetPrice: 5627.04 })), { priceDiffPercent: null, coversOpenQuantity: true });
  assert.equal(td.invoiceChecks(order, inv('Invoice', 'NOK', { quantity: 2, unitNetPrice: 5627.045 })).priceDiffPercent, null); // within 0.01
  assert.deepEqual(td.invoiceChecks(order, inv('CreditMemo', 'NOK', { quantity: 2, unitNetPrice: 1 })), { priceDiffPercent: null, coversOpenQuantity: false });
  assert.equal(td.invoiceChecks(order, inv('Invoice', 'EUR', { quantity: 1, unitNetPrice: 500 })).priceDiffPercent, null);
  assert.equal(td.invoiceChecks({ orderUnitPrice: null, orderOpenQuantity: null }, inv('Invoice', 'NOK', { quantity: 2, unitNetPrice: 5 })).priceDiffPercent, null);
  assert.equal(td.invoiceChecks({ orderUnitPrice: 5, orderOpenQuantity: 0 }, inv('Invoice', 'NOK', { quantity: 0, unitNetPrice: 5 })).coversOpenQuantity, false);
});

test('summarizeOrderLines sums every order line of an order + article', () => {
  const lines = [
    { quantity: 1, received_not_connected_quantity: 0, amount: 352.63, unit_price: 352.63 },
    { quantity: 2, received_not_connected_quantity: 2, amount: 705.26, unit_price: 352.63 },
  ];
  assert.deepEqual(summarizeOrderLines(lines), { quantity: 3, openQuantity: 2, amount: 1057.89, unitPrice: 352.63 });
  assert.equal(summarizeOrderLines([]), null);
  assert.deepEqual(summarizeOrderLines([{ quantity: '4', received_not_connected_quantity: null, amount: null, unit_price: null }]), { quantity: 4, openQuantity: 0, amount: 0, unitPrice: null });
});

test('relevantPos lists the POs of the open Tech Data avvik only', () => {
  const list = [
    { supplierName: 'Tech Data Norge AS', poNumber: '145480' },
    { supplierName: 'Tech Data Norge AS', poNumber: '145480' },
    { supplierName: 'Tech Data Norge AS', poNumber: '146347', resolved: true },
    { supplierName: 'Arrow ECS', poNumber: '147000' },
    { supplierName: 'TD Synnex', poNumber: null },
  ];
  assert.deepEqual(td.relevantPos(list), ['145480']);
});

test('tdInvoiceBadges: open Tech Data avvik where TD Synnex has an invoice FOR THIS ARTICLE; attention when one is not linked in Medius', () =>
  withConfig(CONFIG, async () => {
    await loadTd([
      detailDoc('A1', '145480', [item('ART-1', 2, 10)]), // for ART-1, in Medius
      detailDoc('B2', '146347', [item('ART-2', 1, 10)]), // for ART-2
      detailDoc('C3', '146347', [item('ART-2', 1, 10)]), // for ART-2, not in Medius
      detailDoc('D4', '146347', [item('OTHER-9', 1, 10)]), // another article on the same PO: not for these avvik
      detailDoc('E5', '150000', [item('ART-5', 1, 10)]), // not in Medius
    ]);
    const tdAvvik = (id, po, article, extra = {}) => ({ id, supplierName: 'Tech Data Norge AS', poNumber: po, articleNumber: article, ...extra });
    const avvik = [
      tdAvvik('x1', '145480', 'ART-1', { invoiceNumber: 'A1', invoices: [{ invoiceNumber: 'A1' }] }), // all in Medius
      tdAvvik('x2', '146347', 'ART-2', { invoiceNumber: 'B2', invoices: [{ invoiceNumber: 'B2' }] }), // C3 missing (D4 is another article)
      { ...tdAvvik('x3', '146347', 'ART-2'), supplierName: 'Arrow ECS' }, // other supplier
      tdAvvik('x4', '150000', 'ART-5'), // none in Medius
      tdAvvik('x5', '999999', 'ART-9'), // nothing at TD
      tdAvvik('x6', '146347', 'ART-2', { resolved: true }),
      tdAvvik('x7', '146347', 'NOT-ON-INVOICE'), // PO has invoices, but none for this article
    ];
    const badges = td.tdInvoiceBadges(avvik);
    assert.deepEqual([...badges.keys()].sort(), ['x1', 'x2', 'x4']);
    assert.deepEqual(badges.get('x1').numbers, ['A1']);
    assert.equal(badges.get('x1').attention, false); // everything is linked in Medius
    assert.deepEqual(badges.get('x2').numbers.sort(), ['B2', 'C3']);
    assert.equal(badges.get('x2').attention, true);
    assert.match(badges.get('x2').tooltip, /C3 \(ikke koblet til ordrelinjen\)/);
    assert.deepEqual(badges.get('x4').numbers, ['E5']);
    assert.equal(badges.get('x4').attention, true);
  }));

const base = () => ({ ...SEED_AVVIK[0], comments: [] });

const tdInv = (invoiceNumber, documentType, line, checks = {}) => ({ invoiceNumber, documentType, billingDate: '2026-03-04', currency: 'NOK', lines: [{ matchKind: 'eksakt', ...line }], checks });

const head = (kind, status, extra = {}) => ({ kind, status, label: `${{ Archived: 'arkivert', Open: 'åpen', Invalidated: 'makulert' }[status] || status} ${kind}`, link: `https://medius.example/${kind}`, po: null, mustReverse: false, ...extra });

test('the detail page shows both invoice cards: TD numbers with quantity, unit price and marks, and what Medius says about each', () => {
  const avvik = { ...base(), poNumber: '152014', invoiceNumber: 'A1', invoices: [{ invoiceNumber: 'A1', mediusLink: null, isCreditNote: false }] };
  const html = renderAvvikDetailPage(avvik, {
    tdInvoices: [
      tdInv('A1', 'Invoice', { quantity: 68, unitNetPrice: 706.04 }), // linked to the avvik in Medius
      tdInv('B2', 'Invoice', { quantity: 2, unitNetPrice: 706.04 }, { priceDiffPercent: null, coversOpenQuantity: true }), // in Medius, not linked
      tdInv('C3', 'CreditMemo', { quantity: 9, unitNetPrice: 2022.74 }), // not in Medius at all
      tdInv('D4', 'Invoice', { quantity: 9, unitNetPrice: 6781.33 }, { priceDiffPercent: 20.5, coversOpenQuantity: false }),
    ],
    tdHeads: { A1: head('varefaktura', 'Archived', { po: '152014' }), B2: head('varefaktura', 'Archived', { po: '152014' }), C3: null, D4: head('kostnadsfaktura', 'Open', { po: '999999' }) },
  });
  // Supplier card
  assert.match(html, /Fakturanummer - Leverandør/);
  assert.match(html, /<div>A1 <span class="td-detail">· 68 stk à 706,04<\/span><\/div>/); // linked, found in Medius: no marks
  assert.match(html, /<div>B2 <span class="td-detail">· 2 stk à 706,04<\/span> <span class="td-pill td-missing">Ikke koblet til ordrelinjen<\/span> <span class="td-pill td-open">Dekker åpent antall<\/span><\/div>/);
  assert.match(html, /<div>C3 \(kreditnota\) <span class="td-detail">· 9 stk à 2[\s ]022,74<\/span> <span class="td-pill td-missing">Ikke i Medius<\/span><\/div>/);
  assert.match(html, /<span class="td-pill td-price">Pris avviker \(\+20,5 %\)<\/span>/);
  assert.doesNotMatch(html, /Må reverseres/); // no archived cost invoice here
  // Medius card
  const medius = html.slice(html.indexOf('Fakturanummer - Medius'), html.indexOf('Fakturanummer - Leverandør'));
  assert.match(medius, />A1<\/a> <span class="td-detail">· finnes i Medius: arkivert varefaktura<\/span>/);
  assert.match(medius, />B2<\/a> <span class="td-detail">· finnes i Medius: arkivert varefaktura<\/span>/);
  assert.match(medius, /<div>C3 \(kreditnota\) <span class="td-detail">· finnes ikke i Medius<\/span><\/div>/);
  assert.match(medius, />D4<\/a> <span class="td-detail">· finnes i Medius: åpen kostnadsfaktura · PO i Medius: 999999<\/span>/); // on another PO
  assert.doesNotMatch(renderAvvikDetailPage(avvik), /Fakturanummer - Leverandør/);
});

test('an archived cost invoice in Medius is marked "Må reverseres" (only that), also when it is not linked to the avvik', () => {
  const avvik = { ...base(), poNumber: '148789', invoiceNumber: null, invoices: [] };
  const tdInvoices = [tdInv('A1', 'Invoice', { quantity: 7, unitNetPrice: 6100.61 }), tdInv('B2', 'Invoice', { quantity: 1, unitNetPrice: 6100.61 }), tdInv('C3', 'Invoice', { quantity: 4, unitNetPrice: 6100.61 })];
  const html = renderAvvikDetailPage(avvik, {
    tdInvoices,
    tdHeads: {
      A1: head('kostnadsfaktura', 'Archived', { po: '148789', mustReverse: true }),
      B2: head('varefaktura', 'Archived', { po: '148789' }),
      C3: null,
    },
  });
  assert.match(html, /<div>A1 <span class="td-detail">[^<]*<\/span> <span class="td-pill td-reverse">Må reverseres<\/span> <span class="td-pill td-missing">Ikke koblet til ordrelinjen<\/span><\/div>/);
  assert.doesNotMatch(html, /<div>B2[^]*?Må reverseres[^]*?<\/div>\s*<div>C3/);
  assert.equal((html.match(/Må reverseres/g) || []).length, 1);
  const medius = html.slice(html.indexOf('Fakturanummer - Medius'), html.indexOf('Fakturanummer - Leverandør'));
  assert.match(medius, /A1<\/a> <span class="td-detail">· finnes i Medius: arkivert kostnadsfaktura<\/span>/);
});

test('before Medius has been looked up, the cards claim nothing about Medius', () => {
  const avvik = { ...base(), poNumber: '148789', invoiceNumber: null, invoices: [] };
  const html = renderAvvikDetailPage(avvik, { tdInvoices: [tdInv('A1', 'Invoice', { quantity: 1, unitNetPrice: 5 })], tdHeads: null });
  assert.match(html, /Medius sjekkes \.\.\./);
  assert.doesNotMatch(html, /Ikke i Medius|finnes ikke i Medius|Må reverseres|Ikke koblet/);
});

test('when only TD Synnex has the invoice, the Medius card says so with the number, not an empty card', () => {
  const noMedius = { ...base(), invoiceNumber: null, invoices: [] };
  const html = renderAvvikDetailPage(noMedius, { tdInvoices: [tdInv('B2', 'Invoice', { quantity: 1, unitNetPrice: 5 })], tdHeads: { B2: null } });
  assert.match(html, /Fakturanummer - Medius[\s\S]*<div>B2 <span class="td-detail">· finnes ikke i Medius<\/span><\/div>[\s\S]*Fakturanummer - Leverandør/);
  assert.doesNotMatch(renderAvvikDetailPage(noMedius), /finnes ikke i Medius/);
});

test('Medius heads: the best head per invoice number wins, labels say status and kind, and nothing is claimed before the first lookup', () =>
  withConfig(CONFIG, async () => {
    assert.equal(td.getMediusHeadsFor({ invoiceNumber: 'A1' }, []), null); // not looked up yet
    td.setMediusHeads([
      { invoice_number: ' 8278 ', invoice_type: 'Non-PO invoice', processing_status: 'Invalidated', medius_link: 'l1', visma_purchase_order: '1', created_at: '2026-01-01' },
      { invoice_number: '8278', invoice_type: 'Non-PO invoice', processing_status: 'Archived', medius_link: 'l2', visma_purchase_order: ' 148789 ', created_at: '2026-01-02' },
      { invoice_number: '8279', invoice_type: null, processing_status: 'Open', medius_link: 'l3', visma_purchase_order: null, created_at: '2026-01-03' },
      { invoice_number: '8280', invoice_type: 'PO invoice', processing_status: 'Invalidated', medius_link: 'l4', visma_purchase_order: '5', created_at: '2026-01-03' },
      { invoice_number: '8280', invoice_type: 'PO invoice', processing_status: 'Invalidated', medius_link: 'l5', visma_purchase_order: '6', created_at: '2026-02-03' },
    ]);
    const a = td.getMediusHead('8278');
    assert.deepEqual([a.label, a.link, a.po, a.mustReverse], ['arkivert kostnadsfaktura', 'l2', '148789', true]);
    const b = td.getMediusHead('8279');
    assert.deepEqual([b.label, b.po, b.mustReverse], ['åpen varefaktura', null, false]);
    assert.deepEqual([td.getMediusHead('8280').label, td.getMediusHead('8280').link], ['makulert varefaktura', 'l5']); // the newest of equals
    assert.equal(td.getMediusHead('0000'), null);
    const heads = td.getMediusHeadsFor({ invoiceNumber: '8279' }, [{ invoiceNumber: '8278' }, { invoiceNumber: '0000' }]);
    assert.deepEqual(Object.keys(heads).sort(), ['0000', '8278', '8279']);
    assert.equal(heads['0000'], null);
  }));

test('invoiceNumbersToLookUp: TD numbers for the open Tech Data avvik plus what Medius has linked to them', () =>
  withConfig(CONFIG, async () => {
    await loadTd([detailDoc('T1', '148789', [item('ART-1', 1, 10)]), detailDoc('T2', '148789', [item('OTHER', 1, 10)])]);
    const avvik = [
      { id: 'a', supplierName: 'Tech Data Norge AS', poNumber: '148789', articleNumber: 'ART-1', invoiceNumber: 'M1', invoices: [{ invoiceNumber: 'M2' }] },
      { id: 'b', supplierName: 'Arrow ECS', poNumber: '148789', articleNumber: 'ART-1', invoiceNumber: 'X9' },
      { id: 'c', supplierName: 'Tech Data Norge AS', poNumber: '148789', articleNumber: 'ART-1', resolved: true, invoiceNumber: 'X8' },
    ];
    assert.deepEqual(td.invoiceNumbersToLookUp(avvik).sort(), ['M1', 'M2', 'T1', 'T2']); // all TD invoices on the PO; X* not Tech Data / resolved
  }));

test('the open list and the Finance list mark the avvik that have a TD Synnex invoice', () => {
  const avvik = [{ ...base(), id: 'k1', resolved: false }];
  const one = new Map([['k1', { numbers: ['8284017176'], attention: true, tooltip: '8284017176 (ikke i Medius)' }]]);
  const two = new Map([['k1', { numbers: ['A1', 'B2'], attention: false, tooltip: 'A1; B2' }]]);
  assert.match(renderOpenAvvikPage(avvik, [], null, one), /td-attn[^>]*>TD-faktura 8284017176/);
  assert.match(renderOpenAvvikPage(avvik, [], null, two), /td-ok[^>]*>TD-faktura \(2\)/);
  assert.doesNotMatch(renderOpenAvvikPage(avvik, [], null, new Map()), /TD-faktura/);
  assert.doesNotMatch(renderOpenAvvikPage(avvik, [], null), /TD-faktura/);
  const fin = [{ ...base(), id: 'k1', resolved: false, discrepancyType: 'Spesielle caser - Finance' }];
  assert.match(renderFinancePage(fin, [], one), /TD-faktura 8284017176/);
  assert.doesNotMatch(renderFinancePage(fin, []), /TD-faktura/);
});

const sectionText = (html) => {
  const i = html.indexOf('invoice-section');
  const j = html.indexOf('</section>', i);
  return i < 0 ? '' : html.slice(i, j).replace(/<[^>]+>/g, ' ').replace(/&middot;|·/g, '·').replace(/\s+/g, ' ');
};

test('getInvoiceOverview: all TD invoices on the PO with their lines, Medius status and Medius lines', () =>
  withConfig(CONFIG, async () => {
    await loadTd([detailDoc('T1', '148789', [item('ART-1', 2, 10), item('OTHER', 1, 5)]), detailDoc('T2', '148789', [item('OTHER', 3, 7)])]);
    td.setMediusHeads([{ invoice_number: 'T2', invoice_type: 'Invoice', processing_status: 'Archived', medius_link: 'https://m/T2', visma_purchase_order: '148789' }]);
    td.setMediusLines([{ invoice_number: 'T2', line_number: 1, article_code: 'OTHER', article_name: 'x', quantity: 3, unit_price: 7 }]);
    const dwhLine = { invoice_number: 'T2', line_number: 1, article_code: 'OTHER', article_name: 'x', quantity: 3, unit_price: 7 };
    td.setMediusLines([dwhLine, { ...dwhLine }]); // the same line twice in dwh: kept once
    const o = td.getInvoiceOverview({ poNumber: '148789', articleNumber: 'ART-1', invoiceNumber: 'M9', invoices: [{ invoiceNumber: 'M9' }] });
    assert.equal(o.tdInvoices[1].mediusLines.length, 1);
    assert.deepEqual(o.tdInvoices.map((i) => [i.invoiceNumber, i.hasArticle]), [['T1', true], ['T2', false]]);
    assert.equal(o.tdInvoices[1].medius.label, 'arkivert varefaktura');
    assert.equal(o.tdInvoices[1].mediusLines[0].articleCode, 'OTHER');
    assert.equal(o.tdInvoices[0].medius, null); // T1 is not in Medius
    assert.deepEqual(o.mediusOnly.map((i) => i.invoiceNumber), ['M9']); // linked to the avvik in Medius, not listed by TD
    assert.equal(o.mediusLoaded, true);
  }));

test('the Faktura section: verdict and bullets for the four situations', () => {
  const avvik = { ...base(), poNumber: '150344', articleNumber: 'ART-1', invoiceNumber: null, invoices: [] };
  const render = (overview) => sectionText(renderAvvikDetailPage(avvik, { invoiceOverview: overview }));
  const noInv = { tdLoaded: true, mediusLoaded: true, linked: [], tdInvoices: [], mediusOnly: [] };
  assert.match(render(noInv), /Faktura Vi har ikke mottatt faktura fra leverandøren på denne varelinjen \(artikkel ART-1 ?\)\. TD Synnex har heller ingen fakturaer på PO 150344/);

  const other = { ...noInv, tdInvoices: [{ invoiceNumber: 'T1', documentType: 'Invoice', billingDate: '2026-09-01', currency: 'NOK', hasArticle: false, items: [{ part: 'OTHER-9', quantity: 1, unitNetPrice: 100, hasArticle: false }], medius: { label: 'arkivert varefaktura', link: null, po: '150344' }, mediusLines: [{ articleCode: 'OTHER-9', quantity: 1, unitPrice: 100 }] }] };
  const t = render(other);
  assert.match(t, /Vi har ikke mottatt faktura fra leverandøren på denne varelinjen \(artikkel ART-1 ?\)\. TD Synnex har én annen faktura på samme PO, men den inneholder ikke denne artikkelen\./);
  assert.match(t, /T1 fra TD Synnex på samme PO, 2026-09-01/);
  assert.match(t, /Artikler hos TD Synnex: OTHER-9 · 1 stk à 100/);
  assert.match(t, /Status i Medius: arkivert varefaktura/);
  assert.match(t, /Artikler i Medius: OTHER-9 · 1 stk à 100/);

  const mine = { ...noInv, tdInvoices: [{ ...other.tdInvoices[0], hasArticle: true, items: [{ part: 'ART-1', quantity: 2, unitNetPrice: 50, hasArticle: true }], medius: null, mediusLines: null }] };
  assert.match(render(mine), /TD Synnex har fakturert artikkelen ART-1 \(T1\), men vi har ikke mottatt fakturaen i Medius/);
  assert.match(render(mine), /ART-1 · 2 stk à 50 \(denne varelinjen\)/);
  assert.match(render(mine), /Status i Medius: finnes ikke i Medius/);

  const inMedius = { ...mine, tdInvoices: [{ ...mine.tdInvoices[0], medius: { label: 'åpen varefaktura', link: null, po: '150344' } }] };
  assert.match(render(inMedius), /og fakturaen finnes i Medius, men den er ikke koblet til denne varelinjen/);

  const linked = { ...noInv, linked: ['M1'], mediusOnly: [{ invoiceNumber: 'M1', medius: { label: 'arkivert varefaktura', link: null, po: '150344' }, mediusLines: null }] };
  assert.match(render(linked), /Faktura er koblet til denne varelinjen i Medius: M1/);
  assert.match(render(linked), /M1 i Medius, ikke funnet hos TD Synnex/);
});

test('the Faktura section: only for Tech Data avvik (needs an overview), and says so while data is missing', () => {
  const avvik = { ...base(), poNumber: '150344', articleNumber: 'ART-1', invoiceNumber: null, invoices: [] };
  assert.doesNotMatch(renderAvvikDetailPage(avvik, {}), /invoice-section/);
  const t = sectionText(renderAvvikDetailPage(avvik, { invoiceOverview: { tdLoaded: false, mediusLoaded: false, linked: [], tdInvoices: [], mediusOnly: [] } }));
  assert.match(t, /Fakturaene fra TD Synnex er ikke lest inn ennå/);
});

test('Kostnadsfaktura — reverser: the procedure says what Finance reverses and connects, the credit note and the rest quantity', () => {
  const avvik = { ...base(), discrepancyType: 'Kostnadsfaktura — reverser', poNumber: '148789', articleNumber: 'CW9164I-E', purchaserName: 'Kari Nordmann', totalQuantity: 17, resoldQuantity: 15, writtenOffQuantity: 1, invoiceNumber: 'C1', invoices: [{ invoiceNumber: 'C1' }] };
  const inv = (invoiceNumber, documentType, quantity, medius) => ({ invoiceNumber, documentType, billingDate: '2026-09-01', currency: 'NOK', hasArticle: true, items: [{ part: 'CW9164I-E-RF', quantity, unitNetPrice: 6100.61, hasArticle: true }], medius, mediusLines: null });
  const overview = {
    tdLoaded: true,
    mediusLoaded: true,
    linked: ['C1'],
    tdInvoices: [
      inv('C1', 'Invoice', 7, { label: 'arkivert kostnadsfaktura', mustReverse: true, po: '148789', link: null }),
      inv('V1', 'Invoice', 88, { label: 'arkivert varefaktura', mustReverse: false, po: '148789', link: null }),
      inv('K1', 'CreditMemo', 9, { label: 'arkivert varefaktura', mustReverse: false, po: '148789', link: null }),
    ],
    mediusOnly: [],
  };
  const html = renderAvvikDetailPage(avvik, { invoiceOverview: overview });
  const i = html.indexOf('procedure-section');
  const text = html.slice(i, html.indexOf('</section>', i)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /Anbefalt fremgangsmåte/);
  assert.match(text, /Finance reverserer kostnadsfakturaen i Medius: C1 \(7 stk à 6 100,61\)/);
  assert.match(text, /Kreditnota fra TD Synnex på samme PO og artikkel: K1 \(kreditnota\) \(9 stk à 6 100,61\)/);
  assert.match(text, /Finance kobler varefakturaen til ordrelinjen: V1 \(88 stk à 6 100,61\)/);
  assert.match(text, /Det gjenstår 1 av 17 stk som verken er videresolgt eller skrevet ut\. Send melding til sakseier \(Kari Nordmann\)/);
  assert.match(text, /og sakseier har gitt beskjed om restantallet/);

  // No rest quantity, no TD data: generic steps, no rest step.
  const plain = renderAvvikDetailPage({ ...avvik, resoldQuantity: 16 }, {});
  const j = plain.indexOf('procedure-section');
  const plainText = plain.slice(j, plain.indexOf('</section>', j)).replace(/<[^>]+>/g, ' ');
  assert.match(plainText, /Finance reverserer den arkiverte kostnadsfakturaen på denne PO-en i Medius/);
  assert.doesNotMatch(plainText, /gjenstår/);
});
