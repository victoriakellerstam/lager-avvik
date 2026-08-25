'use strict';

const { runWeeklyJob } = require('./job');

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Real cadence would be weekly. There is no external cron dependency here on
// purpose - see README for why, and for the manual "/api/jobs/run-weekly"
// endpoint used to demo this without waiting a week.
function startScheduler() {
  const timer = setInterval(() => runWeeklyJob(), ONE_WEEK_MS);
  timer.unref();
  return timer;
}

module.exports = { startScheduler };
