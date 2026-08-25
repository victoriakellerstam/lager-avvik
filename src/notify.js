'use strict';

const { getInstructions } = require('./instructions');

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Pure decision logic: kept free of I/O so it is cheap to unit test.
function needsNotification(avvik, now = new Date()) {
  if (avvik.resolved) return false;
  if (!avvik.lastNotifiedAt) return true;
  const elapsed = now.getTime() - new Date(avvik.lastNotifiedAt).getTime();
  return elapsed >= ONE_WEEK_MS;
}

// Builds the email that WOULD be sent. Nothing here ever calls a mail provider.
function buildEmailPreview(avvik) {
  const steps = getInstructions(avvik.discrepancyType).map((step, i) => `${i + 1}. ${step}`);

  return {
    to: avvik.purchaserEmail,
    subject: `Avvik på ordre ${avvik.orderId} venter på oppfølging`,
    body: [
      `Hei ${avvik.purchaserName},`,
      '',
      `Ordre ${avvik.orderId} har et registrert avvik: «${avvik.discrepancyType}».`,
      '',
      'Slik rydder du opp i avviket:',
      ...steps,
      '',
      'Du mottar denne påminnelsen én gang i uken helt til avviket er markert som løst.',
      '',
      'Hilsen lager-avvik-varsling (mockup - ingen ekte e-post er sendt)',
    ].join('\n'),
  };
}

module.exports = { ONE_WEEK_MS, needsNotification, buildEmailPreview };
