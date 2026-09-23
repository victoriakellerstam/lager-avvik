'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOrderLineKey,
  buildInvoiceLineCandidateKey,
  matchesVismaOrder,
  buildInvoiceSuggestion,
  rankInvoiceSuggestions,
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
  assert.equal(matchesVismaOrder(' 145372 ', '145372'), true);
});

test('matchesVismaOrder: different values do not match', () => {
  assert.equal(matchesVismaOrder('143279', '145372'), false);
});

test('matchesVismaOrder: either side missing can never match', () => {
  assert.equal(matchesVismaOrder(null, '145372'), false);
  assert.equal(matchesVismaOrder('143279', null), false);
  assert.equal(matchesVismaOrder(null, null), false);
});

// The example from the task: PO 305588, article P9L11A, supplier 59891 -
// invoice 294427 references Visma order 143279, which does NOT match the
// order line's own extracted Visma order 145372 - a weak suggestion.
test('buildInvoiceSuggestion: mismatched visma_purchase_order is a weak suggestion with a warning reason', () => {
  const suggestion = buildInvoiceSuggestion({
    orderLine: {
      purchase_order: '305588',
      article_code: 'P9L11A',
      article_name: 'HPE G2 Rack Grounding Kit',
      supplier_name: 'Arrow ECS',
      quantity: 1,
      unit_price: 571.01,
      amount: 571.01,
      connected_quantity: 0,
      received_not_connected_quantity: 1,
    },
    orderId: '305588',
    articleNumber: 'P9L11A',
    poNumber: '145372',
    referenceId: '145372-485100',
    invoiceLine: {
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
      document_id: '8b80f3ad81b748f88e1752f2bb883c78',
      quantity_not_connected_to_purchase_order_line: 1,
      amount_not_connected_to_purchase_order_line: 571.01,
    },
  });

  assert.equal(suggestion.strength, 'weak');
  assert.equal(suggestion.orderLine.purchaseOrder, '305588');
  assert.equal(suggestion.invoiceLine.invoiceNumber, '294427');
  const warnReason = suggestion.reasons.find((r) => !r.ok);
  assert.ok(warnReason, 'expected exactly one warning reason for the mismatched Visma order');
  assert.match(warnReason.text, /143279/);
  assert.match(warnReason.text, /145372/);
  // Quantity (1) and amount (571.01) match the order line, so that
  // confirming reason should also be present.
  assert.ok(suggestion.reasons.some((r) => r.ok && /Fakturert antall/.test(r.text)));
});

test('buildInvoiceSuggestion: matching visma_purchase_order is a strong suggestion with no warning reason', () => {
  const suggestion = buildInvoiceSuggestion({
    orderLine: null,
    orderId: '305588',
    articleNumber: 'P9L11A',
    poNumber: '145372',
    referenceId: '145372-485100',
    invoiceLine: {
      invoice_number: '294427',
      visma_purchase_order: '145372',
      article_code: 'P9L11A',
      supplier_id: '59891',
      supplier_name: 'Arrow ECS',
      quantity: 1,
      unit_price: 571.01,
      amount: 571.01,
      connection_status: 'Empty',
      quantity_not_connected_to_purchase_order_line: 1,
    },
  });

  assert.equal(suggestion.strength, 'strong');
  assert.equal(suggestion.orderLine, null);
  assert.ok(suggestion.reasons.every((r) => r.ok));
});

test('buildInvoiceSuggestion: no orderLine means no quantity/amount confirmation reason (nothing to compare against)', () => {
  const suggestion = buildInvoiceSuggestion({
    orderLine: null,
    orderId: '305588',
    articleNumber: 'P9L11A',
    poNumber: '145372',
    referenceId: '145372-485100',
    invoiceLine: {
      invoice_number: '294427',
      visma_purchase_order: '145372',
      article_code: 'P9L11A',
      supplier_id: '59891',
      quantity: 1,
      amount: 571.01,
      connection_status: 'Empty',
    },
  });
  assert.ok(!suggestion.reasons.some((r) => /Fakturert antall/.test(r.text)));
});

function makeSuggestion(strength, invoiceNumber) {
  return { strength, invoiceLine: { invoiceNumber } };
}

test('rankInvoiceSuggestions: strong suggestions always sort before weak ones', () => {
  const ranked = rankInvoiceSuggestions([makeSuggestion('weak', '2'), makeSuggestion('strong', '1')]);
  assert.deepEqual(ranked.map((s) => s.strength), ['strong', 'weak']);
});

test('rankInvoiceSuggestions: same-strength ties break deterministically by invoice number', () => {
  const a = [makeSuggestion('weak', '294427'), makeSuggestion('weak', '100001')];
  const b = [makeSuggestion('weak', '100001'), makeSuggestion('weak', '294427')];
  assert.deepEqual(rankInvoiceSuggestions(a), rankInvoiceSuggestions(b));
  assert.equal(rankInvoiceSuggestions(a)[0].invoiceLine.invoiceNumber, '100001');
});

test('rankInvoiceSuggestions: caps at 5 results, strongest first', () => {
  const suggestions = [
    makeSuggestion('weak', '1'),
    makeSuggestion('weak', '2'),
    makeSuggestion('strong', '3'),
    makeSuggestion('weak', '4'),
    makeSuggestion('strong', '5'),
    makeSuggestion('weak', '6'),
    makeSuggestion('weak', '7'),
  ];
  const ranked = rankInvoiceSuggestions(suggestions);
  assert.equal(ranked.length, 5);
  assert.deepEqual(ranked.slice(0, 2).map((s) => s.strength), ['strong', 'strong']);
});
