'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOrderLineKey,
  buildInvoiceLineCandidateKey,
  isManualOrder,
  extractVismaOrderFromReference,
  matchesVismaOrder,
  quantitiesMatch,
  amountsMatch,
  qualifiesForManualOrderSuggestion,
  isInvoiceTooOldForManualOrder,
  pickBestInvoiceLineForInvoice,
  pickArchivedInvoiceHead,
  buildInvoiceSuggestion,
  rankInvoiceSuggestions,
  buildInvoiceSuggestionsForAvvik,
} = require('../src/invoiceSuggestions');

test('buildOrderLineKey: trims/lowercases both parts so formatting differences still match', () => {
  assert.equal(buildOrderLineKey(' 305588 ', 'P9L11A'), buildOrderLineKey('305588', 'p9l11a'));
});

test('buildInvoiceLineCandidateKey: different suppliers for the same article never collide', () => {
  const keyA = buildInvoiceLineCandidateKey('P9L11A', '59891');
  const keyB = buildInvoiceLineCandidateKey('P9L11A', '60067');
  assert.notEqual(keyA, keyB);
});

test('isManualOrder: null, undefined, empty and whitespace-only reference_id are all manual', () => {
  assert.equal(isManualOrder(null), true);
  assert.equal(isManualOrder(undefined), true);
  assert.equal(isManualOrder(''), true);
  assert.equal(isManualOrder('   '), true);
});

test('isManualOrder: a real reference_id is not manual', () => {
  assert.equal(isManualOrder('145372-485100'), false);
});

test('extractVismaOrderFromReference: takes the segment before the first dash', () => {
  assert.equal(extractVismaOrderFromReference('145372-485100'), '145372');
});

test('extractVismaOrderFromReference: null/empty extracts nothing', () => {
  assert.equal(extractVismaOrderFromReference(null), null);
  assert.equal(extractVismaOrderFromReference(''), null);
});

test('matchesVismaOrder: equal values (any case/whitespace) match', () => {
  assert.equal(matchesVismaOrder(' 145718 ', '145718'), true);
});

test('matchesVismaOrder: different values do not match', () => {
  assert.equal(matchesVismaOrder('143279', '145372'), false);
});

test('matchesVismaOrder: either side missing can never match', () => {
  assert.equal(matchesVismaOrder(null, '145372'), false);
  assert.equal(matchesVismaOrder('143279', null), false);
});

test('quantitiesMatch: equal numbers match, missing values never do', () => {
  assert.equal(quantitiesMatch(1, 1), true);
  assert.equal(quantitiesMatch(1, 2), false);
  assert.equal(quantitiesMatch(null, 1), false);
});

test('amountsMatch: small rounding differences are tolerated at the default tolerance', () => {
  assert.equal(amountsMatch(571.01, 571.01), true);
  assert.equal(amountsMatch(571.01, 571.015), true);
  assert.equal(amountsMatch(571.01, 571.5), false);
});

test('qualifiesForManualOrderSuggestion: requires an exact article_code match regardless of everything else', () => {
  const orderLine = { article_code: 'CON-SNT-CSBARAT3', quantity: 1, amount: 2931.62 };
  const wrongArticle = { article_code: 'PAN-PA-1420-VSYS-5', quantity: 1, amount: 2931.62 };
  assert.equal(qualifiesForManualOrderSuggestion(orderLine, wrongArticle), false);
});

test('qualifiesForManualOrderSuggestion: requires quantity and amount (within kr 1) to agree once article matches', () => {
  const orderLine = { article_code: 'X1', quantity: 1, amount: 2931.62 };
  assert.equal(qualifiesForManualOrderSuggestion(orderLine, { article_code: 'X1', quantity: 1, amount: 2931.62 }), true);
  assert.equal(qualifiesForManualOrderSuggestion(orderLine, { article_code: 'X1', quantity: 1, amount: 2932.5 }), true); // within kr 1
  assert.equal(qualifiesForManualOrderSuggestion(orderLine, { article_code: 'X1', quantity: 1, amount: 2935 }), false); // beyond kr 1
  assert.equal(qualifiesForManualOrderSuggestion(orderLine, { article_code: 'X1', quantity: 2, amount: 2931.62 }), false);
});

