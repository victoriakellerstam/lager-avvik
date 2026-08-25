'use strict';

const http = require('node:http');
const store = require('./store');
const { runWeeklyJob } = require('./job');
const { startScheduler } = require('./scheduler');
const { renderDashboard } = require('./dashboard');

const PORT = process.env.PORT || 8080;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function createServer() {
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendJson(res, 400, { error: 'bad request' });
    }
    const { pathname } = url;

    try {
      if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, { status: 'ok' });
      }

      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderDashboard(store.listAvvik(), store.listNotifications()));
      }

      if (req.method === 'GET' && pathname === '/api/avvik') {
        return sendJson(res, 200, store.listAvvik());
      }

      const resolveMatch = pathname.match(/^\/api\/avvik\/(\d+)\/resolve$/);
      if (req.method === 'POST' && resolveMatch) {
        const updated = store.resolveAvvik(Number(resolveMatch[1]));
        if (!updated) return sendJson(res, 404, { error: 'avvik not found' });
        return sendJson(res, 200, updated);
      }

      if (req.method === 'GET' && pathname === '/api/notifications') {
        return sendJson(res, 200, store.listNotifications());
      }

      if (req.method === 'POST' && pathname === '/api/jobs/run-weekly') {
        const sent = runWeeklyJob(new Date());
        return sendJson(res, 200, { simulatedEmailsSent: sent.length, notifications: sent });
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch {
      return sendJson(res, 500, { error: 'internal error' });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`lager-avvik listening on port ${PORT}`);
  });
  startScheduler();
}

module.exports = { createServer };
