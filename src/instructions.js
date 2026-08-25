'use strict';

// What the purchaser should actually do, per discrepancy type. Keyed on the
// exact discrepancyType string on the avvik. Unknown types fall back to
// DEFAULT_STEPS so the email template never ends up without guidance.
const INSTRUCTIONS = {
  'Feil antall levert': [
    'Tell opp hva som faktisk kom inn på lager og sammenlign med ordrebekreftelsen.',
    'Registrer det avvikende antallet i ordresystemet.',
    'Kontakt leverandøren for å avklare om resten kommer i egen forsendelse, eller om ordren skal krediteres.',
  ],
  'Feil pris fakturert': [
    'Sammenlign fakturert pris med prisen i bestillingen eller avtalen.',
    'Meld avviket til leverandøren og be om kreditnota eller korrigert faktura.',
    'Oppdater ordren når korrigert faktura er mottatt.',
  ],
  'Mangler kvittering': [
    'Sjekk om kvitteringen har kommet på e-post eller i leverandørportalen.',
    'Be leverandøren om en kopi av kvitteringen hvis den ikke finnes.',
    'Legg kvitteringen ved ordren når den er mottatt.',
  ],
  'Feil varenummer': [
    'Sjekk varenummeret på den fysiske varen mot det som står på ordrelinjen.',
    'Korriger varenummeret i ordresystemet.',
    'Gi lager beskjed slik at varen kan plasseres på riktig lagerplass.',
  ],
  'Feil leveringsadresse': [
    'Bekreft riktig leveringsadresse med mottaker.',
    'Oppdater leveringsadressen på ordren.',
    'Gi beskjed til lager/logistikk om at varen må omadresseres eller hentes på nytt.',
  ],
  'Dobbel fakturering': [
    'Sjekk om samme ordre er fakturert to ganger.',
    'Meld avviket til leverandøren og be om kreditnota for den doble fakturaen.',
    'Bekreft at kreditnotaen er registrert riktig når den er mottatt.',
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

module.exports = { getInstructions, DEFAULT_STEPS };
