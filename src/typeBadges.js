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

// Bifrost background utility classes (bfc-*-bg) used to color-code the
// discrepancy type badge, roughly matching the internal scenario reference.
// An unlisted type falls back to "neutral".
const BADGE_CLASS = {
  [IKKE_MOTTATT_FAKTURA_I_MEDIUS]: 'warning',
  [INTERNBESTILLING]: 'brand',
  [KOSTNADSFAKTURA_REVERSER]: 'alert',
  [KOSTNADSFAKTURA_UNDER_BEHANDLING]: 'attn',
  [KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT]: 'alert',
  [MANUELL_ORDRE]: 'success',
  [ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR]: 'warning',
  [SPESIELLE_CASER_FINANCE]: 'theme',
  [VAREFAKTURA_UNDER_BEHANDLING]: 'attn',
};

const DEFAULT_BADGE_CLASS = 'neutral';

function getTypeBadgeClass(discrepancyType) {
  return BADGE_CLASS[discrepancyType] || DEFAULT_BADGE_CLASS;
}

module.exports = { getTypeBadgeClass, DEFAULT_BADGE_CLASS };
