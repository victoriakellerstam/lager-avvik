'use strict';

// dwhQueries.js's fetchAvvikRows query now resolves the purchaser name itself
// (case_owner - manual-order Vår ref, or the winning ticket's sakseier via a
// 7-tier ranking, see the query's PreferredTicket CTE). All that's left here
// is looking up an email address for that resolved name.

// Used both when building emailByFullName's keys and when looking a name up
// in it, so a case/whitespace difference between dwh's case_owner and the
// employee directory's full name doesn't silently fail to match.
function normalizeFullNameForMatching(name) {
  if (typeof name !== 'string') return '';
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * @param {string|null} caseOwner - the SQL query's case_owner value.
 * @param {Map<string, string>} emailByFullName - keyed by
 *   normalizeFullNameForMatching(fullName).
 * @returns {string|null}
 */
function resolvePurchaserEmail(caseOwner, emailByFullName) {
  if (!caseOwner) return null;
  return emailByFullName.get(normalizeFullNameForMatching(caseOwner)) || null;
}

module.exports = { normalizeFullNameForMatching, resolvePurchaserEmail };
