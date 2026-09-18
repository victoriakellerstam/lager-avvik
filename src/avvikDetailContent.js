'use strict';

const {
  IKKE_MOTTATT_FAKTURA_I_MEDIUS,
  INTERNBESTILLING,
  KOSTNADSFAKTURA_REVERSER,
  KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT,
  MANUELL_ORDRE,
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

// The first Internbestilling point depends on the same stock-status fields
// as the nøkkeltall boxes (resoldStatus/writtenOffStatus/quantities - see
// avvikSync.js's resolveStockBreakdown): writtenOffStatus 'Ja' can only occur
// when resoldStatus is null (isFullyWrittenOff), so checking it first and
// then resoldStatus covers every combination with real stock data. No stock
// data at all (both null) falls back to the original generic wording.
function internbestillingFirstPoint(avvik) {
  if (avvik.writtenOffStatus === 'Ja') {
    return `Endre status i Visma til «Motta og ikke bokfør» ettersom hele antallet av SKU ${avvik.articleNumber} er skrevet ut av lager.`;
  }
  if (avvik.resoldStatus === 'Ja' || avvik.resoldStatus === 'Nei') {
    return 'Innkjøpsordrelinjen er ikke tilknyttet en faktura. Oppgi fakturanummeret til Finance, eller kontakt distributøren for å undersøke status på faktura.';
  }
  if (avvik.resoldStatus === 'Delvis') {
    return 'Gi beskjed til Finance om det resterende antallet skal brukes internt eller om det skal skrives ut av lager.';
  }
  return 'Gi Finance beskjed om statusen på artikkelen i ordren, slik at saken kan behandles videre.';
}

const DETAIL_CONTENT = {
  [IKKE_MOTTATT_FAKTURA_I_MEDIUS]: {
    summary: ikkeMottattFakturaSummary,
    procedure: () =>
      `For å løse avviket må du sende en oppdatering til Finance med fakturanummeret, eller kontakte distributøren for å undersøke status på fakturaen. ${TEAMS_CONTACT}`,
    links: [],
  },
  [MANUELL_ORDRE]: {
    summary: (avvik) =>
      `Avviket er av typen «${MANUELL_ORDRE}» og har ventet i ${avvik.daysWaiting ?? 'ukjent antall'} dager.`,
    procedure: () =>
      'Ordren ligger fortsatt åpen ettersom vi ikke har mottatt en faktura i Medius som kan knyttes til innkjøpsordren. Gi beskjed til Finance dersom du har mottatt fakturaen, slik at den manuelle ordren kan matches mot en leverandørfaktura.',
    links: [],
  },
  [KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT]: {
    summary: (avvik) =>
      `Avviket gjelder et kredittkortkjøp som feilaktig er registrert som mottatt. Det er ${avvik.daysWaiting} dager siden mottaket ble registrert.`,
    // Videresolgt = 'Ja' means the customer is already invoiced, so the
    // order can be closed out now; 'Nei'/'Delvis' (or unknown) means that
    // hasn't happened yet, so the procedure is to wait for it first.
    procedure: (avvik) =>
      avvik.resoldStatus === 'Ja'
        ? 'Ettersom lisensen er videresolgt og kunden er fakturert, skal ordrestatusen i Visma endres til «Motta og ikke bokfør».'
        : 'Vent til kunden er fakturert, og endre deretter ordrestatusen i Visma til «Motta og ikke bokfør».',
    links: [],
  },
  [INTERNBESTILLING]: {
    summary: (avvik) => `Avviket gjelder en ordrelinje i en internbestilling som ble mottatt for ${avvik.daysWaiting} dager siden.`,
    procedure: (avvik) => `${internbestillingFirstPoint(avvik)} ${TEAMS_CONTACT}`,
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

// A fixed, always-true fact for a discrepancyType (not per-avvik data) shown
// as its own box on the detail page (see dashboard.js's renderAvvikDetailPage)
// - most types have none. Kostnadsfaktura — reverser always means Finance
// already found a matching archived cost invoice; the box states that
// up front rather than burying it in the procedure text.
const DETAIL_NOTES = {
  [KOSTNADSFAKTURA_REVERSER]: 'Det finnes en arkivert kostnadsfaktura på samme PO-nummer og leverandør i Medius.',
};

// Types with no dedicated variant here - including the Finance-only types,
// reached via renderFinanceRow's "Mer informasjon" button - fall back to
// instructions.js's per-type text, which already covers every
// discrepancyType plus a default.
function getAvvikDetailContent(avvik) {
  const entry = DETAIL_CONTENT[avvik.discrepancyType];
  const note = DETAIL_NOTES[avvik.discrepancyType] || null;
  if (entry) {
    return { summary: entry.summary(avvik), procedure: entry.procedure(avvik), links: entry.links, note };
  }
  return {
    summary: `Avviket er av typen «${avvik.discrepancyType}» og har ventet i ${avvik.daysWaiting ?? 'ukjent antall'} dager.`,
    procedure: getInstructions(avvik.discrepancyType),
    links: [],
    note,
  };
}

module.exports = { getAvvikDetailContent, SKRIV_UT_SAK_LINK };