test('isInvoiceTooOldForManualOrder: an invoice archived before the cutoff is too old', () => {
  assert.equal(isInvoiceTooOldForManualOrder('2024-11-04', '2026-01-01'), true);
});

test('isInvoiceTooOldForManualOrder: an invoice archived on/after the cutoff is not too old', () => {
  assert.equal(isInvoiceTooOldForManualOrder('2025-01-02', '2026-01-01'), false);
  assert.equal(isInvoiceTooOldForManualOrder('2026-01-01', '2026-01-01'), false);
});

test('isInvoiceTooOldForManualOrder: a missing date is not treated as too old', () => {
  assert.equal(isInvoiceTooOldForManualOrder(null, '2026-01-01'), false);
});

test('pickBestInvoiceLineForInvoice: prefers the line with more matching fields', () => {
  const orderLine = { quantity: 1, amount: 571.01 };
  const worse = { line_number: '1', quantity: 2, amount: 571.01, connection_status: 'Empty' };
  const better = { line_number: '2', quantity: 1, amount: 571.01, connection_status: 'Empty' };
  assert.deepEqual(pickBestInvoiceLineForInvoice(orderLine, [worse, better]), better);
  assert.deepEqual(pickBestInvoiceLineForInvoice(orderLine, [better, worse]), better);
});

test('pickBestInvoiceLineForInvoice: ties on match score prefer connection_status Empty (raw duplicate rows)', () => {
  const orderLine = { quantity: 1, amount: 571.01 };
  const blank = { line_number: '1', quantity: 1, amount: 571.01, connection_status: '' };
  const empty = { line_number: '1', quantity: 1, amount: 571.01, connection_status: 'Empty' };
  assert.deepEqual(pickBestInvoiceLineForInvoice(orderLine, [blank, empty]), empty);
  assert.deepEqual(pickBestInvoiceLineForInvoice(orderLine, [empty, blank]), empty);
});

test('pickArchivedInvoiceHead: picks the Archived row among Archived/Invalidated duplicates', () => {
  const archived = { invoice_number: 'INV-1', processing_status: 'Archived', document_id: 'D1' };
  const invalidated = { invoice_number: 'INV-1', processing_status: 'Invalidated', document_id: 'D2' };
  assert.deepEqual(pickArchivedInvoiceHead([invalidated, archived]), archived);
  assert.deepEqual(pickArchivedInvoiceHead([archived, invalidated]), archived);
});

test('pickArchivedInvoiceHead: no Archived row at all means null (invoice is never suggested)', () => {
  assert.equal(pickArchivedInvoiceHead([{ invoice_number: 'INV-2', processing_status: 'Invalidated' }]), null);
  assert.equal(pickArchivedInvoiceHead([]), null);
});

// The task's own "Eksempel 2": order 305588/P9L11A/Arrow ECS (59891), qty 1
// @ 571.01 matches the invoice line exactly; only the Visma order differs
// (143279 vs the order's own 145372). Per the numbered classification rule
// (confirmed with the user in an earlier round on the identical example),
// this is a STRONG suggestion - the worked example's own prose conclusion
// of "Svakt" is stale leftover text reused verbatim from an earlier
// version of the task, not the actual rule to follow.
function buildExample2() {
  const orderLine = {
    purchase_order: '305588',
    article_code: 'P9L11A',
    article_name: 'HPE G2 Rack Grounding Kit',
    supplier_id: '59891',
    supplier_name: 'Arrow ECS',
    quantity: 1,
    unit_price: 571.01,
    amount: 571.01,
  };
  const invoiceLine = {
    invoice_number: '294427',
    visma_purchase_order: '143279',
    article_code: 'P9L11A',
    article_name: 'HPE G2 Rack Grounding Kit',
    supplier_id: '59891',
    supplier_name: 'Arrow ECS',
    quantity: 1,
    unit_price: 571.01,
    amount: 571.01,
    connection_status: 'Empty',
    line_number: '3',
    quantity_not_connected_to_purchase_order_line: 1,
    amount_not_connected_to_purchase_order_line: 571.01,
  };
  const head = { invoice_type: 'PO invoice', medius_link: 'https://cloud.mediusflow.com:443/intility/#Tasks/ShowDocument/1' };
  return { orderLine, invoiceLine, head };
}

