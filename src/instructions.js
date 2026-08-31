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

// One instruction sentence per scenario, given directly by the user for the
// email template (see notify.js's buildEmailPreview) - keyed on the exact
// discrepancyType string on the avvik. Unknown types fall back to
// DEFAULT_INSTRUCTION so the email template never ends up without guidance.
// Internbestilling's text is intentionally just "..." - the user hasn't
// decided what should go there yet.
const INSTRUCTIONS = {
  [IKKE_MOTTATT_FAKTURA_I_MEDIUS]:
    'Ingen faktura i Medius - send oppdatering til Finance om fakturanummer eller hør med distributør om hva som er status på faktura',
  [INTERNBESTILLING]: '...',
  [KOSTNADSFAKTURA_REVERSER]: 'Send informasjon om fakturaen til Finance',
  [KOSTNADSFAKTURA_UNDER_BEHANDLING]: 'Send informasjon om fakturaen til Finance',
  [KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT]:
    'Kredittkort lisenskjøp, feilaktig mottak. Dersom kunde allerede er fakturert, endre status på ordre i Visma til "Motta ikke bokfør"',
  [MANUELL_ORDRE]: 'Gi beskjed til Finance om hva som er status på faktura',
  [ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR]:
    'Opprett Skriv ut-sak til Logistikk og sett status på ordre til "Motta ikke bokfør"',
  [SPESIELLE_CASER_FINANCE]: 'Ta kontakt med Finance for videre håndtering av denne saken.',
  [VAREFAKTURA_UNDER_BEHANDLING]: 'Faktura må behandles. Gi beskjed til Finance om avvik på faktura er i orden',
};

const DEFAULT_INSTRUCTION = 'Undersøk avviket og avklar med relevant leverandør eller avdeling';

function getInstructions(discrepancyType) {
  return INSTRUCTIONS[discrepancyType] || DEFAULT_INSTRUCTION;
}

module.exports = { getInstructions, DEFAULT_INSTRUCTION, INSTRUCTIONS };
