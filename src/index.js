'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const { runWeeklyJob } = require('./job');
const { buildEmailPreview } = require('./notify');
const { testConnection } = require('./dwh');
const { syncAvvikFromDwh, syncResolvedHistory, resolveDepartmentForPurchaser } = require('./avvikSync');
const { startScheduler } = require('./scheduler');
const attachments = require('./attachments');
const { ALL_DISCREPANCY_TYPES, UNKNOWN_HISTORY_TYPE } = require('./discrepancyTypes');
const { renderOpenAvvikPage, renderFinancePage, renderArchivePage, renderUtviklingPage, renderAvvikDetailPage, ASSET_CSS, ASSET_JS } = require('./dashboard');

const PORT = process.env.PORT || 8080;

// Logo icons for the avvik detail page's Medius/Ticket Manager links (see
// dashboard.js's renderAvvikDetailPage) - read once at startup rather than
// per-request, same idea as ASSET_CSS/ASSET_JS below.
const MEDIUS_LOGO_PNG = fs.readFileSync(path.join(__dirname, 'assets', 'medius-logo.png'));
const TICKET_MANAGER_LOGO_PNG = fs.readFileSync(path.join(__dirname, 'assets', 'ticket-manager-logo.png'));

// Seed avvik ids are plain numbers; dwh-synced avvik ids are 16-char hex
// strings (see avvikSync.js's buildSyntheticId) - store.getAvvik/resolveAvvik/
// addComment compare ids with ===, so a route param must be parsed back to
// the same type the id was stored as, not blindly converted to a Number.
// One full dwh refresh: the open avvik first, then the closed history that
// feeds the archive and the trend chart. Sequential, not parallel, for the
// same heap reason as avvikSync.js's own queries. A history failure never
// discards the open-avvik result - the open list is what people act on.
async function refreshFromDwh() {
  const freshAvvikRows = await syncAvvikFromDwh();
  const result = store.mergeFromDwh(freshAvvikRows);
  try {
    result.history = store.mergeHistoryFromDwh(await syncResolvedHistory());
  } catch (err) {
    console.warn(`dwh history sync failed, keeping current archive: ${err.message}`);
    result.history = null;
  }
  return result;
}

