'use strict';

// The single canonical source for the 8 discrepancyType strings (the real
// scenario catalog, SCENARIOER OG ANBEFALTE TILTAK). Previously these exact
// strings (including the em-dashes) were re-typed independently in
// typeBadges.js, instructions.js, and financeTypes.js - a typo in any one of
// them would silently fall through to a default badge/steps/routing instead
// of erroring, which matters once discrepancyType starts coming from a real
// data pipeline (src/scenario.js) instead of a human typing a literal.
const IKKE_MOTTATT_FAKTURA_I_MEDIUS = 'Ikke mottatt faktura i Medius';
const INTERNBESTILLING = 'Internbestilling';
const KOSTNADSFAKTURA_REVERSER = 'Kostnadsfaktura — reverser';
const KOSTNADSFAKTURA_UNDER_BEHANDLING = 'Kostnadsfaktura — under behandling';
const KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT = 'Kredittkort lisenskjøp, feilaktig mottatt';
const MANUELL_ORDRE = 'Manuell ordre';
const ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR = 'Ordre opprettet med feilaktig distributør';
const SPESIELLE_CASER_FINANCE = 'Spesielle caser - Finance';
const VAREFAKTURA_UNDER_BEHANDLING = 'Varefaktura — under behandling';

const ALL_DISCREPANCY_TYPES = [
  IKKE_MOTTATT_FAKTURA_I_MEDIUS,
  INTERNBESTILLING,
  KOSTNADSFAKTURA_REVERSER,
  KOSTNADSFAKTURA_UNDER_BEHANDLING,
  KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT,
  MANUELL_ORDRE,
  ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR,
  SPESIELLE_CASER_FINANCE,
  VAREFAKTURA_UNDER_BEHANDLING,
];

module.exports = {
  IKKE_MOTTATT_FAKTURA_I_MEDIUS,
  INTERNBESTILLING,
  KOSTNADSFAKTURA_REVERSER,
  KOSTNADSFAKTURA_UNDER_BEHANDLING,
  KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT,
  MANUELL_ORDRE,
  ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR,
  SPESIELLE_CASER_FINANCE,
  VAREFAKTURA_UNDER_BEHANDLING,
  ALL_DISCREPANCY_TYPES,
};
