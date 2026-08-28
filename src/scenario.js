'use strict';

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
} = require('./discrepancyTypes');

// Resolved business rules from the dwh migration (see project memory
// lager_avvik_dwh_migration_handoff.md): the old text-based checks
// (Leverandørnavn = "Kredittkort", Type vare = "Software") are gone from the
// migrated schema and are replaced by these numeric codes.
const KREDITTKORT_SUPPLIER_NUMBER = 60067;
const SOFTWARE_INTERMEDIATE_GROUP_NUMBER = 1000211;

// This is a faithful port of the "Scenario 2" DAX column from the Power BI
// semantic model (see the TMDL handoff). Two deliberate simplifications were
// made when porting it into this app's smaller discrepancyType enum, agreed
// with the user:
//   1. "Varefaktura — OK" and "Varefaktura — OK, makulert" are not real
//      avvik (the invoice is fine) - classify() returns null for these, and
//      callers must treat a null classification as "not an avvik, don't
//      include this row".
//   2. The DAX distinguishes "via bestNr" (through a Medius connection
//      bridge) from "direct" (Medius faktura matched straight on the PO) for
//      both the "reverser" and "under behandling" cost-invoice outcomes -
//      four DAX branches in total. This app doesn't need that distinction,
//      so all four collapse onto two buckets: KOSTNADSFAKTURA_REVERSER and
//      KOSTNADSFAKTURA_UNDER_BEHANDLING.
//
// Known quirk, ported as-is rather than "fixed": the Internbestilling branch
// only fires when project_number is exactly 14000, even though the separate
// "Internbestilling status" column in the original report also recognizes
// 11246. That's how the source DAX is written, so we match it faithfully.

/**
 * @typedef {object} ScenarioRow
 * @property {string|null} poNumber - Derived PO-nummer (part of reference_id
 *   before the first "-"), or null for orders with no PO (manual orders).
 * @property {number|string} supplierNumber - supplier_number on the order line.
 * @property {string} articleNumber - article_number on the order line.
 * @property {number|null} projectNumber - project_number on the order line.
 * @property {number|null} intermediateGroupNumber - intermediate_group_number
 *   on the order line (Software = 1000211).
 */

/**
 * @typedef {object} ScenarioIndexes
 * @property {Map<string, object[]>} invoiceHeadByPo - medius_invoice_head
 *   rows (supplier_id, invoice_type, processing_status, invoice_number),
 *   keyed by visma_purchase_order.
 * @property {Map<string, object[]>} invoiceLinesByPo - medius_invoice_lines
 *   rows (supplier_id, article_code, invoice_number), keyed by
 *   visma_purchase_order.
 * @property {Map<string, object[]>} connectionsByPo - medius_order_connections
 *   rows (invoice_number), keyed by visma_purchase_order. Despite the DAX
 *   naming these variables "...ViaBestNr", they are actually keyed by
 *   visma_purchase_order on the connection table, not by supplier_order_number.
 * @property {Map<string, object[]>} invoiceHeadByInvoiceNumber - the same
 *   medius_invoice_head rows as invoiceHeadByPo, re-indexed by invoice_number
 *   instead, needed to resolve the Medius connection -> Medius faktura bridge.
 */

function textEquals(a, b) {
  return String(a) === String(b);
}

// Mirrors: CALCULATE(COUNTROWS('Medius faktura'), po, supplier, [extra]) > 0
// with no line/article matching at all ("Direkte" variants in the DAX).
function fakturaDirectMatches(po, supplierIdText, extraHeadPredicate, indexes) {
  const heads = indexes.invoiceHeadByPo.get(po) || [];
  return heads.some((h) => textEquals(h.supplier_id, supplierIdText) && extraHeadPredicate(h));
}

// Mirrors the "ViaPO" variants: a Medius faktura head matching po+supplier(+extra)
// AND, via the invoice_number bridge, a Medius linje row matching
// po+supplier+article on that same invoice.
function fakturaViaPoMatches(po, supplierIdText, articleNumber, extraHeadPredicate, indexes) {
  const heads = (indexes.invoiceHeadByPo.get(po) || []).filter(
    (h) => textEquals(h.supplier_id, supplierIdText) && extraHeadPredicate(h)
  );
  if (heads.length === 0) return false;
  const lines = indexes.invoiceLinesByPo.get(po) || [];
  const matchingInvoiceNumbers = new Set(
    lines
      .filter((l) => textEquals(l.supplier_id, supplierIdText) && l.article_code === articleNumber)
      .map((l) => l.invoice_number)
  );
  return heads.some((h) => matchingInvoiceNumbers.has(h.invoice_number));
}

// Mirrors the "ViaBestNr" variants: a Medius connection row for this PO,
// bridged via invoice_number to a Medius faktura head matching supplier(+extra).
function connectionBridgeMatches(po, supplierIdText, extraHeadPredicate, indexes) {
  const connections = indexes.connectionsByPo.get(po) || [];
  for (const conn of connections) {
    const heads = indexes.invoiceHeadByInvoiceNumber.get(conn.invoice_number) || [];
    if (heads.some((h) => textEquals(h.supplier_id, supplierIdText) && extraHeadPredicate(h))) {
      return true;
    }
  }
  return false;
}

const isArchivedCostInvoice = (h) => h.invoice_type === 'Non-PO invoice' && h.processing_status === 'Archived';
const isOpenCostInvoice = (h) => h.invoice_type === 'Non-PO invoice' && h.processing_status === 'Open';
const isArchivedGoodsInvoice = (h) => h.invoice_type !== 'Non-PO invoice' && h.processing_status === 'Archived';

