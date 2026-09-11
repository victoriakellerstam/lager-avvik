'use strict';

const {
  IKKE_MOTTATT_FAKTURA_I_MEDIUS,
  INTERNBESTILLING,
  KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT,
  ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR,
  VAREFAKTURA_UNDER_BEHANDLING,
} = require('./discrepancyTypes');
const { getInstructions } = require('./instructions');
const { describeInvoiceDeviations } = require('./invoiceDeviations');

const TEAMS_CONTACT = 'Dersom du har spørsmål, kan du kontakte Finance på Teams.';

const SKRIV_UT_SAK_LINK = {
  href: 'https://publish.intility.com/nb-no/articles/4b7000f0-c3eb-481a-2e57-08db724e630d',
  label: 'Slik oppretter du en Skriv ut-sak',
};

// "Ikke mottatt faktura i Medius" has two wordings depending on whether the
// underlying order is a manual one. discrepancyType itself can't be the
// signal here - MANUELL_ORDRE is already a separate, mutually exclusive
// discrepancyType (see discrepancyTypes.js/scenario.js), so a row classified
// as IKKE_MOTTATT_FAKTURA_I_MEDIUS is never also MANUELL_ORDRE. Instead this
// reuses the system's existing manual-order signal: dashboard.js's
// renderDetailRow already treats a missing poNumber as "this is a manual
// order" (manual orders have no PO number at all).
function ikkeMottattFakturaSummary(avvik) {
  const isManual = !avvik.poNumber;
  const intro = isManual
    ? `Avviket gjelder at vi ikke kjenner statusen på fakturaen for SKU ${avvik.articleNumber} i innkjøp ${avvik.orderId} for denne manuelle ordren.`
    : `Avviket gjelder at vi ikke har mottatt faktura i Medius for SKU ${avvik.articleNumber} i innkjøp ${avvik.orderId}.`;
  return `${intro} Ordrelinjen har hatt status som mottatt i Visma i ${avvik.daysWaiting} dager.`;
}

const DETAIL_CONTENT = {
  [IKKE_MOTTATT_FAKTURA_I_MEDIUS]: {
    summary: ikkeMottattFakturaSummary,
    procedure: () =>
      `For å løse avviket må du sende en oppdatering til Finance med fakturanummeret, eller kontakte distributøren for å undersøke status på fakturaen. ${TEAMS_CONTACT}`,
    links: [],
  },
  [KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT]: {
    summary: (avvik) =>
      `Avviket gjelder et kredittkortkjøp som feilaktig er registrert som mottatt. Det er ${avvik.daysWaiting} dager siden mottaket ble registrert.`,
    procedure: () =>
      `Dersom kunden allerede er fakturert, skal ordrestatusen i Visma endres til «Motta ikke bokfør». ${TEAMS_CONTACT}`,
    links: [],
  },
  [INTERNBESTILLING]: {
    summary: (avvik) => `Avviket gjelder en ordrelinje i en internbestilling som ble mottatt for ${avvik.daysWaiting} dager siden.`,
    procedure: () => `Gi Finance beskjed om statusen på artikkelen i ordren, slik at saken kan behandles videre. ${TEAMS_CONTACT}`,
    links: [],
  },
  [VAREFAKTURA_UNDER_BEHANDLING]: {
    summary: (avvik) =>
      `Avviket gjelder ordrelinjen for SKU ${avvik.articleNumber} i innkjøpsordre ${avvik.orderId}. Det er ${avvik.daysWaiting} dager siden mottaket ble registrert.`,
    // medius_order_deviations forteller nøyaktig hva som avviker mellom
    // faktura og innkjøpsordre (antall/enhetspris/linjebeløp/totalbeløp) -
    // når det er kjent, er det langt mer nyttig enn den generiske
    // "gi beskjed når avklart"-teksten. Faller tilbake til den generiske
    // teksten når ingen kjent deviation_name er funnet for linjen.
    procedure: (avvik) => {
      const deviationText = describeInvoiceDeviations(avvik.invoiceDeviations, avvik.articleNumber);
      const action = deviationText || 'Gi Finance beskjed når eventuelle avvik på fakturaen er avklart.';
      return `Fakturaen ligger åpen i Medius og må behandles. ${action} ${TEAMS_CONTACT}`;
    },
    links: [],
  },
  [ORDRE_OPPRETTET_MED_FEILAKTIG_DISTRIBUTOR]: {
    summary: (avvik) =>
      `Det er registrert et avvik på innkjøpsordre ${avvik.orderId} for SKU ${avvik.articleNumber}. Ordren er opprettet med feil distributør, og det er ${avvik.daysWaiting} dager siden mottaket ble registrert.`,
    procedure: () =>
      `For å løse avviket må du først opprette en Skriv ut-sak til Logistikk. Se Publish-artikkelen for fremgangsmåte. Deretter skal statusen på ordrelinjen endres fra «Mottatt senere bokføring» til «Motta ikke bokfør». ${TEAMS_CONTACT}`,
    links: [SKRIV_UT_SAK_LINK],
  },
};

// Types with no dedicated variant here (the Finance-only types, handled on
// their own page via renderFinanceRow, never reach this - but this stays
// total rather than throwing, in case someone opens /avvik/:id directly for
// one) fall back to instructions.js's per-type text, which already covers
// every discrepancyType plus a default.
function getAvvikDetailContent(avvik) {
  const entry = DETAIL_CONTENT[avvik.discrepancyType];
  if (entry) {
    return { summary: entry.summary(avvik), procedure: entry.procedure(avvik), links: entry.links };
  }
  return {
    summary: `Avviket er av typen «${avvik.discrepancyType}» og har ventet i ${avvik.daysWaiting ?? 'ukjent antall'} dager.`,
    procedure: getInstructions(avvik.discrepancyType),
    links: [],
  };
}

module.exports = { getAvvikDetailContent, SKRIV_UT_SAK_LINK };
