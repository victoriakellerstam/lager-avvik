'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mapDeviationScenario } = require('../src/scenario');
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
} = require('../src/discrepancyTypes');

test('mapDeviationScenario: each real SQL deviation_scenario value maps to its app-level discrepancyType', () => {
  assert.equal(mapDeviationScenario('Internbestilling'), INTERNBESTILLING);
  assert.equal(mapDeviationScenario('Manuell ordre'), MANUELL_ORDRE);
  assert.equal(mapDeviationScenario('Kredittkort lisenskjøp, feilaktig mottak'), KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT);
  assert.equal(mapDeviationScenario('Ordre opprettet med feilaktig distributør'), ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR);
  assert.equal(mapDeviationScenario('Ikke mottatt faktura i Medius'), IKKE_MOTTATT_FAKTURA_I_MEDIUS);
  assert.equal(mapDeviationScenario('Varefaktura — under behandling'), VAREFAKTURA_UNDER_BEHANDLING);
  assert.equal(mapDeviationScenario('Spesielle caser - Finance'), SPESIELLE_CASER_FINANCE);
});

test('mapDeviationScenario: "via bestnr" and direct cost-invoice variants collapse onto the same two buckets', () => {
  assert.equal(mapDeviationScenario('Kostnadsfaktura via bestnr — reverser'), KOSTNADSFAKTURA_REVERSER);
  assert.equal(mapDeviationScenario('Kostnadsfaktura — reverser'), KOSTNADSFAKTURA_REVERSER);
  assert.equal(mapDeviationScenario('Kostnadsfaktura via bestnr — følg opp'), KOSTNADSFAKTURA_UNDER_BEHANDLING);
  assert.equal(mapDeviationScenario('Kostnadsfaktura — under behandling'), KOSTNADSFAKTURA_UNDER_BEHANDLING);
});

test('mapDeviationScenario: "OK" outcomes are not real avvik and map to null', () => {
  assert.equal(mapDeviationScenario('Varefaktura — OK'), null);
  assert.equal(mapDeviationScenario('Varefaktura — OK, makulert'), null);
});

test('mapDeviationScenario: an unrecognized value maps to null rather than throwing', () => {
  assert.equal(mapDeviationScenario('Noe helt annet'), null);
  assert.equal(mapDeviationScenario(null), null);
});