/**
 * @param {ScenarioRow} row
 * @param {ScenarioIndexes} indexes
 * @returns {string|null} one of the discrepancyTypes.js constants, or null if
 *   this row is not actually an avvik (invoice is fine) and should be
 *   excluded from the avvik feed entirely.
 */
function classifyDiscrepancyType(row, indexes) {
  const { poNumber, articleNumber, projectNumber, intermediateGroupNumber } = row;
  const supplierIdText = String(row.supplierNumber);

  if (poNumber === null || poNumber === undefined || poNumber === '') {
    return MANUELL_ORDRE;
  }

  if (row.supplierNumber === KREDITTKORT_SUPPLIER_NUMBER) {
    return intermediateGroupNumber === SOFTWARE_INTERMEDIATE_GROUP_NUMBER
      ? KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT
      : ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR;
  }

  // Faithful port of the original DAX condition (see "known quirk" note
  // above): only project_number === 14000 triggers this branch.
  if (projectNumber === 14000) {
    return INTERNBESTILLING;
  }

  const harFakturaViaPo = fakturaViaPoMatches(poNumber, supplierIdText, articleNumber, () => true, indexes);
  const harKoblingViaBestNr = connectionBridgeMatches(poNumber, supplierIdText, () => true, indexes);
  const kostnadArkivertDirekte = fakturaDirectMatches(poNumber, supplierIdText, isArchivedCostInvoice, indexes);
  const kostnadApenDirekte = fakturaDirectMatches(poNumber, supplierIdText, isOpenCostInvoice, indexes);

  if (!harFakturaViaPo && !harKoblingViaBestNr && !kostnadArkivertDirekte && !kostnadApenDirekte) {
    return IKKE_MOTTATT_FAKTURA_I_MEDIUS;
  }

  const kostnadArkivertViaBestNr = connectionBridgeMatches(poNumber, supplierIdText, isArchivedCostInvoice, indexes);
  if (!harFakturaViaPo && kostnadArkivertViaBestNr) {
    return KOSTNADSFAKTURA_REVERSER; // DAX: "Kostnadsfaktura via bestNr — reverser"
  }

  const kostnadApenViaBestNr = connectionBridgeMatches(poNumber, supplierIdText, isOpenCostInvoice, indexes);
  if (!harFakturaViaPo && kostnadApenViaBestNr) {
    return KOSTNADSFAKTURA_UNDER_BEHANDLING; // DAX: "Kostnadsfaktura via bestNr — følg opp"
  }

  if (!harFakturaViaPo && kostnadArkivertDirekte) {
    return KOSTNADSFAKTURA_REVERSER; // DAX: "Kostnadsfaktura — reverser" (direct)
  }

  if (!harFakturaViaPo && kostnadApenDirekte) {
    return KOSTNADSFAKTURA_UNDER_BEHANDLING; // DAX: "Kostnadsfaktura — under behandling" (direct)
  }

  const erKostnadViaPo = fakturaViaPoMatches(
    poNumber,
    supplierIdText,
    articleNumber,
    (h) => h.invoice_type === 'Non-PO invoice',
    indexes
  );
  const erArkivertViaPo = fakturaViaPoMatches(poNumber, supplierIdText, articleNumber, isArchivedCostInvoice, indexes);
  if (erKostnadViaPo && erArkivertViaPo) {
    return KOSTNADSFAKTURA_REVERSER;
  }

  const erVareApenViaPo = fakturaViaPoMatches(
    poNumber,
    supplierIdText,
    articleNumber,
    (h) => h.invoice_type !== 'Non-PO invoice' && h.processing_status === 'Open',
    indexes
  );
  if (erKostnadViaPo && erVareApenViaPo) {
    return KOSTNADSFAKTURA_UNDER_BEHANDLING;
  }

  // Dead branch, kept for faithfulness: dwhQueries.js's medius_invoice_head
  // fetch already excludes processing_status = 'Invalidated' (matching the
  // original Medius faktura partition's own SQL filter), so this can never
  // actually be true - "Varefaktura — OK, makulert" never fires in practice,
  // same as in the source Power BI report.
  const erVareMakulertViaPo = fakturaViaPoMatches(
    poNumber,
    supplierIdText,
    articleNumber,
    (h) => h.invoice_type !== 'Non-PO invoice' && h.processing_status === 'Invalidated',
    indexes
  );
  if (!erKostnadViaPo && erVareMakulertViaPo && !erVareApenViaPo) {
    return null; // DAX: "Varefaktura — OK, makulert" - not a real avvik.
  }

  if (!erKostnadViaPo && erVareApenViaPo) {
    return VAREFAKTURA_UNDER_BEHANDLING; // DAX: "Varefaktura — under behandling" - a real, actionable avvik.
  }

  const erVareArkivertViaPo = fakturaViaPoMatches(poNumber, supplierIdText, articleNumber, isArchivedGoodsInvoice, indexes);
  if (!erKostnadViaPo && erVareArkivertViaPo) {
    return SPESIELLE_CASER_FINANCE;
  }

  return null; // DAX: "Varefaktura — OK" - not a real avvik.
}

module.exports = {
  classifyDiscrepancyType,
  KREDITTKORT_SUPPLIER_NUMBER,
  SOFTWARE_INTERMEDIATE_GROUP_NUMBER,
};
