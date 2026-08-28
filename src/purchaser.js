'use strict';

// Faithful port of the Power BI M-function that built POnummer_utbedret on
// "Sakseier ny" (see the TMDL handoff): splits a ticket title on "#", and for
// every segment after the first, checks whether its first 6 trimmed
// characters look like a PO-nummer (starts with 14/15/16/17, exactly 6
// characters long) and isn't part of a "cancelled" note. The original M code
// joined the matches into a comma-separated string for a CONTAINSSTRING
// search; this app instead returns them as an array, since we build a real
// one-row-per-PO-number join table instead of doing a live text search.
const VALID_PO_CODE_PREFIXES = ['14', '15', '16', '17'];

function extractPoCodesFromTicketTitle(ticketTitle) {
  if (typeof ticketTitle !== 'string' || ticketTitle.length === 0) return [];

  // M's List.Skip(Text.Split([ticket_title], "#"), 1): ignore whatever comes
  // before the first "#" entirely, only look at segments after it.
  const segmentsAfterFirstHash = ticketTitle.split('#').slice(1);

  const codes = [];
  for (const segment of segmentsAfterFirstHash) {
    const trimmed = segment.trim();
    const token = trimmed.slice(0, 6); // M: Text.Start(trimmed, 6)
    // M: Text.Contains(Text.Start(trimmed, 20), "cancl") - no comparer given,
    // so this is a case-sensitive exact-substring check, not the
    // case-insensitive CONTAINSSTRING used elsewhere in the DAX.
    const isCancelled = trimmed.slice(0, 20).includes('cancl');
    const hasValidPrefix = VALID_PO_CODE_PREFIXES.some((prefix) => token.startsWith(prefix));
    if (hasValidPrefix && token.length === 6 && !isCancelled) {
      codes.push(token);
    }
  }
  return codes;
}

function isBlank(value) {
  return value === null || value === undefined || value === '';
}

function titleContainsWarehouse(title) {
  // DAX's CONTAINSSTRING is case-insensitive.
  return typeof title === 'string' && title.toLowerCase().includes('warehouse');
}

// Ties broken by the alphabetically-greatest full name, matching DAX's
// MAXX(..., 'Sakseier ny'[intility_worker_fullname]) behavior on a text
// column. (This won't necessarily match SQL Server/DAX's exact collation for
// special characters, but is a reasonable-effort faithful port; ties are
// expected to be rare in practice.)
function maxByFullName(tickets) {
  return tickets.reduce((best, t) =>
    !best || String(t.intility_worker_fullname) > String(best.intility_worker_fullname) ? t : best
  );
}

// Faithful port of the "SakseierNavnForFilter" tie-break logic (see the TMDL
// handoff, e.g. the "Tabell HTML 2" measure): given every ticket whose
// POnummer_utbedret-equivalent (extractPoCodesFromTicketTitle) matched a
// given PO-code, pick the one winning ticket.
function pickWinningSakseier(candidateTickets) {
  if (!candidateTickets || candidateTickets.length === 0) return null;

  const egenTreff = candidateTickets.filter((t) => t.category_name === 'Egenbestillinger');
  if (egenTreff.length > 0) return maxByFullName(egenTreff);

  const ikkeLogistikkTreff = candidateTickets.filter(
    (t) =>
      t.category_top_level !== 'Logistics' &&
      (t.category_top_level !== 'Setup' || !isBlank(t.classification_name)) &&
      !titleContainsWarehouse(t.intility_worker_title)
  );
  if (ikkeLogistikkTreff.length > 0) return maxByFullName(ikkeLogistikkTreff);

  return null;
}

// "Intility Webshop" is normalized to "no real owner", same as the original
// DAX's CASE WHEN [OurRef] = 'Intility Webshop' THEN '-' ELSE [OurRef] END
// (we use null instead of "-" as the app's own "no owner" sentinel).
function normalizeOurRef(ourRef) {
  if (ourRef === 'Intility Webshop' || isBlank(ourRef)) return null;
  return ourRef;
}

// Used both when building emailByFullName's keys and when looking a name up
// in it, so a case/whitespace difference between the ticket system's
// intility_worker_fullname and the employee directory's full name doesn't
// silently fail to match.
function normalizeFullNameForMatching(name) {
  if (typeof name !== 'string') return '';
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * @typedef {object} PurchaserRow
 * @property {string|null} poNumber - Derived PO-nummer, or null for manual orders.
 * @property {string} supplierOrderNumber - supplier_order_number (Best.nr).
 */

/**
 * @typedef {object} PurchaserIndexes
 * @property {Map<string, object>} sakseierByPoCode - one winning ticket per
 *   PO-code, already resolved via pickWinningSakseier.
 * @property {Map<string, string|null>} ourRefBySupplierOrderNumber - already
 *   normalized via normalizeOurRef.
 * @property {Map<string, string>} emailByFullName - keyed by
 *   normalizeFullNameForMatching(fullName).
 */

/**
 * @param {PurchaserRow} row
 * @param {PurchaserIndexes} indexes
 * @returns {{purchaserName: string|null, purchaserEmail: string|null}}
 */
function resolvePurchaser(row, indexes) {
  let purchaserName = null;

  if (row.poNumber === null || row.poNumber === undefined || row.poNumber === '') {
    purchaserName = indexes.ourRefBySupplierOrderNumber.get(row.supplierOrderNumber) || null;
  } else {
    const ticket = indexes.sakseierByPoCode.get(row.poNumber);
    purchaserName = (ticket && ticket.intility_worker_fullname) || null;
  }

  let purchaserEmail = null;
  if (purchaserName) {
    purchaserEmail = indexes.emailByFullName.get(normalizeFullNameForMatching(purchaserName)) || null;
  }

  return { purchaserName, purchaserEmail };
}

module.exports = {
  extractPoCodesFromTicketTitle,
  pickWinningSakseier,
  normalizeOurRef,
  normalizeFullNameForMatching,
  resolvePurchaser,
};