test('buildInvoiceSuggestion: Eksempel 2 (qty+amount match, Visma order mismatches) is a strong suggestion', () => {
  const { orderLine, invoiceLine, head } = buildExample2();
  const suggestion = buildInvoiceSuggestion({ orderLine, poNumber: '145372', invoiceLine, head, isManual: false });

  assert.equal(suggestion.strength, 'strong');
  assert.equal(suggestion.quantityMatches, true);
  assert.equal(suggestion.amountMatches, true);
  assert.equal(suggestion.articleMatches, true);
  assert.equal(suggestion.supplierMatches, true);
  assert.equal(suggestion.referenceVismaOrder, '145372');
  assert.equal(suggestion.invoiceVismaOrder, '143279');
  assert.equal(suggestion.invoiceTypeLabel, 'Varefaktura');
  assert.equal(suggestion.mediusLink, head.medius_link);
});

test('buildInvoiceSuggestion: Non-PO invoice type is labeled Kostnadsfaktura', () => {
  const { orderLine, invoiceLine } = buildExample2();
  const suggestion = buildInvoiceSuggestion({
    orderLine,
    poNumber: '145372',
    invoiceLine,
    head: { invoice_type: 'Non-PO invoice', medius_link: null },
    isManual: false,
  });
  assert.equal(suggestion.invoiceTypeLabel, 'Kostnadsfaktura');
});

test('buildInvoiceSuggestion: mismatched quantity is a weak suggestion', () => {
  const { orderLine, invoiceLine, head } = buildExample2();
  invoiceLine.quantity = 2;
  const suggestion = buildInvoiceSuggestion({ orderLine, poNumber: '145372', invoiceLine, head, isManual: false });
  assert.equal(suggestion.strength, 'weak');
});

test('buildInvoiceSuggestion: a manual order is always labeled "manual" with no PO/Visma fields', () => {
  const { orderLine, invoiceLine, head } = buildExample2();
  const suggestion = buildInvoiceSuggestion({ orderLine, poNumber: null, invoiceLine, head, isManual: true });
  assert.equal(suggestion.strength, 'manual');
  assert.equal(suggestion.referenceVismaOrder, null);
  assert.equal(suggestion.invoiceVismaOrder, null);
});

function makeSuggestion(strength, invoiceNumber) {
  return { strength, invoiceNumber };
}

test('rankInvoiceSuggestions: strong before weak before manual', () => {
  const ranked = rankInvoiceSuggestions([makeSuggestion('manual', '3'), makeSuggestion('weak', '2'), makeSuggestion('strong', '1')]);
  assert.deepEqual(ranked.map((s) => s.strength), ['strong', 'weak', 'manual']);
});

test('rankInvoiceSuggestions: caps at 5 results, strongest first', () => {
  const suggestions = [1, 2, 3, 4, 5, 6, 7].map((n) => makeSuggestion(n % 3 === 0 ? 'strong' : 'weak', String(n)));
  const ranked = rankInvoiceSuggestions(suggestions);
  assert.equal(ranked.length, 5);
  assert.ok(ranked.slice(0, 2).every((s) => s.strength === 'strong'));
});

// End-to-end pipeline tests using the task's three worked examples directly.

