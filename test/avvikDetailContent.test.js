'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getAvvikDetailContent, SKRIV_UT_SAK_LINK } = require('../src/avvikDetailContent');
const {
  IKKE_MOTTATT_FAKTURA_I_MEDIUS,
  INTERNBESTILLING,
  KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT,
  ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR,
  VAREFAKTURA_UNDER_BEHANDLING,
  SPESIELLE_CASER_FINANCE,
} = require('../src/discrepancyTypes');

function baseAvvik(overrides = {}) {
  return {
    id: 'test-1',
    orderId: 'SO-99001',
    articleNumber: 'ART-123',
    poNumber: '148001',
    daysWaiting: 25,
    purchaserName: 'Kari Nordmann',
    discrepancyType: IKKE_MOTTATT_FAKTURA_I_MEDIUS,
    ...overrides,
  };
}

test('Ikke mottatt faktura i Medius: with a PO number uses the non-manual wording', () => {
  const { summary, procedure } = getAvvikDetailContent(baseAvvik({ poNumber: '148001' }));
  assert.match(summary, /ikke har mottatt faktura i Medius/);
  assert.doesNotMatch(summary, /manuelle ordren/);
  assert.match(summary, /SO-99001/);
  assert.match(summary, /ART-123/);
  assert.match(summary, /25 dager/);
  assert.match(procedure, /Finance/);
});

test('Ikke mottatt faktura i Medius: without a PO number uses the manual-order wording', () => {
  const { summary } = getAvvikDetailContent(baseAvvik({ poNumber: null }));
  assert.match(summary, /denne manuelle ordren/);
  assert.match(summary, /ikke kjenner statusen på fakturaen/);
});

test('Kredittkort lisenskjøp: mentions days waiting and the Visma status change', () => {
  const avvik = baseAvvik({ discrepancyType: KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT, daysWaiting: 3 });
  const { summary, procedure } = getAvvikDetailContent(avvik);
  assert.match(summary, /3 dager/);
  assert.match(procedure, /Motta ikke bokfør/);
});

test('Internbestilling: uses days waiting and routes to Finance', () => {
  const avvik = baseAvvik({ discrepancyType: INTERNBESTILLING, daysWaiting: 7 });
  const { summary, procedure } = getAvvikDetailContent(avvik);
  assert.match(summary, /internbestilling/);
  assert.match(summary, /7 dager/);
  assert.match(procedure, /Finance/);
});

test('Varefaktura under behandling: includes SKU, order id, and days waiting', () => {
  const avvik = baseAvvik({ discrepancyType: VAREFAKTURA_UNDER_BEHANDLING, articleNumber: 'ART-777', orderId: 'SO-55', daysWaiting: 40 });
  const { summary, procedure } = getAvvikDetailContent(avvik);
  assert.match(summary, /ART-777/);
  assert.match(summary, /SO-55/);
  assert.match(summary, /40 dager/);
  assert.match(procedure, /Medius/);
});

test('Varefaktura under behandling: with a known invoice deviation, the procedure names the actual deviation', () => {
  const avvik = baseAvvik({
    discrepancyType: VAREFAKTURA_UNDER_BEHANDLING,
    articleNumber: 'ART-777',
    invoiceDeviations: ['Quantity deviation'],
  });
  const { procedure } = getAvvikDetailContent(avvik);
  assert.match(procedure, /Antallet på fakturaen avviker fra innkjøpsordre for ART-777/);
  assert.match(procedure, /legg igjen en kommentar i Medius/);
});

test('Varefaktura under behandling: with no known invoice deviation, falls back to the generic procedure', () => {
  const avvik = baseAvvik({ discrepancyType: VAREFAKTURA_UNDER_BEHANDLING, invoiceDeviations: [] });
  const { procedure } = getAvvikDetailContent(avvik);
  assert.match(procedure, /Gi Finance beskjed når eventuelle avvik på fakturaen er avklart/);
});

test('Ordre opprettet med feilaktig distributør: includes the Skriv ut-sak link', () => {
  const avvik = baseAvvik({ discrepancyType: ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR });
  const { summary, procedure, links } = getAvvikDetailContent(avvik);
  assert.match(summary, /feil distributør/);
  assert.match(procedure, /Skriv ut-sak/);
  assert.deepEqual(links, [SKRIV_UT_SAK_LINK]);
  assert.equal(links[0].href, 'https://publish.intility.com/nb-no/articles/4b7000f0-c3eb-481a-2e57-08db724e630d');
});

test('a type with no dedicated variant falls back to instructions.js text instead of throwing', () => {
  const avvik = baseAvvik({ discrepancyType: SPESIELLE_CASER_FINANCE, daysWaiting: 12 });
  const { summary, procedure, links } = getAvvikDetailContent(avvik);
  assert.match(summary, /Spesielle caser - Finance/);
  assert.match(summary, /12 dager/);
  assert.ok(procedure.length > 0);
  assert.deepEqual(links, []);
});

test('a completely unknown type still returns usable text, not a crash', () => {
  const avvik = baseAvvik({ discrepancyType: 'Noe helt nytt', daysWaiting: null });
  const { summary, procedure } = getAvvikDetailContent(avvik);
  assert.match(summary, /Noe helt nytt/);
  assert.ok(procedure.length > 0);
});
