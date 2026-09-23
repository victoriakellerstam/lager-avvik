'use strict';

const crypto = require('crypto');
const dwhQueries = require('./dwhQueries');
const { mapDeviationScenario } = require('./scenario');
const { normalizeFullNameForMatching, resolvePurchaserEmail } = require('./purchaser');
const {
  buildOrderLineKey,
  buildInvoiceLineCandidateKey,
  buildInvoiceSuggestionsForAvvik,
} = require('./invoiceSuggestions');

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function buildSyntheticId(row) {
  const parts = [row.supplier_order_number, row.article_number, row.lot_number];
  return crypto.createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 16);
}

// Loose key (trimmed, lowercased) for matching a fetchMediusLinks row against
// an avvik row's own po_number/article_number/supplier_id_text - guards
// against harmless formatting differences (case, stray whitespace) between
// the two independently-sourced values.
function buildMediusLinkKey(poNumber, articleNumber, supplierIdText) {
  return [poNumber, articleNumber, supplierIdText].map((v) => String(v ?? '').trim().toLowerCase()).join(':');
}

// Same idea as buildMediusLinkKey, but for fetchMediusCostInvoiceLinks
// candidates - a Kostnadsfaktura match has no article to key on, only
// PO+supplier (see dwhQueries.js's fetchMediusCostInvoiceLinks).
function buildMediusCostLinkKey(poNumber, supplierIdText) {
  return [poNumber, supplierIdText].map((v) => String(v ?? '').trim().toLowerCase()).join(':');
}

// Archived first, any other valid/active status next (e.g. Open), then
// Invalidated last - the exact processing_status values already relied on
// elsewhere in this pipeline (see dwhQueries.js's fetchAvvikRows
// is_*_archived_via_po/is_*_invalidated_via_po/is_*_open_via_po). Anything
// other than these two known statuses falls into the middle tier without
// needing to name it, so this doesn't have to guess at every possible value.
function mediusInvoicePriority(processingStatus) {
  if (processingStatus === 'Archived') return 0;
  if (processingStatus === 'Invalidated') return 2;
  return 1;
}

// Picks one medius_invoice_head row out of several candidates that all
// matched the same key (see fetchMediusLinks/buildMediusLinkKey, or
// fetchMediusCostInvoiceLinks/buildMediusCostLinkKey) - a lone candidate is
// always kept as-is, whatever its status, so a single Invalidated invoice
// still surfaces exactly like before this existed. document_id is a stable,
// always-same-result tiebreak between two candidates of the same status -
// it's a COLLATE'd string key in this data model, not a confirmed date/
// recency field, so this is not a "pick the newest" claim, only a
// deterministic one. Confirmed against real data that a Kostnadsfaktura
// invoice_head row can have a NULL document_id (no medius_invoice_lines join
// to source one from) - invoice_number is the fallback tiebreak for that
// case, same "deterministic, not recency" caveat applies.
function pickBestMediusInvoice(candidates) {
  return candidates.reduce((best, candidate) => {
    if (!best) return candidate;
    const bestPriority = mediusInvoicePriority(best.processing_status);
    const candidatePriority = mediusInvoicePriority(candidate.processing_status);
    if (candidatePriority !== bestPriority) return candidatePriority < bestPriority ? candidate : best;
    const bestKey = String(best.document_id ?? best.invoice_number);
    const candidateKey = String(candidate.document_id ?? candidate.invoice_number);
    return candidateKey > bestKey ? candidate : best;
  }, null);
}

// medius_order_deviations.purchase_order is the bestillingsnummer
// (order_number/supplier_order_number), NOT the po_number every other Medius
// table in this pipeline joins on - a different key, confirmed directly by
// the user. article_code is included as a double-check that a deviation
// found for the order is actually on the same line the avvik was raised on.
function buildOrderDeviationKey(orderId, articleNumber) {
  return [orderId, articleNumber].map((v) => String(v ?? '').trim().toLowerCase()).join(':');
}

// Videresolgt is shown ('Nei'/'Delvis'/'Ja') whenever the lot isn't fully
// written off - unlike Skrevet ut av lager below, it has no hidden state, so
// a lot with nothing resold yet still reads 'Nei' rather than disappearing.
// The one exception is isFullyWrittenOff: once writtenOffQuantity alone
// already covers the whole total, Videresolgt drops out entirely instead of
// showing a redundant 'Nei' next to it.
function resolveResoldStatus(resoldQuantity, writtenOffQuantity, totalQuantity) {
  const isFullyWrittenOff = totalQuantity > 0 && writtenOffQuantity >= totalQuantity && resoldQuantity === 0;
  if (isFullyWrittenOff) return null;
  if (resoldQuantity === 0) return 'Nei';
  if (resoldQuantity < totalQuantity) return 'Delvis';
  if (writtenOffQuantity === 0) return 'Ja';
  return 'Delvis';
}