test('buildInvoiceSuggestionsForAvvik: Eksempel 1 - invoice already connected via matching Visma order is excluded entirely', () => {
  const orderLine = {
    purchase_order: '305960',
    article_code: '1006-CW9176',
    supplier_id: '60201',
    supplier_name: 'Anixter Norway Ans',
    quantity: 10,
    unit_price: 1096.0,
    amount: 10960.0,
  };
  const candidate = {
    invoice_number: '443 112697',
    visma_purchase_order: '145718', // matches the order's own reference_id - already connected
    article_code: '1006-CW9176',
    supplier_id: '60201',
    quantity: 10,
    amount: 10960.0,
    connection_status: 'Empty',
    line_number: '1',
  };
  const invoiceHeadCandidatesByNumber = new Map([
    ['443 112697', [{ invoice_number: '443 112697', invoice_type: 'PO invoice', processing_status: 'Archived', medius_link: 'x' }]],
  ]);

  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine,
    referenceId: '145718-487650',
    candidates: [candidate],
    invoiceHeadCandidatesByNumber,
  });

  assert.deepEqual(suggestions, []);
});

test('buildInvoiceSuggestionsForAvvik: Eksempel 2 - mismatched Visma order with qty+amount agreement surfaces as a strong suggestion', () => {
  const { orderLine, invoiceLine } = buildExample2();
  const invoiceHeadCandidatesByNumber = new Map([
    [
      '294427',
      [
        { invoice_number: '294427', invoice_type: 'PO invoice', processing_status: 'Invalidated', medius_link: 'old' },
        { invoice_number: '294427', invoice_type: 'PO invoice', processing_status: 'Archived', medius_link: 'https://medius/294427' },
      ],
    ],
  ]);

  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine,
    referenceId: '145372-485100',
    candidates: [invoiceLine],
    invoiceHeadCandidatesByNumber,
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].strength, 'strong');
  assert.equal(suggestions[0].invoiceNumber, '294427');
  assert.equal(suggestions[0].mediusLink, 'https://medius/294427');
});

// Eksempel 3: manual order 309282 - the wrong candidate (different article,
// different qty/amount, archived in 2024) must never surface; only the
// genuinely matching, recently-archived candidate should.
test('buildInvoiceSuggestionsForAvvik: manual order excludes wrong-article/old candidates and keeps the real match', () => {
  const orderLine = {
    purchase_order: '309282',
    article_code: 'CON-SNT-CSBARAT3',
    supplier_id: '61609',
    supplier_name: 'Westcon Group Norway AS',
    quantity: 1,
    unit_price: 2931.62,
    amount: 2931.62,
  };
  const wrongCandidate = {
    invoice_number: '1048027813',
    article_code: 'PAN-PA-1420-VSYS-5', // completely different article
    supplier_id: '61609',
    quantity: 2,
    amount: 27492.12,
    connection_status: 'Empty',
    line_number: '1',
  };
  const rightCandidate = {
    invoice_number: '1048028704',
    visma_purchase_order: '133347',
    article_code: 'CON-SNT-CSBARAT3',
    supplier_id: '61609',
    quantity: 1,
    unit_price: 2931.62,
    amount: 2931.62,
    connection_status: 'Empty',
    line_number: '1',
  };
  const invoiceHeadCandidatesByNumber = new Map([
    [
      '1048027813',
      [{ invoice_number: '1048027813', invoice_type: 'Non-PO invoice', processing_status: 'Archived', medius_link: 'x', created_at: '2024-11-04' }],
    ],
    [
      '1048028704',
      [
        {
          invoice_number: '1048028704',
          invoice_type: 'Non-PO invoice',
          processing_status: 'Archived',
          medius_link: 'https://cloud.mediusflow.com:443/intility/#Tasks/ShowDocument/35955',
          // Note: the task's own worked example gives this invoice's
          // created_at as '2025-01-02', which would itself fail the task's
          // own literal "exclude created_at < 2026-01-01" cutoff - flagged
          // to the user as a likely typo (probably meant 2026-01-02). Using
          // a 2026 date here so this test matches the cutoff rule actually
          // implemented (see the dedicated cutoff test below for the
          // boundary itself).
          created_at: '2026-01-02',
        },
      ],
    ],
  ]);

  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine,
    referenceId: '', // manual order - empty reference_id
    candidates: [wrongCandidate, rightCandidate],
    invoiceHeadCandidatesByNumber,
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].invoiceNumber, '1048028704');
  assert.equal(suggestions[0].strength, 'manual');
  assert.equal(suggestions[0].invoiceTypeLabel, 'Kostnadsfaktura');
  assert.equal(suggestions[0].referenceVismaOrder, null);
});

