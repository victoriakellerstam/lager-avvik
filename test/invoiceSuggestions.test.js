'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOrderLineKey,
  buildInvoiceLineCandidateKey,
  matchesVismaOrder,
  quantitiesMatch,
  amountsMatch,
  qualifiesForManualOrderSuggestion,
  pickBestInvoiceLineForInvoice,
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

test('amountsMatch: small rounding differences are tolerated', () => {
  assert.equal(amountsMatch(571.01, 571.01), true);
  assert.equal(amountsMatch(571.01, 571.015), true);
  assert.equal(amountsMatch(571.01, 571.5), false);
});

test('qualifiesForManualOrderSuggestion: requires both quantity and amount to agree', () => {
  const orderLine = { quantity: 1, amount: 571.01 };
  assert.equal(qualifiesForManualOrderSuggestion(orderLine, { quantity: 1, amount: 571.01 }), true);
  assert.equal(qualifiesForManualOrderSuggestion(orderLine, { quantity: 2, amount: 571.01 }), false);
  assert.equal(qualifiesForManualOrderSuggestion(orderLine, { quantity: 1, amount: 600 }), false);
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

test('pickBestInvoiceLineForInvoice: final tiebreak is deterministic regardless of input order', () => {
  const orderLine = { quantity: 1, amount: 571.01 };
  const a = { line_number: '1', quantity: 1, amount: 571.01, connection_status: 'Empty' };
  const b = { line_number: '2', quantity: 1, amount: 571.01, connection_status: 'Empty' };
  assert.deepEqual(pickBestInvoiceLineForInvoice(orderLine, [a, b]), pickBestInvoiceLineForInvoice(orderLine, [b, a]));
});

// The task's own "Eksempel 2": order 305588/P9L11A/Arrow ECS (59891), qty 1
// @ 571.01 matches the invoice line exactly; only the Visma order differs
// (143279 vs the order's own 145372). Per Steg 5, this is a STRONG
// suggestion (quantity+amount agree) - the example's own prose conclusion of
// "Svakt" is stale leftover text from the previous version, per direct
// confirmation.
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
  return { orderLine, invoiceLine };
}

test('buildInvoiceSuggestion: Eksempel 2 (qty+amount match, Visma order mismatches) is a strong suggestion', () => {
  const { orderLine, invoiceLine } = buildExample2();
  const suggestion = buildInvoiceSuggestion({
    orderLine,
    poNumber: '145372',
    invoiceLine,
    mediusLink: 'https://cloud.mediusflow.com:443/intility/#Tasks/ShowDocument/1',
    isManual: false,
  });

  assert.equal(suggestion.strength, 'strong');
  assert.equal(suggestion.quantityMatches, true);
  assert.equal(suggestion.amountMatches, true);
  assert.equal(suggestion.articleMatches, true);
  assert.equal(suggestion.supplierMatches, true);
  assert.equal(suggestion.referenceVismaOrder, '145372');
  assert.equal(suggestion.invoiceVismaOrder, '143279');
  assert.equal(suggestion.mediusLink, 'https://cloud.mediusflow.com:443/intility/#Tasks/ShowDocument/1');
});

test('buildInvoiceSuggestion: mismatched quantity/amount (still not the same Visma order) is a weak suggestion', () => {
  const { orderLine, invoiceLine } = buildExample2();
  invoiceLine.quantity = 2; // no longer agrees with the order's quantity of 1
  const suggestion = buildInvoiceSuggestion({
    orderLine,
    poNumber: '145372',
    invoiceLine,
    mediusLink: null,
    isManual: false,
  });
  assert.equal(suggestion.strength, 'weak');
  assert.equal(suggestion.quantityMatches, false);
});

test('buildInvoiceSuggestion: a manual order is always labeled "manual", never strong', () => {
  const { orderLine, invoiceLine } = buildExample2();
  const suggestion = buildInvoiceSuggestion({
    orderLine,
    poNumber: null,
    invoiceLine,
    mediusLink: null,
    isManual: true,
  });
  assert.equal(suggestion.strength, 'manual');
  // No reference_id to compare against for a manual order.
  assert.equal(suggestion.referenceVismaOrder, null);
  assert.equal(suggestion.invoiceVismaOrder, null);
});

function makeSuggestion(strength, invoiceNumber) {
  return { strength, invoiceNumber };
}

test('rankInvoiceSuggestions: strong before weak before manual', () => {
  const ranked = rankInvoiceSuggestions([
    makeSuggestion('manual', '3'),
    makeSuggestion('weak', '2'),
    makeSuggestion('strong', '1'),
  ]);
  assert.deepEqual(ranked.map((s) => s.strength), ['strong', 'weak', 'manual']);
});

test('rankInvoiceSuggestions: same-strength ties break deterministically by invoice number', () => {
  const a = [makeSuggestion('weak', '294427'), makeSuggestion('weak', '100001')];
  const b = [makeSuggestion('weak', '100001'), makeSuggestion('weak', '294427')];
  assert.deepEqual(rankInvoiceSuggestions(a), rankInvoiceSuggestions(b));
  assert.equal(rankInvoiceSuggestions(a)[0].invoiceNumber, '100001');
});

test('rankInvoiceSuggestions: caps at 5 results, strongest first', () => {
  const suggestions = [1, 2, 3, 4, 5, 6, 7].map((n) => makeSuggestion(n % 3 === 0 ? 'strong' : 'weak', String(n)));
  const ranked = rankInvoiceSuggestions(suggestions);
  assert.equal(ranked.length, 5);
  assert.ok(ranked.slice(0, 2).every((s) => s.strength === 'strong'));
});

// End-to-end pipeline tests using the task's two worked examples directly.

test('buildInvoiceSuggestionsForAvvik: Eksempel 1 - invoice already connected via matching Visma order is excluded entirely', () => {
  const orderLine = {
    purchase_order: '305960',
    article_code: '1006-CW9176',
    article_name: 'OBERON Right-Angle Wi-Fi Access Point Wall Mount',
    supplier_id: '60201',
    supplier_name: 'Anixter Norway Ans',
    quantity: 10,
    unit_price: 1096.0,
    amount: 10960.0,
  };
  const candidate = {
    invoice_number: '443 112697',
    visma_purchase_order: '145718', // matches poNumber below - already connected
    article_code: '1006-CW9176',
    supplier_id: '60201',
    quantity: 10,
    amount: 10960.0,
    connection_status: 'Empty',
    line_number: '1',
  };

  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine,
    poNumber: '145718', // extracted from reference_id '145718-487650'
    candidates: [candidate],
    mediusLinkByInvoiceNumber: new Map(),
  });

  assert.deepEqual(suggestions, []);
});