// Skrevet ut av lager only appears at all once something has actually been
// written off - no 'Nei' state, unlike Videresolgt above.
function resolveWrittenOffStatus(resoldQuantity, writtenOffQuantity, totalQuantity) {
  if (writtenOffQuantity <= 0) return null;
  if (writtenOffQuantity >= totalQuantity && resoldQuantity === 0) return 'Ja';
  return 'Delvis';
}

// Videresolgt/Skrevet ut av lager for a lot, from dwhQueries.js's
// fetchStockMovementBreakdownByLot (grouped by type_of_change - see that
// query for exactly which type_of_change values land in which category).
//
// Known, accepted limitation: stock_history has no reversal/voucher
// reference to tell a genuine reversal apart from a fresh receipt that
// happens to land in the same type_of_change bucket, so positive rows are
// only ever added to totalQuantity, never subtracted back out of either
// outgoing category. This can overstate resoldQuantity/writtenOffQuantity
// when a real reversal occurs - deliberately accepted per the user rather
// than guessing at which positive rows are reversals.
//
// No breakdown row for the lot at all (never received, or no lot_number on
// this order line) means both categories are 0, which hides both cards.
function resolveStockBreakdown(lotNumber, breakdownByLot) {
  const breakdown = breakdownByLot.get(String(lotNumber ?? '').trim().toLowerCase());
  const totalQuantity = breakdown ? breakdown.totalQuantity : 0;
  const resoldQuantity = breakdown ? breakdown.resoldQuantity : 0;
  const writtenOffQuantity = breakdown ? breakdown.writtenOffQuantity : 0;

  // Can't happen from a single stock_history row (type_of_change = 0 is
  // never also in the resold IN-list), so a lot tripping this has duplicate
  // rows or a lot_number join collision - surfaced, not silently corrected.
  if (totalQuantity > 0 && resoldQuantity + writtenOffQuantity > totalQuantity) {
    console.warn(
      `stock breakdown for lot ${lotNumber}: resoldQuantity (${resoldQuantity}) + writtenOffQuantity (${writtenOffQuantity}) exceeds totalQuantity (${totalQuantity})`
    );
  }

  // No breakdown row for the lot at all (never received, or no lot_number
  // on this order line) means there's nothing to report - hide both cards
  // rather than resolveResoldStatus's normal 'Nei' for "nothing resold yet".
  const hasData = totalQuantity > 0;

  return {
    totalQuantity,
    resoldQuantity,
    writtenOffQuantity,
    resoldStatus: hasData ? resolveResoldStatus(resoldQuantity, writtenOffQuantity, totalQuantity) : null,
    writtenOffStatus: hasData ? resolveWrittenOffStatus(resoldQuantity, writtenOffQuantity, totalQuantity) : null,
  };
}

/**
 * Runs one full dwh -> avvik refresh: dwhQueries.js's fetchAvvikRows query
 * does the actual classification and purchaser resolution in SQL (see
 * scenario.js/purchaser.js for what's left to do in JS - just mapping the
 * deviation_scenario string and looking up an email address).
 * @returns {Promise<object[]>} freshly-shaped avvik rows, ready for
 *   store.mergeFromDwh. Never includes local state (resolved/comments/etc) -
 *   that's mergeFromDwh's job to preserve across a refresh.
 */
