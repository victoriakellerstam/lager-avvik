'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyDiscrepancyType, KREDITTKORT_SUPPLIER_NUMBER, SOFTWARE_INTERMEDIATE_GROUP_NUMBER } = require('../src/scenario');
const {
  IKKE_MOTTATT_FAKTURA_I_MEDIUS,
  INTERNBESTILLING,
  KOSTNADSFAKTURA_REVERSER,
  KOSTNADSFAKTURA_UNDER_BEHANDLING,
  KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT,
  MANUELL_ORDRE,
  ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR,
  SPESIELLE_CASER_FINANCE,
  VAREFAKTURA_UNDER_BEHANDLING,
} = require('../src/discrepancyTypes');

const PO = '146789';
const SUPPLIER = 12345;
const ARTICLE = 'ART-1';

// Groups a flat array of rows into a Map keyed by the given field, mirroring
// how avvikSync.js will index the reference tables before classification.
function groupBy(rows, field) {
  const map = new Map();
  for (const row of rows) {
    const key = row[field];
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function buildIndexes({ heads = [], lines = [], connections = [] } = {}) {
  return {
    invoiceHeadByPo: groupBy(heads, 'visma_purchase_order'),
    invoiceLinesByPo: groupBy(lines, 'visma_purchase_order'),
    connectionsByPo: groupBy(connections, 'visma_purchase_order'),
    invoiceHeadByInvoiceNumber: groupBy(heads, 'invoice_number'),
  };
}

function baseRow(overrides = {}) {
  return {
    poNumber: PO,
    supplierNumber: SUPPLIER,
    articleNumber: ARTICLE,
    projectNumber: null,
    intermediateGroupNumber: null,
    ...overrides,
  };
}

test('an order with no PO-nummer is a manual order', () => {
  const result = classifyDiscrepancyType(baseRow({ poNumber: null }), buildIndexes());
  assert.equal(result, MANUELL_ORDRE);
});

test('kredittkort-leverandør + software = feilaktig lisenskjøp', () => {
  const row = baseRow({
    supplierNumber: KREDITTKORT_SUPPLIER_NUMBER,
    intermediateGroupNumber: SOFTWARE_INTERMEDIATE_GROUP_NUMBER,
  });
  assert.equal(classifyDiscrepancyType(row, buildIndexes()), KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT);
});

test('kredittkort-leverandør + not software = feilaktig distributør', () => {
  const row = baseRow({ supplierNumber: KREDITTKORT_SUPPLIER_NUMBER, intermediateGroupNumber: 999 });
  assert.equal(classifyDiscrepancyType(row, buildIndexes()), ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR);
});

test('project_number 14000 is Internbestilling (14000 specifically, per the faithfully-ported quirk)', () => {
  const row = baseRow({ projectNumber: 14000 });
  assert.equal(classifyDiscrepancyType(row, buildIndexes()), INTERNBESTILLING);
});

test('project_number 11246 is NOT Internbestilling in Scenario 2 (matches the source DAX quirk)', () => {
  // No invoices anywhere -> falls through to "Ikke mottatt faktura i Medius",
  // proving the 11246 check genuinely doesn't short-circuit here.
  const row = baseRow({ projectNumber: 11246 });
  assert.equal(classifyDiscrepancyType(row, buildIndexes()), IKKE_MOTTATT_FAKTURA_I_MEDIUS);
});

test('no matching invoice anywhere = ikke mottatt faktura i Medius', () => {
  assert.equal(classifyDiscrepancyType(baseRow(), buildIndexes()), IKKE_MOTTATT_FAKTURA_I_MEDIUS);
});

test('cost invoice reached only via the Medius connection bridge, archived = reverser', () => {
  const indexes = buildIndexes({
    heads: [
      { visma_purchase_order: 'OTHER-PO', supplier_id: String(SUPPLIER), invoice_type: 'Non-PO invoice', processing_status: 'Archived', invoice_number: 'INV-1' },
    ],
    connections: [{ visma_purchase_order: PO, invoice_number: 'INV-1' }],
  });
  assert.equal(classifyDiscrepancyType(baseRow(), indexes), KOSTNADSFAKTURA_REVERSER);
});

test('cost invoice reached only via the Medius connection bridge, open = under behandling', () => {
  const indexes = buildIndexes({
    heads: [
      { visma_purchase_order: 'OTHER-PO', supplier_id: String(SUPPLIER), invoice_type: 'Non-PO invoice', processing_status: 'Open', invoice_number: 'INV-1' },
    ],
    connections: [{ visma_purchase_order: PO, invoice_number: 'INV-1' }],
  });
  assert.equal(classifyDiscrepancyType(baseRow(), indexes), KOSTNADSFAKTURA_UNDER_BEHANDLING);
});

test('cost invoice matched directly on the PO, archived = reverser', () => {
  const indexes = buildIndexes({
    heads: [{ visma_purchase_order: PO, supplier_id: String(SUPPLIER), invoice_type: 'Non-PO invoice', processing_status: 'Archived', invoice_number: 'INV-2' }],
  });
  assert.equal(classifyDiscrepancyType(baseRow(), indexes), KOSTNADSFAKTURA_REVERSER);
});

test('cost invoice matched directly on the PO, open = under behandling', () => {
  const indexes = buildIndexes({
    heads: [{ visma_purchase_order: PO, supplier_id: String(SUPPLIER), invoice_type: 'Non-PO invoice', processing_status: 'Open', invoice_number: 'INV-3' }],
  });
  assert.equal(classifyDiscrepancyType(baseRow(), indexes), KOSTNADSFAKTURA_UNDER_BEHANDLING);
});

test('invoice matched via PO+article, cost type, archived = reverser', () => {
  const indexes = buildIndexes({
    heads: [{ visma_purchase_order: PO, supplier_id: String(SUPPLIER), invoice_type: 'Non-PO invoice', processing_status: 'Archived', invoice_number: 'INV-4' }],
    lines: [{ visma_purchase_order: PO, supplier_id: String(SUPPLIER), article_code: ARTICLE, invoice_number: 'INV-4' }],
  });
  assert.equal(classifyDiscrepancyType(baseRow(), indexes), KOSTNADSFAKTURA_REVERSER);
});

test('ErKostnadViaPO && ErVareApenViaPO: a cost invoice AND a separate open goods invoice both exist for this PO+article = under behandling', () => {
  // ErKostnadViaPO and ErVareApenViaPO are independent existence checks, each
  // able to be satisfied by a *different* invoice - a single row can't be
  // both "Non-PO invoice" (cost) and "not Non-PO invoice" (goods) at once,
  // so this branch is only reachable when two distinct invoices exist for
  // the same PO+article: one cost, one open goods.
  const indexes = buildIndexes({
    heads: [
      { visma_purchase_order: PO, supplier_id: String(SUPPLIER), invoice_type: 'Non-PO invoice', processing_status: 'Open', invoice_number: 'INV-5a' },
      { visma_purchase_order: PO, supplier_id: String(SUPPLIER), invoice_type: 'PO invoice', processing_status: 'Open', invoice_number: 'INV-5b' },
    ],
    lines: [
      { visma_purchase_order: PO, supplier_id: String(SUPPLIER), article_code: ARTICLE, invoice_number: 'INV-5a' },
      { visma_purchase_order: PO, supplier_id: String(SUPPLIER), article_code: ARTICLE, invoice_number: 'INV-5b' },
    ],
  });
  assert.equal(classifyDiscrepancyType(baseRow(), indexes), KOSTNADSFAKTURA_UNDER_BEHANDLING);
});

test('invoice matched via PO+article, goods type, open (not cost) = varefaktura under behandling', () => {
  const indexes = buildIndexes({
    heads: [{ visma_purchase_order: PO, supplier_id: String(SUPPLIER), invoice_type: 'PO invoice', processing_status: 'Open', invoice_number: 'INV-6' }],
    lines: [{ visma_purchase_order: PO, supplier_id: String(SUPPLIER), article_code: ARTICLE, invoice_number: 'INV-6' }],
  });
  assert.equal(classifyDiscrepancyType(baseRow(), indexes), VAREFAKTURA_UNDER_BEHANDLING);
});

test('invoice matched via PO+article, goods type, archived (not cost, not open) = spesielle caser - Finance', () => {
  const indexes = buildIndexes({
    heads: [{ visma_purchase_order: PO, supplier_id: String(SUPPLIER), invoice_type: 'PO invoice', processing_status: 'Archived', invoice_number: 'INV-7' }],
    lines: [{ visma_purchase_order: PO, supplier_id: String(SUPPLIER), article_code: ARTICLE, invoice_number: 'INV-7' }],
  });
  assert.equal(classifyDiscrepancyType(baseRow(), indexes), SPESIELLE_CASER_FINANCE);
});

test('invoice matched via PO+article, goods type, invalidated (dead branch) = not an avvik', () => {
  // In production this never actually happens because dwhQueries.js's
  // medius_invoice_head fetch excludes Invalidated rows entirely (same as
  // the source Power BI query), but the pure classification function should
  // still handle it correctly if ever given such a fixture.
  const indexes = buildIndexes({
    heads: [{ visma_purchase_order: PO, supplier_id: String(SUPPLIER), invoice_type: 'PO invoice', processing_status: 'Invalidated', invoice_number: 'INV-8' }],
    lines: [{ visma_purchase_order: PO, supplier_id: String(SUPPLIER), article_code: ARTICLE, invoice_number: 'INV-8' }],
  });
  assert.equal(classifyDiscrepancyType(baseRow(), indexes), null);
});

test('no invoice at all matches the PO+article combination, only an unrelated invoice on the same PO = not an avvik (varefaktura OK)', () => {
  const indexes = buildIndexes({
    heads: [{ visma_purchase_order: PO, supplier_id: String(SUPPLIER), invoice_type: 'PO invoice', processing_status: 'Archived', invoice_number: 'INV-9' }],
    lines: [{ visma_purchase_order: PO, supplier_id: String(SUPPLIER), article_code: 'DIFFERENT-ARTICLE', invoice_number: 'INV-9' }],
    connections: [{ visma_purchase_order: PO, invoice_number: 'INV-9' }],
  });
  // harFakturaViaPo is false (article doesn't match), but harKoblingViaBestNr
  // is true (the connection bridges to a head matching supplier), so this
  // should not fall into "ikke mottatt faktura i Medius" - it should fall
  // through the rest of the chain to the final "Varefaktura — OK" (null).
  assert.equal(classifyDiscrepancyType(baseRow(), indexes), null);
});
