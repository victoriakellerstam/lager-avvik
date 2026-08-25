'use strict';

// The real scenario catalog (SCENARIOER OG ANBEFALTE TILTAK). Keyed on the
// exact discrepancyType string on the avvik. Unknown types fall back to
// DEFAULT_STEPS so the email template never ends up without guidance.
const INSTRUCTIONS = {
  'Ikke mottatt faktura i Medius': [
    'Sjekk om fakturaen er sendt til riktig fakturaadresse/referanse.',
    'Be leverandøren sende fakturaen på nytt hvis den ikke finnes hos dem.',
    'Følg opp at fakturaen blir registrert i Medius.',
  ],
  Internbestilling: [
    'Avklar om varene skal skrives ut eller videreselges internt.',
    'Fullfør uttaket eller videresalget av varene.',
    'Be om at innkjøpsordren slettes i Visma når dette er gjort.',
  ],
  'Kostnadsfaktura — reverser': [
    'Reverser kostnadsfakturaen.',
    'Før beløpet mot riktig innkjøpsordre.',
    'Bekreft at reverseringen er registrert korrekt.',
  ],
  'Kredittkort lisenskjøp, feilaktig mottatt': [
    'Sjekk kredittkortbelastningen mot lisenskjøpet.',
    'Korriger registreringen slik at den ikke lenger står som mottatt via ordren.',
    'Meld fra til Finance om korrigeringen.',
  ],
  'Manuell ordre': [
    'Finn eller be om fakturaen som hører til den manuelle ordren.',
    'Match fakturaen mot ordren som ble opprettet uten PO-nummer.',
    'Send fakturaen videre til godkjenning.',
  ],
  'Ordre opprettet med feilaktig distributør': [
    'Identifiser riktig distributør for bestillingen.',
    'Korriger distributøren på ordren.',
    'Bekreft med leverandøren at endringen er registrert.',
  ],
  'Spesielle caser - Finance': [
    'Ta kontakt med Finance for videre håndtering av denne saken.',
    'Følg opp saken til Finance bekrefter at den er løst.',
  ],
  'Varefaktura — under behandling': [
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
