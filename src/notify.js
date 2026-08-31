'use strict';

const { getInstructions } = require('./instructions');
const { isFinanceCase } = require('./financeTypes');

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Pure decision logic: kept free of I/O so it is cheap to unit test.
function needsNotification(avvik, now = new Date()) {
  if (avvik.resolved) return false;
  // Finance-only cases are never emailed to the purchaser - Finance handles
  // these internally.
  if (isFinanceCase(avvik.discrepancyType)) return false;
  if (!avvik.lastNotifiedAt) return true;
  const elapsed = now.getTime() - new Date(avvik.lastNotifiedAt).getTime();
  return elapsed >= ONE_WEEK_MS;
}

// Builds the email that WOULD be sent. Nothing here ever calls a mail provider.
function buildEmailPreview(avvik) {
  const fixText = getInstructions(avvik.discrepancyType);

  return {
    to: avvik.purchaserEmail,
    subject: `Avvik på ordre med innkjøpsordrenummer ${avvik.orderId}, SKU ${avvik.articleNumber}`,
    body: [
      `Avviket gjelder at ${avvik.discrepancyType}. Denne ordrelinjen har ligget med status som mottatt i Visma i ${avvik.daysWaiting} dager. For å fikse opp i avviket: ${fixText}. Dersom du har spørsmål, svar på denne mailen eller ta kontakt med Finance på Teams.`,
      '',
      '(mockup - ingen ekte e-post er sendt)',
    ].join('\n'),
  };
}

module.exports = { ONE_WEEK_MS, needsNotification, buildEmailPreview };
