'use strict';

const { needsNotification, buildEmailPreview } = require('./notify');
const store = require('./store');

// Runs the "who needs a nudge this week" pass. Simulated only: it records a
// preview instead of calling any email provider.
function runWeeklyJob(now = new Date()) {
  const sent = [];
  for (const avvik of store.listAvvik()) {
    if (needsNotification(avvik, now)) {
      const preview = buildEmailPreview(avvik);
      sent.push(store.recordNotification(avvik, preview, now));
    }
  }
  return sent;
}

module.exports = { runWeeklyJob };
