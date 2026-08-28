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

// The real scenario catalog (SCENARIOER OG ANBEFALTE TILTAK). Keyed on the
// exact discrepancyType string on the avvik. Unknown types fall back to
// DEFAULT_STEPS so the email template never ends up without guidance.
const INSTRUCTIONS = {
  [IKKE_MOTTATT_FAKTURA_I_MEDIUS]: [
    'Sjekk om fakturaen er sendt til riktig fakturaadresse/referanse.',
    'Be leverandøren sende fakturaen på nytt hvis den ikke finnes hos dem.',
    'Følg opp at fakturaen blir registrert i Medius.',
  ],
  [INTERNBESTILLING]: [
    'Avklar om varene skal skrives ut eller videreselges internt.',
    'Fullfør uttaket eller videresalget av varene.',
    'Be om at innkjøpsordren slettes i Visma når dette er gjort.',
  ],
  [KOSTNADSFAKTURA_REVERSER]: [
    'Reverser kostnadsfakturaen.',
    'Før beløpet mot riktig innkjøpsordre.',
    'Bekreft at reverseringen er registrert korrekt.',
  ],
  [KOSTNADSFAKTURA_UNDER_BEHANDLING]: [
    'Undersøk fakturaen i Medius - den er registrert som kostnadsfaktura, men ikke ferdigbehandlet.',
    'Vurder om den bør reverseres og føres på nytt mot innkjøpsordren.',
    'Følg opp saken til status i Medius er avklart.',
  ],
  [KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT]: [
    'Sjekk kredittkortbelastningen mot lisenskjøpet.',
    'Korriger registreringen slik at den ikke lenger står som mottatt via ordren.',
    'Meld fra til Finance om korrigeringen.',
  ],
  [MANUELL_ORDRE]: [
    'Finn eller be om fakturaen som hører til den manuelle ordren.',
    'Match fakturaen mot ordren som ble opprettet uten PO-nummer.',
    'Send fakturaen videre til godkjenning.',
  ],
  [ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR]: [
    'Identifiser riktig distributør for bestillingen.',
    'Korriger distributøren på ordren.',
    'Bekreft med leverandøren at endringen er registrert.',
  ],
  [SPESIELLE_CASER_FINANCE]: [
    'Ta kontakt med Finance for videre håndtering av denne saken.',
    'Følg opp saken til Finance bekrefter at den er løst.',
  ],
  [VAREFAKTURA_UNDER_BEHANDLING]: [
    'Sjekk status på fakturaen i godkjenningsflyten i Medius.',
    'Følg opp godkjenner hvis fakturaen har stått lenge under behandling.',
    'Bekreft når fakturaen er godkjent og bokført.',
  ],
};

const DEFAULT_STEPS = [
  'Undersøk avviket og avklar med relevant leverandør eller avdeling.',
  'Registrer det som blir avklart i ordresystemet.',
  'Marker avviket som løst her når det er ryddet opp i.',
];

function getInstructions(discrepancyType) {
  return INSTRUCTIONS[discrepancyType] || DEFAULT_STEPS;
}

module.exports = { getInstructions, DEFAULT_STEPS, INSTRUCTIONS };
