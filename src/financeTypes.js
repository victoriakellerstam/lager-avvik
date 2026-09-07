'use strict';

const { AVVIK_REVERSERING_TEST, SPESIELLE_CASER_FINANCE } = require('./discrepancyTypes');

// These discrepancy types are handled entirely by Finance, internally.
// A purchaser is never emailed about them, so the weekly job must skip them
// and the UI shows a resolution procedure instead of an email preview.
const FINANCE_ONLY_TYPES = new Set([SPESIELLE_CASER_FINANCE, AVVIK_REVERSERING_TEST]);

function isFinanceCase(discrepancyType) {
  return FINANCE_ONLY_TYPES.has(discrepancyType);
}

module.exports = { isFinanceCase };
