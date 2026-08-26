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
  const tiltak = getInstructions(avvik.discrepancyType).map((step, i) => `${i + 1}. ${step}`);

  return {
    to: avvik.purchaserEmail,
    subject: `Avvik på din ordre ${avvik.orderId}`,
    body: [
      `Hei ${avvik.purchaserName},`,
      '',
      `Avvik på din ordre ${avvik.orderId}.`,
      '',
      `Avviket gjelder: ${avvik.discrepancyType}.`,
      '',
      'Tiltak som kreves fra deg:',
      ...tiltak,
      '',
      'Dersom du har spørsmål, ta kontakt med Finance.',
      '',
      'Du mottar denne påminnelsen én gang i uken helt til avviket er markert som løst.',
      '',
      '(mockup - ingen ekte e-post er sendt)',
    ].join('\n'),
  };
}

module.exports = { ONE_WEEK_MS, needsNotification, buildEmailPreview };
