'use strict';

const http = require('node:http');
const store = require('./store');
const { runWeeklyJob } = require('./job');
const { buildEmailPreview } = require('./notify');
const { startScheduler } = require('./scheduler');
const { renderDashboard } = require('./dashboard');

const PORT = process.env.PORT || 8080;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
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

      const previewMatch = pathname.match(/^\/api\/avvik\/(\d+)\/preview-email$/);
      if (req.method === 'GET' && previewMatch) {
        const avvik = store.getAvvik(Number(previewMatch[1]));
        if (!avvik) return sendJson(res, 404, { error: 'avvik not found' });
        return sendJson(res, 200, buildEmailPreview(avvik));
      }

      const commentMatch = pathname.match(/^\/api\/avvik\/(\d+)\/comments$/);
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
        const comment = store.addComment(Number(commentMatch[1]), author, text);
        if (!comment) return sendJson(res, 404, { error: 'avvik not found' });
        return sendJson(res, 201, comment);
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
