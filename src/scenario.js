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

// dwhQueries.js's fetchAvvikRows query now computes the full classification
// in SQL (deviation_scenario) - this is just the mapping from its exact
// output strings onto this app's smaller discrepancyType enum. The DAX-based
// index/classification logic this file used to contain (matching PO+supplier
// +article across Medius tables in JS) has moved into that SQL query.
//
// "Kostnadsfaktura via bestnr" vs "Kostnadsfaktura" (direct) are a real
// distinction in the SQL (matched via the Medius connection bridge vs
// matched straight on the PO), collapsed here onto the same two app-level
// buckets, per the same simplification agreed with the user for the
// previous JS-side implementation.
const DEVIATION_SCENARIO_TO_DISCREPANCY_TYPE = new Map([
  ['Internbestilling', INTERNBESTILLING],
  ['Manuell ordre', MANUELL_ORDRE],
  ['Kredittkort lisenskjøp, feilaktig mottak', KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT],
  ['Ordre opprettet med feilaktig distributør', ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR],
  ['Ikke mottatt faktura i Medius', IKKE_MOTTATT_FAKTURA_I_MEDIUS],
  ['Kostnadsfaktura via bestnr — reverser', KOSTNADSFAKTURA_REVERSER],
  ['Kostnadsfaktura via bestnr — følg opp', KOSTNADSFAKTURA_UNDER_BEHANDLING],
  ['Kostnadsfaktura — reverser', KOSTNADSFAKTURA_REVERSER],
  ['Kostnadsfaktura — under behandling', KOSTNADSFAKTURA_UNDER_BEHANDLING],
  ['Varefaktura — under behandling', VAREFAKTURA_UNDER_BEHANDLING],
  ['Spesielle caser - Finance', SPESIELLE_CASER_FINANCE],
  // 'Varefaktura — OK, makulert' and 'Varefaktura — OK' are intentionally
  // absent - the invoice is fine, so these aren't real avvik at all (matches
  // the same exclusion decision made for the previous JS-side classifier).
]);

/**
 * @param {string} deviationScenario - the SQL query's deviation_scenario value.
 * @returns {string|null} one of the discrepancyTypes.js constants, or null if
 *   this row is not actually an avvik and should be excluded from the feed.
 */
function mapDeviationScenario(deviationScenario) {
  return DEVIATION_SCENARIO_TO_DISCREPANCY_TYPE.get(deviationScenario) || null;
}

module.exports = { mapDeviationScenario };