function parseAvvikId(raw) {
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

const MAX_BODY_BYTES = 10_000;

// Kommentar med vedlegg kommer som multipart/form-data. Hele forespørselen
// leses til minne (maks MAX_REQUEST_BYTES, avbrutt underveis hvis den blir
// større) og tolkes med Node sin innebygde FormData-parser.
async function readMultipartBody(req) {
  const declared = Number(req.headers['content-length']);
  if (declared > attachments.MAX_REQUEST_BYTES) {
    throw Object.assign(new Error('payload too large'), { status: 413 });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > attachments.MAX_REQUEST_BYTES) {
      throw Object.assign(new Error('payload too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    return await new Response(Buffer.concat(chunks), {
      headers: { 'content-type': req.headers['content-type'] },
    }).formData();
  } catch {
    throw Object.assign(new Error('invalid multipart body'), { status: 400 });
  }
}

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

      // ?v=<hash> in the shell's <link>/<script> tags (see dashboard.js's
      // ASSET_CSS_VERSION/ASSET_JS_VERSION) means the URL itself changes
      // whenever the content does, so this can be cached aggressively.
      if (req.method === 'GET' && pathname === '/assets/app.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' });
        return res.end(ASSET_CSS);
      }

      if (req.method === 'GET' && pathname === '/assets/app.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' });
        return res.end(ASSET_JS);
      }

      if (req.method === 'GET' && pathname === '/assets/medius-logo.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
        return res.end(MEDIUS_LOGO_PNG);
      }

      if (req.method === 'GET' && pathname === '/assets/ticket-manager-logo.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
        return res.end(TICKET_MANAGER_LOGO_PNG);
      }

      // Rendered before writing headers in all three routes below - if
      // rendering throws, the outer catch needs to still be able to send a
      // fresh error response instead of hitting ERR_HTTP_HEADERS_SENT on an
      // already-started one.
      if (req.method === 'GET' && pathname === '/') {
        const html = renderOpenAvvikPage(store.listAvvik(), store.listNotifications());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      if (req.method === 'GET' && pathname === '/finance') {
        const html = renderFinancePage(store.listAvvik(), store.listNotifications());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      if (req.method === 'GET' && pathname === '/utvikling') {
        const html = renderUtviklingPage(store.listAvvik(), Object.fromEntries(url.searchParams));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      if (req.method === 'GET' && pathname === '/arkiv') {
        const html = renderArchivePage(store.listAvvik(), store.listNotifications());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      const avvikDetailMatch = pathname.match(/^\/avvik\/([^/]+)$/);
      if (req.method === 'GET' && avvikDetailMatch) {
        const avvik = store.getAvvik(parseAvvikId(avvikDetailMatch[1]));
        if (!avvik) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end('<!DOCTYPE html><html lang="no"><body><p>Fant ikke avviket. <a href="/">Tilbake til Åpne avvik</a></p></body></html>');
        }
        const html = renderAvvikDetailPage(avvik);
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
        // Best-effort: a failed lookup (e.g. dwh unreachable) shouldn't block
        // saving the purchaser correction itself.
        let department = null;
        try {
          department = await resolveDepartmentForPurchaser(name);
        } catch (err) {
          console.warn(`Could not resolve department for manually-set purchaser: ${err.message}`);
        }
        const updated = store.setManualPurchaser(parseAvvikId(purchaserMatch[1]), name, email, department);
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

      const attachmentMatch = pathname.match(/^\/api\/avvik\/([^/]+)\/attachments\/([^/]+)$/);
      if (req.method === 'GET' && attachmentMatch) {
        const avvik = store.getAvvik(parseAvvikId(attachmentMatch[1]));
        const meta = avvik && avvik.comments.flatMap((c) => c.attachments || []).find((a) => a.id === attachmentMatch[2]);
        const file = meta && attachments.filePath(avvik.id, meta.id);
        if (!file || !fs.existsSync(file)) return sendJson(res, 404, { error: 'attachment not found' });
        // Alltid nedlasting, aldri inline: se attachments.js.
        const ascii = meta.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': meta.size,
          'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        });
        return fs.createReadStream(file).pipe(res);
      }

      // Rette en kommentar (navn og tekst), med samme krav som ved opprettelse.
      const commentEditMatch = pathname.match(/^\/api\/avvik\/([^/]+)\/comments\/(\d+)$/);
      if (req.method === 'PATCH' && commentEditMatch) {
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
        const comment = store.updateComment(parseAvvikId(commentEditMatch[1]), Number(commentEditMatch[2]), { author, text });
        if (!comment) return sendJson(res, 404, { error: 'comment not found' });
        return sendJson(res, 200, comment);
      }

      // Fjerne ett vedlegg: metadata først, så filen.
      const attachmentDeleteMatch = pathname.match(/^\/api\/avvik\/([^/]+)\/comments\/(\d+)\/attachments\/([^/]+)$/);
      if (req.method === 'DELETE' && attachmentDeleteMatch) {
        const avvikId = parseAvvikId(attachmentDeleteMatch[1]);
        const removed = store.removeAttachment(avvikId, Number(attachmentDeleteMatch[2]), attachmentDeleteMatch[3]);
        if (!removed) return sendJson(res, 404, { error: 'attachment not found' });
        attachments.removeFiles(avvikId, [removed]);
        return sendJson(res, 200, { ok: true });
      }

      // Sette avvikstype for hånd på en arkivsak (se store.setManualType).
      const typeMatch = pathname.match(/^\/api\/avvik\/([^/]+)\/type$/);
      if (req.method === 'PATCH' && typeMatch) {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message });
        }
        if (typeof body.type !== 'string' || ![...ALL_DISCREPANCY_TYPES, UNKNOWN_HISTORY_TYPE].includes(body.type)) {
          return sendJson(res, 400, { error: 'unknown discrepancy type' });
        }
        const avvik = store.setManualType(parseAvvikId(typeMatch[1]), body.type);
        if (!avvik) return sendJson(res, 404, { error: 'archived avvik not found' });
        return sendJson(res, 200, { id: avvik.id, discrepancyType: avvik.discrepancyType, manual: avvik.discrepancyTypeManuallySet });
      }

      const commentMatch = pathname.match(/^\/api\/avvik\/([^/]+)\/comments$/);
      if (req.method === 'POST' && commentMatch) {
        // JSON (bare kommentar) eller multipart (kommentar + vedlegg).
        const isMultipart = /^multipart\/form-data/i.test(req.headers['content-type'] || '');
        let body;
        let files = [];
        try {
          if (isMultipart) {
            const form = await readMultipartBody(req);
            body = { author: form.get('author'), text: form.get('text') };
            files = form.getAll('files').filter((f) => typeof f !== 'string' && f.size > 0);
          } else {
            body = await readJsonBody(req);
          }
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message });
        }
        const author = typeof body.author === 'string' ? body.author.trim() : '';
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        // Vedlegg hører alltid til en kommentar med navn - det er det som
        // gir saken status "Oppdatert".
        if (!author || !text) {
          return sendJson(res, 400, { error: 'author and text are required' });
        }
        if (author.length > 100 || text.length > 2000) {
          return sendJson(res, 400, { error: 'author or text is too long' });
        }
        const avvikId = parseAvvikId(commentMatch[1]);
        if (!store.getAvvik(avvikId)) return sendJson(res, 404, { error: 'avvik not found' });
        const fileError = attachments.validateFiles(files);
        if (fileError) return sendJson(res, 400, { error: fileError });
        let saved;
        try {
          saved = await attachments.saveFiles(avvikId, files);
        } catch (err) {
          console.warn(`could not save attachments: ${err.message}`);
          return sendJson(res, 500, { error: 'could not save attachments' });
        }
        const comment = store.addComment(avvikId, author, text, saved);
        if (!comment) {
          attachments.removeFiles(avvikId, saved);
          return sendJson(res, 404, { error: 'avvik not found' });
        }
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
          const result = await refreshFromDwh();
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
  // Restore comments/resolved/archived avvik from data/state.json before the
  // dwh sync below merges into the list, so the previous run's local state is
  // already in place by then.
  store.initPersistence();

  const server = createServer();
  server.listen(PORT, () => {
    console.log(`lager-avvik listening on port ${PORT}`);
  });
  startScheduler();

  // Best-effort: keep the mock-seeded state if the dwh isn't reachable yet
  // (e.g. the link isn't attached in this environment) rather than failing
  // startup over it.
  refreshFromDwh()
    .then((result) => {
      const history = result.history ? `, history ${result.history.inserted} added / ${result.history.dated} dated` : '';
      console.log(
        `dwh startup sync: ${result.updated} updated, ${result.inserted} inserted, ${result.archived} archived, ${result.reopened} reopened${history}`
      );
    })
    .catch((err) => {
      console.warn(`dwh startup sync failed, keeping current avvik state: ${err.message}`);
    });
}

module.exports = { createServer };
