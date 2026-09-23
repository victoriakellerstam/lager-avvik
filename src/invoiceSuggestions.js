'use strict';

const { MAIN_TABLE_CUTOFF_DATE } = require('./dwhQueries');

// "Forslag til faktura som må kobles til ordrelinjen": for an avvik whose
// order line has no (or an incomplete) invoice match yet, look for an
// unconnected medius_invoice_lines candidate that's likely the missing
// invoice. See avvikSync.js for how the candidate pools (medius_order_lines,
// unconnected medius_invoice_lines, medius_invoice_head) are fetched and
// grouped, and dashboard.js's renderInvoiceSuggestions for display.
//
// Manual-order detection uses supplier_order_line.reference_id directly (not
// the avvik's already-derived poNumber) - reference_id is the one
// authoritative source: empty/null means manual, a value means normal. Both
// the Visma order number extraction and the manual check are done here, in
// JS, from that single raw field, rather than trusting two independently
// derived values to stay in agreement.
//
// Two matching scenarios:
// - Normal order (reference_id present): a candidate whose own
//   visma_purchase_order already agrees with the order's extracted Visma
//   order number is treated as already connected at the order level (Medius
//   just hasn't marked the line itself connected yet) and is excluded
//   entirely, never shown as a suggestion. Of what's left (all necessarily
//   Visma-order-mismatched at this point), one where quantity and amount
//   also agree with the order line is a strong suggestion; anything else is
//   weak.
// - Manual order (reference_id empty - no PO/Visma order to compare against
//   at all): quantity and amount agreement becomes the qualifying filter
//   itself, not just a grading signal, and article_code must match exactly
//   - this is the strictest path since there's no order-reference signal to
//   fall back on. Invoices archived before the app's own order-data cutoff
//   (MAIN_TABLE_CUTOFF_DATE) are never suggested here, so a stale invoice
//   from a previous year can't surface for a current-year manual order.
//
// In both scenarios, a candidate is only ever considered at all once a
// medius_invoice_head row for its invoice_number is confirmed Archived
// (pickArchivedInvoiceHead) - an Invalidated-only invoice_number is never
// suggested.

function normalizeKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Join key from medius_order_lines (purchase_order, article_code) back to an
// avvik's own (supplier_order_number/orderId, article_number) - see Steg 1 in
// the task's mapping: these two pairs represent the same order line.
function buildOrderLineKey(purchaseOrder, articleCode) {
  return [purchaseOrder, articleCode].map(normalizeKey).join(':');
}

// Loose match key between an unconnected medius_invoice_lines candidate and
// an avvik's order line: same article, same supplier. Deliberately ignores
// the PO/Visma-order reference entirely - that's handled by
// matchesVismaOrder below, not by whether a candidate qualifies at all.
function buildInvoiceLineCandidateKey(articleCode, supplierId) {
  return [articleCode, supplierId].map(normalizeKey).join(':');
}

// A manual order is one with no reference_id at all (NULL or empty/
// whitespace-only string) - the one authoritative signal per the task,
// rather than inferring it from whatever the avvik's own already-derived
// poNumber happens to be.
function isManualOrder(referenceId) {
  return normalizeKey(referenceId) === '';
}

// The Visma order number is the segment of reference_id before its first
// "-" (e.g. "145372" from "145372-485100"). Returns null for a manual order
// (nothing to extract) or a malformed value with nothing before a "-".
function extractVismaOrderFromReference(referenceId) {
  const value = String(referenceId ?? '').trim();
  if (!value) return null;
  const dashIndex = value.indexOf('-');
  const extracted = (dashIndex >= 0 ? value.slice(0, dashIndex) : value).trim();
  return extracted || null;
}

// Whether an invoice line's own visma_purchase_order agrees with the order
// line's extracted Visma order number. Null/missing on either side can never
// agree.
function matchesVismaOrder(invoiceVismaPurchaseOrder, extractedVismaOrder) {
  if (!invoiceVismaPurchaseOrder || !extractedVismaOrder) return false;
  return normalizeKey(invoiceVismaPurchaseOrder) === normalizeKey(extractedVismaOrder);
}

