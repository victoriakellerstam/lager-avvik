'use strict';

// Bifrost background utility classes (bfc-*-bg) used to color-code the
// discrepancy type badge, roughly matching the internal scenario reference.
// An unlisted type falls back to "neutral".
const BADGE_CLASS = {
  'Ikke mottatt faktura i Medius': 'warning',
  Internbestilling: 'brand',
  'Kostnadsfaktura — reverser': 'alert',
  'Kredittkort lisenskjøp, feilaktig mottatt': 'alert',
  'Manuell ordre': 'success',
  'Ordre opprettet med feilaktig distributør': 'warning',
  'Spesielle caser - Finance': 'theme',
  'Varefaktura — under behandling': 'attn',
};

const DEFAULT_BADGE_CLASS = 'neutral';

function getTypeBadgeClass(discrepancyType) {
  return BADGE_CLASS[discrepancyType] || DEFAULT_BADGE_CLASS;
}

module.exports = { getTypeBadgeClass, DEFAULT_BADGE_CLASS };
