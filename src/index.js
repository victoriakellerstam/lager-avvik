'use strict';

const http = require('node:http');
const store = require('./store');
const { runWeeklyJob } = require('./job');
const { buildEmailPreview } = require('./notify');
const { testConnection } = require('./dwh');
const { syncAvvikFromDwh } = require('./avvikSync');
const { startScheduler } = require('./scheduler');
const { renderDashboard } = require('./dashboard');

const PORT = process.env.PORT || 8080;

// Seed avvik ids are plain numbers; dwh-synced avvik ids are 16-char hex
// strings (see avvikSync.js's buildSyntheticId) - store.getAvvik/resolveAvvik/
// addComment compare ids with ===, so a route param must be parsed back to
// the same type the id was stored as, not blindly converted to a Number.
function parseAvvikId(raw) {
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

const MAX_BODY_BYTES = 10_000;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(Object.assign(new Error('invalid json body'), { status: 400 }));
      }
    });
    req.on('error', () => reject(Object.assign(new Error('bad request'), { status: 400 })));
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
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
        // Render before writing headers - if rendering throws, the outer
        // catch below needs to still be able to send a fresh error response
        // instead of hitting ERR_HTTP_HEADERS_SENT on an already-started one.
        const html = renderDashboard(store.listAvvik(), store.listNotifications());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      if (req.method === 'GET' && pathname === '/api/avvik') {
        return sendJson(res, 200, store.listAvvik());
      }

      const resolveMatch = pathname.match(/^\/api\/avvik\/([^/]+)\/resolve$/);
      if (req.method === 'POST' && resolveMatch) {
        const updated = store.resolveAvvik(parseAvvikId(resolveMatch[1]));
        if (!updated) return sendJson(res, 404, { error: 'avvik not found' });
        return sendJson(res, 200, updated);
      }

      const reopenMatch = pathname.match(/^\/api\/avvik\/([^/]+)\/reopen$/);
      if (req.method === 'POST' && reopenMatch) {
        const updated = store.reopenAvvik(parseAvvikId(reopenMatch[1]));
        if (!updated) return sendJson(res, 404, { error: 'avvik not found' });
        return sendJson(res, 200, updated);
      }

      const purchaserMatch = pathname.match(/^\/api\/avvik\/([^/]+)\/purchaser$/);
      if (req.method === 'POST' && purchaserMatch) {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message });
        }
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        if (!name) return sendJson(res, 400, { error: 'name is required' });
        if (name.length > 100 || email.length > 200) {
          return sendJson(res, 400, { error: 'name or email is too long' });
        }
        const updated = store.setManualPurchaser(parseAvvikId(purchaserMatch[1]), name, email);
        if (!updated) return sendJson(res, 404, { error: 'avvik not found' });
        return sendJson(res, 200, updated);
      }

      if (req.method === 'GET' && pathname === '/api/notifications') {
        return sendJson(res, 200, store.listNotifications());
      }

      const previewMatch = pathname.match(/^\/api\/avvik\/([^/]+)\/preview-email$/);
      if (req.method === 'GET' && previewMatch) {
        const avvik = store.getAvvik(parseAvvikId(previewMatch[1]));
        if (!avvik) return sendJson(res, 404, { error: 'avvik not found' });
        return sendJson(res, 200, buildEmailPreview(avvik));
      }

      const commentMatch = pathname.match(/^\/api\/avvik\/([^/]+)\/comments$/);
      if (req.method === 'POST' && commentMatch) {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message });
        }
        const author = typeof body.author === 'string' ? body.author.trim() : '';
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!author || !text) {
          return sendJson(res, 400, { error: 'author and text are required' });
        }
        if (author.length > 100 || text.length > 2000) {
          return sendJson(res, 400, { error: 'author or text is too long' });
        }
        const comment = store.addComment(parseAvvikId(commentMatch[1]), author, text);
        if (!comment) return sendJson(res, 404, { error: 'avvik not found' });
        return sendJson(res, 201, comment);
      }

      if (req.method === 'POST' && pathname === '/api/dwh/test-connection') {
        try {
          const result = await testConnection();
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 502, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/dwh/refresh-avvik') {
        try {
          const freshAvvikRows = await syncAvvikFromDwh();
          const result = store.mergeFromDwh(freshAvvikRows);
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 502, { ok: false, error: err.message });
        }
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

  // Best-effort: keep the mock-seeded state if the dwh isn't reachable yet
  // (e.g. the link isn't attached in this environment) rather than failing
  // startup over it.
  syncAvvikFromDwh()
    .then((freshAvvikRows) => {
      const result = store.mergeFromDwh(freshAvvikRows);
      console.log(
        `dwh startup sync: ${result.updated} updated, ${result.inserted} inserted, ${result.markedMissing} marked missing`
      );
    })
    .catch((err) => {
      console.warn(`dwh startup sync failed, keeping current avvik state: ${err.message}`);
    });
}

module.exports = { createServer };