async function syncAvvikFromDwh() {
  // Sequential, not Promise.all: see dwhQueries.js's withPool comment - many
  // simultaneous open connections/result buffers is a bigger spike than one
  // at a time.
  const rows = await dwhQueries.fetchAvvikRows();
  const intilityUsers = await dwhQueries.fetchIntilityUsers();
  const departments = await dwhQueries.fetchDepartments();
  const mediusLinks = await dwhQueries.fetchMediusLinks();
  const mediusCostInvoiceLinks = await dwhQueries.fetchMediusCostInvoiceLinks();
  const stockMovementByLot = await dwhQueries.fetchStockMovementBreakdownByLot();
  const orderDeviations = await dwhQueries.fetchOrderDeviations();
  const mediusOrderLines = await dwhQueries.fetchMediusOrderLines();
  const unconnectedInvoiceLines = await dwhQueries.fetchUnconnectedInvoiceLines();
  const mediusInvoiceHeadRows = await dwhQueries.fetchMediusInvoiceHeadByNumber();

  const emailByFullName = new Map(
    intilityUsers.map((u) => [normalizeFullNameForMatching(u.user_full_name), u.email])
  );
  const departmentByFullName = new Map(
    intilityUsers.map((u) => [normalizeFullNameForMatching(u.user_full_name), u.department])
  );
  const departmentNameByNumber = new Map(departments.map((d) => [d.department_number, d.department_name]));
  // More than one medius_invoice_head row can match the same PO+article+
  // supplier (see fetchMediusLinks) - group every candidate per key first,
  // then let pickBestMediusInvoice choose one, so the invoiceNumber and
  // mediusLink shown together always come from the same winning row rather
  // than two independently (and possibly differently) chosen ones.
  const mediusCandidatesByKey = new Map();
  for (const m of mediusLinks) {
    const key = buildMediusLinkKey(m.visma_purchase_order, m.article_code, m.supplier_id);
    if (!mediusCandidatesByKey.has(key)) mediusCandidatesByKey.set(key, []);
    mediusCandidatesByKey.get(key).push(m);
  }
  const mediusInfoByKey = new Map(
    [...mediusCandidatesByKey.entries()].map(([key, candidates]) => {
      const best = pickBestMediusInvoice(candidates);
      return [key, { invoiceNumber: best.invoice_number, mediusLink: best.medius_link }];
    })
  );
  // Kostnadsfaktura fallback: no article to key on, only PO+supplier (see
  // dwhQueries.js's fetchMediusCostInvoiceLinks and buildMediusCostLinkKey
  // above) - only consulted below when the exact PO+article+supplier lookup
  // finds nothing, so it never overrides a real line-level match.
  const mediusCostCandidatesByKey = new Map();
  for (const m of mediusCostInvoiceLinks) {
    const key = buildMediusCostLinkKey(m.visma_purchase_order, m.supplier_id);
    if (!mediusCostCandidatesByKey.has(key)) mediusCostCandidatesByKey.set(key, []);
    mediusCostCandidatesByKey.get(key).push(m);
  }
  const mediusCostInfoByKey = new Map(
    [...mediusCostCandidatesByKey.entries()].map(([key, candidates]) => {
      const best = pickBestMediusInvoice(candidates);
      return [key, { invoiceNumber: best.invoice_number, mediusLink: best.medius_link }];
    })
  );
  const stockBreakdownByLot = new Map(
    stockMovementByLot.map((s) => [
      String(s.lot_number ?? '').trim().toLowerCase(),
      { totalQuantity: s.total_quantity, resoldQuantity: s.resold_quantity, writtenOffQuantity: s.written_off_quantity },
    ])
  );
  const deviationNamesByOrderArticle = new Map();
  for (const d of orderDeviations) {
    const key = buildOrderDeviationKey(d.purchase_order, d.article_code);
    if (!deviationNamesByOrderArticle.has(key)) deviationNamesByOrderArticle.set(key, new Set());
    deviationNamesByOrderArticle.get(key).add(d.deviation_name);
  }
  // First match wins per key - medius_order_lines isn't guaranteed unique per
  // purchase_order+article_code, but this is only the display-only
  // "ordrelinje" card (see invoiceSuggestions.js), not a matching criterion,
  // so a deterministic pick is enough.
  const mediusOrderLineByKey = new Map();
  for (const line of mediusOrderLines) {
    const key = buildOrderLineKey(line.purchase_order, line.article_code);
    if (!mediusOrderLineByKey.has(key)) mediusOrderLineByKey.set(key, line);
  }
  // Grouped the same way mediusCandidatesByKey is above - every unconnected
  // invoice line sharing an avvik's article+supplier is a candidate for that
  // avvik's "Forslag til faktura" section (see invoiceSuggestions.js).
  const invoiceLineCandidatesByKey = new Map();
  for (const line of unconnectedInvoiceLines) {
    const key = buildInvoiceLineCandidateKey(line.article_code, line.supplier_id);
    if (!invoiceLineCandidatesByKey.has(key)) invoiceLineCandidatesByKey.set(key, []);
    invoiceLineCandidatesByKey.get(key).push(line);
  }
  // Keyed purely by invoice_number (see dwhQueries.js's
  // fetchMediusInvoiceHeadByNumber) for a suggestion's Medius link,
  // fakturatype, and archive date - kept as raw grouped candidates, not
  // deduped here, since only an Archived row ever qualifies an invoice for
  // suggestion at all (see invoiceSuggestions.js's pickArchivedInvoiceHead,
  // called per avvik below).
  const invoiceHeadCandidatesByNumber = new Map();
  for (const h of mediusInvoiceHeadRows) {
    const key = String(h.invoice_number ?? '').trim().toLowerCase();
    if (!invoiceHeadCandidatesByNumber.has(key)) invoiceHeadCandidatesByNumber.set(key, []);
    invoiceHeadCandidatesByNumber.get(key).push(h);
  }

  const avvikRows = [];
  for (const row of rows) {
    const discrepancyType = mapDeviationScenario(row.deviation_scenario);
    if (discrepancyType === null) continue;

    const purchaserName = row.case_owner || null;
    const purchaserEmail = resolvePurchaserEmail(purchaserName, emailByFullName);
    // The resolved sakseier's own department (intility_users) is primary -
    // it's who actually owns the case. department_number is only a fallback
    // for when no sakseier could be resolved at all.
    const department =
      departmentByFullName.get(normalizeFullNameForMatching(purchaserName)) ||
      departmentNameByNumber.get(row.department_number) ||
      null;
    // Line-level PO+article+supplier match first (goods invoices); if that
    // finds nothing, fall back to the PO+supplier-only Kostnadsfaktura match
    // - a cost invoice reversal isn't tied to this specific article line.
    // Neither lookup runs at all for a manual order (no po_number): a manual
    // order has no PO to key either lookup on, so any coincidental match
    // (e.g. an invoice whose visma_purchase_order happens to also be an
    // empty string) would be a false "koblet til ordren" link the order
    // never actually has - confirmed as a real bug against order 306794.
    const mediusInfo = row.po_number
      ? mediusInfoByKey.get(buildMediusLinkKey(row.po_number, row.article_number, row.supplier_id_text)) ||
        mediusCostInfoByKey.get(buildMediusCostLinkKey(row.po_number, row.supplier_id_text))
      : null;
    const stockBreakdown = resolveStockBreakdown(row.lot_number, stockBreakdownByLot);

    // "Forslag til faktura som må kobles til ordrelinjen": only meaningful
    // once we know what was actually ordered (mediusOrderLineByKey) - with no
    // such row there's nothing to build a suggestion card set around at all.
    const orderLine = mediusOrderLineByKey.get(buildOrderLineKey(row.supplier_order_number, row.article_number)) || null;
    const invoiceCandidates = orderLine
      ? invoiceLineCandidatesByKey.get(buildInvoiceLineCandidateKey(row.article_number, row.supplier_id_text)) || []
      : [];
    const invoiceSuggestions = buildInvoiceSuggestionsForAvvik({
      orderLine,
      referenceId: row.reference_id,
      orderDate: row.order_date,
      candidates: invoiceCandidates,
      invoiceHeadCandidatesByNumber,
    });

    avvikRows.push({
      id: buildSyntheticId(row),
      orderId: row.supplier_order_number,
      articleNumber: row.article_number,
      poNumber: row.po_number,
      lotNumber: row.lot_number,
      ticketUrl: row.ticket_url,
      department,
      purchaserName,
      purchaserEmail,
      discrepancyType,
      createdAt: toIso(row.order_date),
      daysWaiting: row.days_waiting,
      invoiceNumber: mediusInfo ? mediusInfo.invoiceNumber : null,
      mediusLink: mediusInfo ? mediusInfo.mediusLink : null,
      totalQuantity: stockBreakdown.totalQuantity,
      resoldQuantity: stockBreakdown.resoldQuantity,
      writtenOffQuantity: stockBreakdown.writtenOffQuantity,
      resoldStatus: stockBreakdown.resoldStatus,
      writtenOffStatus: stockBreakdown.writtenOffStatus,
      invoiceDeviations: [
        ...(deviationNamesByOrderArticle.get(buildOrderDeviationKey(row.supplier_order_number, row.article_number)) || []),
      ],
      invoiceSuggestions,
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

// Used by index.js's manual-purchaser endpoint: when someone types in a real
// sakseier name for a "Sakseier ikke funnet" case, look up that person's own
// department the same way the sync above does, so department improves along
// with the purchaser instead of staying stuck at whatever (if anything)
// department_number resolved to.
async function resolveDepartmentForPurchaser(name) {
  if (!name) return null;
  const intilityUsers = await dwhQueries.fetchIntilityUsers();
  const normalized = normalizeFullNameForMatching(name);
  const match = intilityUsers.find((u) => normalizeFullNameForMatching(u.user_full_name) === normalized);
  return (match && match.department) || null;
}

module.exports = {
  syncAvvikFromDwh,
  resolveDepartmentForPurchaser,
  resolveStockBreakdown,
  resolveResoldStatus,
  resolveWrittenOffStatus,
  pickBestMediusInvoice,
  buildMediusLinkKey,
  buildMediusCostLinkKey,
};