test('buildInvoiceSuggestionsForAvvik: Eksempel 2 - mismatched Visma order with qty+amount agreement surfaces as a strong suggestion', () => {
  const { orderLine, invoiceLine } = buildExample2();
  const mediusLinkByInvoiceNumber = new Map([['294427', 'https://cloud.mediusflow.com:443/intility/#Tasks/ShowDocument/1']]);

  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine,
    poNumber: '145372',
    candidates: [invoiceLine],
    mediusLinkByInvoiceNumber,
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].strength, 'strong');
  assert.equal(suggestions[0].invoiceNumber, '294427');
  assert.equal(suggestions[0].mediusLink, 'https://cloud.mediusflow.com:443/intility/#Tasks/ShowDocument/1');
});

test('buildInvoiceSuggestionsForAvvik: manual order (no poNumber) filters out candidates that do not agree on quantity+amount', () => {
  const orderLine = { article_code: 'X1', supplier_id: '1', quantity: 1, amount: 100 };
  const matching = { invoice_number: 'INV-A', article_code: 'X1', supplier_id: '1', quantity: 1, amount: 100, connection_status: 'Empty', line_number: '1' };
  const notMatching = { invoice_number: 'INV-B', article_code: 'X1', supplier_id: '1', quantity: 5, amount: 500, connection_status: 'Empty', line_number: '1' };

  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine,
    poNumber: null,
    candidates: [matching, notMatching],
    mediusLinkByInvoiceNumber: new Map(),
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].invoiceNumber, 'INV-A');
  assert.equal(suggestions[0].strength, 'manual');
});

test('buildInvoiceSuggestionsForAvvik: no orderLine at all means no suggestions', () => {
  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine: null,
    poNumber: '145372',
    candidates: [{ invoice_number: '294427', quantity: 1, amount: 571.01 }],
    mediusLinkByInvoiceNumber: new Map(),
  });
  assert.deepEqual(suggestions, []);
});

test('buildInvoiceSuggestionsForAvvik: duplicate lines for the same invoice_number collapse into one suggestion', () => {
  const orderLine = { article_code: 'X1', supplier_id: '1', quantity: 1, amount: 100 };
  const dupBlank = { invoice_number: 'INV-A', article_code: 'X1', supplier_id: '1', quantity: 1, amount: 100, connection_status: '', line_number: '1' };
  const dupEmpty = { invoice_number: 'INV-A', article_code: 'X1', supplier_id: '1', quantity: 1, amount: 100, connection_status: 'Empty', line_number: '1' };

  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine,
    poNumber: '145372',
    candidates: [dupBlank, dupEmpty],
    mediusLinkByInvoiceNumber: new Map(),
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

  const suggestions = buildInvoiceSuggestionsForAvvik({
    orderLine,
    poNumber: '145372',
    candidates,
    mediusLinkByInvoiceNumber: new Map(),
  });

  assert.equal(suggestions.length, 5);
});
