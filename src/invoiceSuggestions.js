'use strict';

// "Forslag til faktura som må kobles til ordrelinjen": for an avvik whose
// order line has no (or an incomplete) invoice match yet, look for an
// unconnected medius_invoice_lines candidate that's likely the missing
// invoice. See avvikSync.js for how the candidate pools (medius_order_lines,
// unconnected medius_invoice_lines, medius_invoice_head links) are fetched
// and grouped, and dashboard.js's renderInvoiceSuggestions for display.
//
// Two matching scenarios:
// - Normal order (poNumber present - the Visma order number extracted from
//   supplier_order_line.reference_id): a candidate whose own
//   visma_purchase_order already agrees with poNumber is treated as already
//   connected at the order level (Medius just hasn't marked the line itself
//   connected yet) and is excluded entirely, never shown as a suggestion.
//   Of what's left (all necessarily Visma-order-mismatched at this point),
//   one where quantity and amount also agree with the order line is a
//   strong suggestion; anything else is weak.
// - Manual order (no poNumber, so there's no reference_id to compare
//   against at all): quantity and amount agreement becomes the qualifying
//   filter itself, not just a grading signal - a candidate that doesn't
//   agree on both isn't shown at all. Every surviving candidate is labeled
//   "manual" (always the weak/manual-check tone), since there's no Visma
//   order signal to grade strength by.

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

// Whether an invoice line's own visma_purchase_order agrees with the order
// line's extracted Visma order number (supplier_order_line.reference_id's
// first segment, before the first "-"). Null/missing on either side can
// never agree.
function matchesVismaOrder(invoiceVismaPurchaseOrder, extractedVismaOrder) {
  if (!invoiceVismaPurchaseOrder || !extractedVismaOrder) return false;
  return normalizeKey(invoiceVismaPurchaseOrder) === normalizeKey(extractedVismaOrder);
}

function quantitiesMatch(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return Number(a) === Number(b);
}

// Amounts are floats - a small tolerance absorbs ordinary rounding, per the
// task's "tillat små avvik pga. avrunding" for the manual-order path
// (applied uniformly here since the same rounding risk exists either way).
function amountsMatch(a, b, tolerance = 0.01) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

// A manual order (no reference_id/Visma order to check against) requires
// quantity+amount agreement just to qualify as a suggestion at all - the
// task calls this out as a hard filter for this path, not merely a grading
// signal the way it is for a normal order.
function qualifiesForManualOrderSuggestion(orderLine, candidate) {
  return quantitiesMatch(orderLine.quantity, candidate.quantity) && amountsMatch(orderLine.amount, candidate.amount);
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

// One ready-to-render Norwegian sentence per strength tier - the underlying
// per-field match booleans are still exposed on the suggestion object itself
// for the side-by-side comparison in dashboard.js, this is just the
// composed "Begrunnelse" paragraph.
function buildReasonText(strength) {
  if (strength === 'manual') {
    return 'Ordren er en manuell ordre uten PO-kobling. Fakturaen har samme artikkel, leverandør, antall og beløp som ordrelinjen, men må kobles manuelt siden det ikke finnes noen ordrereferanse å sammenligne mot.';
  }
  if (strength === 'strong') {
    return 'Fakturaen har samme artikkel, leverandør, antall og beløp som ordrelinjen, men Visma-ordrereferansen avviker. Dette er trolig riktig faktura for ordrelinjen.';
  }
  return 'Fakturaen har samme artikkel og leverandør som ordrelinjen, men antall og/eller beløp avviker, i tillegg til at Visma-ordrereferansen ikke stemmer. Manuell sjekk anbefales.';
}

// Ready-to-render suggestion for one candidate invoice line against one
// avvik's order line (orderLine - a medius_order_lines row - is required;
// callers only reach here once one has been found, see
// buildInvoiceSuggestionsForAvvik).
function buildInvoiceSuggestion({ orderLine, poNumber, invoiceLine, mediusLink, isManual }) {
  const quantityMatches = quantitiesMatch(orderLine.quantity, invoiceLine.quantity);
  const amountMatches = amountsMatch(orderLine.amount, invoiceLine.amount);
  const unitPriceMatches = amountsMatch(orderLine.unit_price, invoiceLine.unit_price);
  const articleMatches = normalizeKey(orderLine.article_code) === normalizeKey(invoiceLine.article_code);
  const supplierMatches = normalizeKey(orderLine.supplier_id) === normalizeKey(invoiceLine.supplier_id);

  const strength = isManual ? 'manual' : quantityMatches && amountMatches ? 'strong' : 'weak';

  return {
    strength,
    invoiceNumber: invoiceLine.invoice_number,
    mediusLink: mediusLink || null,
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
 * Full suggestion pipeline for one avvik: exclude already-order-connected
 * candidates (normal order) or hard-filter to quantity+amount matches
 * (manual order), collapse to one suggestion per invoice_number, then rank
 * and cap. Returns [] whenever there's nothing to suggest (no orderLine
 * found at all, or every candidate got excluded/filtered) - dashboard.js
 * hides the section entirely in that case.
 * @param {object|null} orderLine - a medius_order_lines row (see
 *   avvikSync.js's mediusOrderLineByKey), or null if none was found.
 * @param {string} poNumber - the order line's own extracted Visma order
 *   number (avvik.poNumber), or falsy for a manual order.
 * @param {object[]} candidates - unconnected medius_invoice_lines rows
 *   already matched on article+supplier (see avvikSync.js).
 * @param {Map<string,string>} mediusLinkByInvoiceNumber - normalized
 *   invoice_number -> medius_link (see avvikSync.js).
 */
function buildInvoiceSuggestionsForAvvik({ orderLine, poNumber, candidates, mediusLinkByInvoiceNumber }) {
  if (!orderLine) return [];

  const isManual = !poNumber;
  const eligible = isManual
    ? candidates.filter((c) => qualifiesForManualOrderSuggestion(orderLine, c))
    : candidates.filter((c) => !matchesVismaOrder(c.visma_purchase_order, poNumber));
  if (eligible.length === 0) return [];

  const byInvoiceNumber = new Map();
  for (const candidate of eligible) {
    const key = normalizeKey(candidate.invoice_number);
    if (!byInvoiceNumber.has(key)) byInvoiceNumber.set(key, []);
    byInvoiceNumber.get(key).push(candidate);
  }

  const suggestions = [...byInvoiceNumber.entries()].map(([key, group]) => {
    const best = pickBestInvoiceLineForInvoice(orderLine, group);
    return buildInvoiceSuggestion({
      orderLine,
      poNumber,
      invoiceLine: best,
      mediusLink: mediusLinkByInvoiceNumber.get(key) || null,
      isManual,
    });
  });

  return rankInvoiceSuggestions(suggestions);
}

module.exports = {
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
};
