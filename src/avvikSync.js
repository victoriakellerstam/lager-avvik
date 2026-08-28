'use strict';

const crypto = require('crypto');
const dwhQueries = require('./dwhQueries');
const { classifyDiscrepancyType } = require('./scenario');
const {
  extractPoCodesFromTicketTitle,
  pickWinningSakseier,
  normalizeOurRef,
  normalizeFullNameForMatching,
  resolvePurchaser,
} = require('./purchaser');

const DAYS_WAITING_THRESHOLD = 21;

function groupBy(rows, field) {
  const map = new Map();
  for (const row of rows) {
    const key = row[field];
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

// Faithful port of the original SQL's PO-nummer derivation:
//   CASE WHEN ReferenceID IS NULL THEN NULL
//        WHEN CHARINDEX('-', ReferenceID) > 0 THEN LEFT(ReferenceID, CHARINDEX('-', ReferenceID) - 1)
//        ELSE ReferenceID END
// A reference_id with no "-" is NOT treated as "no PO" - it's kept as-is.
// Only a genuinely null reference_id derives to a null PO-nummer (manual order).
function derivePoNumber(referenceId) {
  if (referenceId === null || referenceId === undefined) return null;
  const dashIndex = referenceId.indexOf('-');
  return dashIndex === -1 ? referenceId : referenceId.slice(0, dashIndex);
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

// order_status doubles as the union branch discriminator for the synthetic
// id (3015/3030 = already-flagged line, 3000 = "mangler mottak" line) - this
// app never persists order_status itself, but the branches must not collide
// on id even if the same supplier_order_number+article_number+lot_number+
// order_date combination somehow appears in both.
function buildSyntheticId(row) {
  const parts = [row.order_status, row.supplier_order_number, row.article_number, row.lot_number, toIso(row.order_date)];
  return crypto.createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 16);
}

function buildScenarioIndexes({ invoiceHead, invoiceLines, connections }) {
  return {
    invoiceHeadByPo: groupBy(invoiceHead, 'visma_purchase_order'),
    invoiceLinesByPo: groupBy(invoiceLines, 'visma_purchase_order'),
    connectionsByPo: groupBy(connections, 'visma_purchase_order'),
    invoiceHeadByInvoiceNumber: groupBy(invoiceHead, 'invoice_number'),
  };
}

// One winning ticket per PO-code, tie-break resolved once here rather than
// per order line - a ticket's title can yield more than one PO-code, so a
// single ticket may become a candidate for several codes.
function buildSakseierByPoCode(tickets) {
  const candidatesByPoCode = new Map();
  for (const ticket of tickets) {
    for (const code of extractPoCodesFromTicketTitle(ticket.ticket_title)) {
      if (!candidatesByPoCode.has(code)) candidatesByPoCode.set(code, []);
      candidatesByPoCode.get(code).push(ticket);
    }
  }
  const winnerByPoCode = new Map();
  for (const [code, candidates] of candidatesByPoCode) {
    const winner = pickWinningSakseier(candidates);
    if (winner) winnerByPoCode.set(code, winner);
  }
  return winnerByPoCode;
}

function buildPurchaserIndexes({ tickets, supplierOrders, intilityUsers }) {
  const ourRefBySupplierOrderNumber = new Map(
    supplierOrders.map((row) => [row.supplier_order_number, normalizeOurRef(row.our_ref)])
  );
  const emailByFullName = new Map(
    intilityUsers.map((row) => [normalizeFullNameForMatching(row.user_full_name), row.email])
  );
  return {
    sakseierByPoCode: buildSakseierByPoCode(tickets),
    ourRefBySupplierOrderNumber,
    emailByFullName,
  };
}

// Mirrors the DAX 'Dager ventende' / 'Er over 3 uker' pair: the earliest
// positive-quantity Stock History movement for this lot (already filtered to
// >= 2025-10-01 in SQL), and whether that receipt is more than 21 days old.
// A lot with no matching movement at all is "not over 3 weeks" (DAX BLANK()
// compared to a number is not TRUE), so it's excluded, same as the source.
function buildEarliestPositiveMovementByLot(stockHistory) {
  const map = new Map();
  for (const row of stockHistory) {
    const existing = map.get(row.lot_number);
    if (!existing || row.created_at < existing) {
      map.set(row.lot_number, row.created_at);
    }
  }
  return map;
}

function isOverThreeWeeks(earliestMovement, now) {
  if (!earliestMovement) return false;
  const daysWaiting = Math.floor((now - earliestMovement) / (24 * 60 * 60 * 1000));
  return daysWaiting > DAYS_WAITING_THRESHOLD;
}

/**
 * Runs one full dwh -> avvik refresh: fetch every reference dataset, index
 * it, then walk the main order-line feed applying the same filter/classify/
 * resolve pipeline as the source Power BI report.
 * @returns {Promise<object[]>} freshly-shaped avvik rows, ready for
 *   store.mergeFromDwh. Never includes local state (resolved/comments/etc) -
 *   that's mergeFromDwh's job to preserve across a refresh.
 */
async function syncAvvikFromDwh(now = new Date()) {
  const [orderLines, invoiceHead, invoiceLines, connections, stockHistory, tickets, supplierOrders, intilityUsers] =
    await Promise.all([
      dwhQueries.fetchOrderLines(),
      dwhQueries.fetchMediusInvoiceHead(),
      dwhQueries.fetchMediusInvoiceLines(),
      dwhQueries.fetchMediusOrderConnections(),
      dwhQueries.fetchStockHistory(),
      dwhQueries.fetchTickets(),
      dwhQueries.fetchSupplierOrders(),
      dwhQueries.fetchIntilityUsers(),
    ]);

  const scenarioIndexes = buildScenarioIndexes({ invoiceHead, invoiceLines, connections });
  const purchaserIndexes = buildPurchaserIndexes({ tickets, supplierOrders, intilityUsers });
  const earliestPositiveMovementByLot = buildEarliestPositiveMovementByLot(stockHistory);

  const avvikRows = [];
  for (const row of orderLines) {
    const earliestMovement = earliestPositiveMovementByLot.get(row.lot_number);
    if (!isOverThreeWeeks(earliestMovement, now)) continue;

    const poNumber = derivePoNumber(row.reference_id);

    const discrepancyType = classifyDiscrepancyType(
      {
        poNumber,
        supplierNumber: row.supplier_number,
        articleNumber: row.article_number,
        projectNumber: row.project_number,
        intermediateGroupNumber: row.intermediate_group_number,
      },
      scenarioIndexes
    );
    if (discrepancyType === null) continue;

    const { purchaserName, purchaserEmail } = resolvePurchaser(
      { poNumber, supplierOrderNumber: row.supplier_order_number },
      purchaserIndexes
    );

    avvikRows.push({
      id: buildSyntheticId(row),
      orderId: row.supplier_order_number,
      purchaserName,
      purchaserEmail,
      discrepancyType,
      createdAt: toIso(row.order_date),
    });
  }

  const uniqueIds = new Set(avvikRows.map((a) => a.id));
  if (uniqueIds.size !== avvikRows.length) {
    throw new Error(
      `avvikSync: ${avvikRows.length - uniqueIds.size} synthetic id collision(s) detected out of ${avvikRows.length} rows - refusing to sync until this is investigated.`
    );
  }

  return avvikRows;
}

module.exports = { syncAvvikFromDwh, derivePoNumber };