function quantitiesMatch(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return Number(a) === Number(b);
}

// Amounts are floats - a small tolerance absorbs ordinary rounding.
function amountsMatch(a, b, tolerance = 0.01) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

// A manual order (no reference_id/Visma order to check against) requires an
// EXACT article_code match plus quantity+amount agreement just to qualify
// as a suggestion at all - the task calls this out as the strictest path
// (no order-reference signal to lean on), with a wider kr 1,00 amount
// tolerance than the display-level amountsMatch default (still floats,
// same rounding risk, but nothing else to grade strength by here).
const MANUAL_ORDER_AMOUNT_TOLERANCE = 1;
function qualifiesForManualOrderSuggestion(orderLine, candidate) {
  if (normalizeKey(orderLine.article_code) !== normalizeKey(candidate.article_code)) return false;
  return (
    quantitiesMatch(orderLine.quantity, candidate.quantity) &&
    amountsMatch(orderLine.amount, candidate.amount, MANUAL_ORDER_AMOUNT_TOLERANCE)
  );
}

// A manual-order candidate's invoice must have been archived on/after the
// same cutoff the rest of the app already applies to order data
// (dwhQueries.js's MAIN_TABLE_CUTOFF_DATE) - otherwise a stale invoice from
// a previous year (no order-reference to rule it out with) can surface for
// a current order. A missing createdAt is not treated as "too old" - there's
// nothing to judge it against, so it's left to the other match criteria.
function isInvoiceTooOldForManualOrder(createdAt, cutoffDate = MAIN_TABLE_CUTOFF_DATE) {
  if (!createdAt) return false;
  return new Date(createdAt) < new Date(cutoffDate);
}

// How well one candidate invoice line matches the order line - used only to
// pick the single best line per invoice_number (see
// pickBestInvoiceLineForInvoice), not to grade suggestion strength itself.
function invoiceLineMatchScore(orderLine, candidate) {
  let score = 0;
  if (quantitiesMatch(orderLine.quantity, candidate.quantity)) score += 2;
  if (amountsMatch(orderLine.amount, candidate.amount)) score += 1;
  return score;
}

// medius_invoice_lines can carry more than one row for the same invoice
// against this article+supplier (raw (invoice_number, line_number)
// duplicates - e.g. one with connection_status 'Empty' and one without -
// or several genuinely different line_numbers for the same article). Only
// one suggestion per invoice_number is ever shown, so this picks the single
// best-matching line: highest match score first, then a connection_status
// 'Empty' row over any other status, then a deterministic line_number
// tiebreak so repeated syncs don't reorder unrelated rows.
function pickBestInvoiceLineForInvoice(orderLine, candidates) {
  return candidates.reduce((best, candidate) => {
    if (!best) return candidate;
    const bestScore = invoiceLineMatchScore(orderLine, best);
    const candidateScore = invoiceLineMatchScore(orderLine, candidate);
    if (candidateScore !== bestScore) return candidateScore > bestScore ? candidate : best;
    const bestEmpty = best.connection_status === 'Empty' ? 0 : 1;
    const candidateEmpty = candidate.connection_status === 'Empty' ? 0 : 1;
    if (candidateEmpty !== bestEmpty) return candidateEmpty < bestEmpty ? candidate : best;
    const bestKey = String(best.line_number ?? '');
    const candidateKey = String(candidate.line_number ?? '');
    return candidateKey < bestKey ? candidate : best;
  }, null);
}

// medius_invoice_head can have several rows for the same invoice_number
// (Archived, Invalidated, occasionally even a different invoice_type) - only
// an Archived row ever qualifies an invoice for suggestion at all; if none
// of the candidates for this invoice_number is Archived, this returns null
// and the whole invoice_number is excluded upstream. Multiple Archived rows
// for the same invoice_number would be unexpected, but a deterministic
// document_id/invoice_number tiebreak keeps the pick stable either way.
function pickArchivedInvoiceHead(candidates) {
  const archived = candidates.filter((c) => c.processing_status === 'Archived');
  if (archived.length === 0) return null;
  return archived.reduce((best, candidate) => {
    if (!best) return candidate;
    const bestKey = String(best.document_id ?? best.invoice_number);
    const candidateKey = String(candidate.document_id ?? candidate.invoice_number);
    return candidateKey > bestKey ? candidate : best;
  }, null);
}

