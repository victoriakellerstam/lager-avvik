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

  const emailByFullName = new Map(
    intilityUsers.map((u) => [normalizeFullNameForMatching(u.user_full_name), u.email])
  );

  const avvikRows = [];
  for (const row of rows) {
    const discrepancyType = mapDeviationScenario(row.deviation_scenario);
    if (discrepancyType === null) continue;

    const purchaserName = row.case_owner || null;
    const purchaserEmail = resolvePurchaserEmail(purchaserName, emailByFullName);

    avvikRows.push({
      id: buildSyntheticId(row),
      orderId: row.supplier_order_number,
      articleNumber: row.article_number,
      purchaserName,
      purchaserEmail,
      discrepancyType,
      createdAt: toIso(row.order_date),
      daysWaiting: row.days_waiting,
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

module.exports = { syncAvvikFromDwh };
