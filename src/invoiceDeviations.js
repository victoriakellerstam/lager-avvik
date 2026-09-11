'use strict';

// Norwegian description fragment per medius_order_deviations.deviation_name
// value (see dwhQueries.js's fetchOrderDeviations) - used to build the
// email's fix instruction for Varefaktura — under behandling avvik. Each
// fragment slots into "<fragment> på fakturaen avviker fra innkjøpsordre for
// <article_code>."
const DEVIATION_DESCRIPTIONS = new Map([
  ['Line amount additional charge deviation', 'linjebeløpet (tilleggskostnad)'],
  ['Unit price additional charge deviation', 'enhetsprisen (tilleggskostnad)'],
  ['Total amount deviation', 'totalbeløpet'],
  ['Quantity deviation', 'antallet'],
  ['Unit price deviation', 'enhetsprisen'],
  ['Line amount deviation', 'linjebeløpet'],
]);

function joinNorwegian(parts) {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} og ${parts[parts.length - 1]}`;
}

/**
 * @param {string[]|undefined} deviationNames - raw deviation_name values found
 *   for this avvik's order+article (see avvikSync.js).
 * @param {string} articleCode
 * @returns {string|null} a ready-to-use Norwegian sentence, or null if there's
 *   nothing recognized to report (falls back to the generic instruction).
 */
function describeInvoiceDeviations(deviationNames, articleCode) {
  if (!deviationNames || deviationNames.length === 0) return null;
  const parts = deviationNames.map((name) => DEVIATION_DESCRIPTIONS.get(name)).filter(Boolean);
  if (parts.length === 0) return null;

  const joined = joinNorwegian(parts);
  const capitalized = joined.charAt(0).toUpperCase() + joined.slice(1);
  return `${capitalized} på fakturaen avviker fra innkjøpsordre for ${articleCode}. Gi beskjed til Finance og legg igjen en kommentar i Medius om avviket er i orden.`;
}

module.exports = { describeInvoiceDeviations, DEVIATION_DESCRIPTIONS };