const INVOICE_TYPE_LABEL = {
  'PO invoice': 'Varefaktura',
  'Non-PO invoice': 'Kostnadsfaktura',
};

// One ready-to-render Norwegian sentence per strength tier - the underlying
// per-field match booleans are still exposed on the suggestion object itself
// for the side-by-side comparison in dashboard.js, this is just the
// composed "Begrunnelse" paragraph.
function buildReasonText(strength) {
  if (strength === 'manual') {
    return 'Manuell ordre – ingen PO-kobling tilgjengelig. Fakturaen har samme artikkel, leverandør, antall og beløp som ordrelinjen. Manuell kobling anbefales.';
  }
  if (strength === 'strong') {
    return 'Fakturaen har samme artikkel, leverandør, antall og beløp som ordrelinjen, men Visma-ordrereferansen avviker. Dette er trolig riktig faktura for ordrelinjen.';
  }
  return 'Fakturaen har samme artikkel og leverandør som ordrelinjen, men antall og/eller beløp avviker, i tillegg til at Visma-ordrereferansen ikke stemmer. Manuell sjekk anbefales.';
}

// Ready-to-render suggestion for one candidate invoice line against one
// avvik's order line (orderLine - a medius_order_lines row - is required;
// callers only reach here once one has been found, see
// buildInvoiceSuggestionsForAvvik). head is the invoice's own Archived
// medius_invoice_head row (see pickArchivedInvoiceHead) - always present by
// the time this is called.
function buildInvoiceSuggestion({ orderLine, poNumber, invoiceLine, head, isManual }) {
  const quantityMatches = quantitiesMatch(orderLine.quantity, invoiceLine.quantity);
  const amountMatches = amountsMatch(orderLine.amount, invoiceLine.amount);
  const unitPriceMatches = amountsMatch(orderLine.unit_price, invoiceLine.unit_price);
  const articleMatches = normalizeKey(orderLine.article_code) === normalizeKey(invoiceLine.article_code);
  const supplierMatches = normalizeKey(orderLine.supplier_id) === normalizeKey(invoiceLine.supplier_id);

  const strength = isManual ? 'manual' : quantityMatches && amountMatches ? 'strong' : 'weak';

  return {
    strength,
    invoiceNumber: invoiceLine.invoice_number,
    invoiceTypeLabel: INVOICE_TYPE_LABEL[head.invoice_type] || null,
    mediusLink: head.medius_link || null,
    articleCode: invoiceLine.article_code,
    articleName: invoiceLine.article_name || orderLine.article_name || null,
    articleMatches,
    supplierName: invoiceLine.supplier_name || orderLine.supplier_name || null,
    supplierMatches,
    orderQuantity: orderLine.quantity,
    invoiceQuantity: invoiceLine.quantity,
    quantityMatches,
    orderUnitPrice: orderLine.unit_price,
    invoiceUnitPrice: invoiceLine.unit_price,
    unitPriceMatches,
    orderAmount: orderLine.amount,
    invoiceAmount: invoiceLine.amount,
    amountMatches,
    // No reference_id to compare against at all for a manual order - null
    // here means "not applicable", not "matches"/"mismatches" (see
    // dashboard.js, which hides this row entirely when null).
    referenceVismaOrder: isManual ? null : poNumber,
    invoiceVismaOrder: isManual ? null : invoiceLine.visma_purchase_order,
    connectionStatus: invoiceLine.connection_status,
    quantityNotConnected: invoiceLine.quantity_not_connected_to_purchase_order_line,
    amountNotConnected: invoiceLine.amount_not_connected_to_purchase_order_line,
    reason: buildReasonText(strength),
  };
}

