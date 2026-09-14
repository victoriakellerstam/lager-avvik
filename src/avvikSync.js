'use strict';

const crypto = require('crypto');
const dwhQueries = require('./dwhQueries');
const { mapDeviationScenario } = require('./scenario');
const { normalizeFullNameForMatching, resolvePurchaserEmail } = require('./purchaser');

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

// medius_order_deviations.purchase_order is the bestillingsnummer
// (order_number/supplier_order_number), NOT the po_number every other Medius
// table in this pipeline joins on - a different key, confirmed directly by
// the user. article_code is included as a double-check that a deviation
// found for the order is actually on the same line the avvik was raised on.
function buildOrderDeviationKey(orderId, articleNumber) {
  return [orderId, articleNumber].map((v) => String(v ?? '').trim().toLowerCase()).join(':');
}

// 'Ja' once this category alone accounts for everything received; 'Delvis'
// once it accounts for some but not all - including whenever the *other*
// category also has units, per the user's explicit call: Videresolgt and
// Skrevet ut av lager are never both 'Ja' at once, even if together they add
// up to totalQuantity. null (hide the card) when this category has nothing.
function classifyOutgoingStatus(quantity, otherCategoryQuantity, totalQuantity) {
  if (quantity <= 0) return null;
  if (otherCategoryQuantity > 0) return 'Delvis';
  return quantity >= totalQuantity ? 'Ja' : 'Delvis';
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

  return {
    totalQuantity,
    resoldQuantity,
    writtenOffQuantity,
    resoldStatus: classifyOutgoingStatus(resoldQuantity, writtenOffQuantity, totalQuantity),
    writtenOffStatus: classifyOutgoingStatus(writtenOffQuantity, resoldQuantity, totalQuantity),
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
  const stockMovementByLot = await dwhQueries.fetchStockMovementBreakdownByLot();
  const orderDeviations = await dwhQueries.fetchOrderDeviations();

  const emailByFullName = new Map(
    intilityUsers.map((u) => [normalizeFullNameForMatching(u.user_full_name), u.email])
  );
  const departmentByFullName = new Map(
    intilityUsers.map((u) => [normalizeFullNameForMatching(u.user_full_name), u.department])
  );
  const departmentNameByNumber = new Map(departments.map((d) => [d.department_number, d.department_name]));
  const mediusInfoByKey = new Map(
    mediusLinks.map((m) => [
      buildMediusLinkKey(m.visma_purchase_order, m.article_code, m.supplier_id),
      { invoiceNumber: m.invoice_number, mediusLink: m.medius_link },
    ])
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
    const mediusInfo = mediusInfoByKey.get(
      buildMediusLinkKey(row.po_number, row.article_number, row.supplier_id_text)
    );
    const stockBreakdown = resolveStockBreakdown(row.lot_number, stockBreakdownByLot);

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

module.exports = { syncAvvikFromDwh, resolveDepartmentForPurchaser, resolveStockBreakdown, classifyOutgoingStatus };