test('buildInvoiceSuggestionsForAvvik: manual order candidate archived before the 2026 cutoff is excluded even if everything else matches', () => {
  const orderLine = { article_code: 'X1', supplier_id: '1', quantity: 1, amount: 100 };
  const candidate = { invoice_number: 'OLD-1', article_code: 'X1', supplier_id: '1', quantity: 1, amount: 100, connection_status: 'Empty', line_number: '1' };
  const invoiceHeadCandidatesByNumber = new Map([
    ['old-1', [{ invoice_number: 'OLD-1', processing_status: 'Archived', medius_link: 'x', created_at: '2025-06-01' }]],
  ]);

  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine,
    referenceId: null,
    candidates: [candidate],
    invoiceHeadCandidatesByNumber,
  });

  assert.deepEqual(suggestions, []);
});

test('buildInvoiceSuggestionsForAvvik: a candidate with no Archived medius_invoice_head row at all is never suggested', () => {
  const orderLine = { article_code: 'X1', supplier_id: '1', quantity: 1, amount: 100 };
  const candidate = { invoice_number: 'INV-X', article_code: 'X1', supplier_id: '1', quantity: 1, amount: 100, connection_status: 'Empty', line_number: '1' };
  const invoiceHeadCandidatesByNumber = new Map([
    ['inv-x', [{ invoice_number: 'INV-X', processing_status: 'Invalidated', medius_link: 'x' }]],
  ]);

  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine,
    referenceId: '145372-485100',
    candidates: [candidate],
    invoiceHeadCandidatesByNumber,
  });

  assert.deepEqual(suggestions, []);
});

test('buildInvoiceSuggestionsForAvvik: no orderLine at all means no suggestions', () => {
  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine: null,
    referenceId: '145372-485100',
    candidates: [{ invoice_number: '294427', quantity: 1, amount: 571.01 }],
    invoiceHeadCandidatesByNumber: new Map(),
  });
  assert.deepEqual(suggestions, []);
});

test('buildInvoiceSuggestionsForAvvik: duplicate lines for the same invoice_number collapse into one suggestion', () => {
  const orderLine = { article_code: 'X1', supplier_id: '1', quantity: 1, amount: 100 };
  const dupBlank = { invoice_number: 'INV-A', article_code: 'X1', supplier_id: '1', quantity: 1, amount: 100, connection_status: '', line_number: '1' };
  const dupEmpty = { invoice_number: 'INV-A', article_code: 'X1', supplier_id: '1', quantity: 1, amount: 100, connection_status: 'Empty', line_number: '1' };
  const invoiceHeadCandidatesByNumber = new Map([['inv-a', [{ invoice_number: 'INV-A', processing_status: 'Archived', medius_link: 'x' }]]]);

  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine,
    referenceId: '145372-485100',
    candidates: [dupBlank, dupEmpty],
    invoiceHeadCandidatesByNumber,
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].connectionStatus, 'Empty');
});

test('buildInvoiceSuggestionsForAvvik: caps at 5 suggestions total', () => {
  const orderLine = { article_code: 'X1', supplier_id: '1', quantity: 1, amount: 100 };
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    invoice_number: `INV-${i}`,
    article_code: 'X1',
    supplier_id: '1',
    quantity: 1,
    amount: 100,
    connection_status: 'Empty',
    line_number: '1',
  }));
  const invoiceHeadCandidatesByNumber = new Map(
    candidates.map((c) => [c.invoice_number.toLowerCase(), [{ invoice_number: c.invoice_number, processing_status: 'Archived', medius_link: 'x' }]])
  );

  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine,
    referenceId: '145372-485100',
    candidates,
    invoiceHeadCandidatesByNumber,
  });

  assert.equal(suggestions.length, 5);
});