const SUGGESTION_STRENGTH_RANK = { strong: 0, weak: 1, manual: 2 };

// Strongest suggestions first; a stable, deterministic tiebreak
// (invoice_number) within the same strength so repeated syncs don't reorder
// candidates that didn't actually change. Capped to the 5 most relevant per
// the task's limit.
function rankInvoiceSuggestions(suggestions, limit = 5) {
  return [...suggestions]
    .sort((a, b) => {
      const rankDiff = SUGGESTION_STRENGTH_RANK[a.strength] - SUGGESTION_STRENGTH_RANK[b.strength];
      if (rankDiff !== 0) return rankDiff;
      const aKey = String(a.invoiceNumber ?? '');
      const bKey = String(b.invoiceNumber ?? '');
      return aKey > bKey ? 1 : aKey < bKey ? -1 : 0;
    })
    .slice(0, limit);
}

/**
 * Full suggestion pipeline for one avvik: keep only candidates with a
 * confirmed Archived medius_invoice_head row, then exclude already-order-
 * connected candidates (normal order) or hard-filter to exact article +
 * quantity+amount matches within the cutoff (manual order), collapse to one
 * suggestion per invoice_number, then rank and cap. Returns [] whenever
 * there's nothing to suggest - dashboard.js hides the section entirely in
 * that case.
 * @param {object|null} orderLine - a medius_order_lines row (see
 *   avvikSync.js's mediusOrderLineByKey), or null if none was found.
 * @param {string|null|undefined} referenceId - the order line's raw
 *   supplier_order_line.reference_id (avvik source data) - empty/null means
 *   a manual order.
 * @param {object[]} candidates - unconnected medius_invoice_lines rows
 *   already matched on article+supplier (see avvikSync.js).
 * @param {Map<string,object[]>} invoiceHeadCandidatesByNumber - normalized
 *   invoice_number -> every medius_invoice_head row for it (see
 *   avvikSync.js) - resolved to a single Archived row per invoice_number
 *   here via pickArchivedInvoiceHead.
 */
function buildInvoiceSuggestionsForAvvik({ orderLine, referenceId, candidates, invoiceHeadCandidatesByNumber }) {
  if (!orderLine) return [];

  // Only a candidate whose invoice_number has a confirmed Archived
  // medius_invoice_head row is ever eligible - an Invalidated-only invoice
  // is never suggested (Steg 4).
  const withHead = candidates
    .map((candidate) => {
      const head = pickArchivedInvoiceHead(invoiceHeadCandidatesByNumber.get(normalizeKey(candidate.invoice_number)) || []);
      return head ? { candidate, head } : null;
    })
    .filter(Boolean);
  if (withHead.length === 0) return [];

  const isManual = isManualOrder(referenceId);
  const poNumber = isManual ? null : extractVismaOrderFromReference(referenceId);

  const eligible = isManual
    ? withHead.filter(
        ({ candidate, head }) => qualifiesForManualOrderSuggestion(orderLine, candidate) && !isInvoiceTooOldForManualOrder(head.created_at)
      )
    : withHead.filter(({ candidate }) => !matchesVismaOrder(candidate.visma_purchase_order, poNumber));
  if (eligible.length === 0) return [];

  const groupsByInvoiceNumber = new Map();
  for (const entry of eligible) {
    const key = normalizeKey(entry.candidate.invoice_number);
    if (!groupsByInvoiceNumber.has(key)) groupsByInvoiceNumber.set(key, []);
    groupsByInvoiceNumber.get(key).push(entry);
  }

  const suggestions = [...groupsByInvoiceNumber.values()].map((group) => {
    const best = pickBestInvoiceLineForInvoice(orderLine, group.map((entry) => entry.candidate));
    const head = group.find((entry) => entry.candidate === best).head;
    return buildInvoiceSuggestion({ orderLine, poNumber, invoiceLine: best, head, isManual });
  });

  return rankInvoiceSuggestions(suggestions);
}

module.exports = {
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
};
