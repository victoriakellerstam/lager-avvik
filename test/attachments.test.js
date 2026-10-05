'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/store');
const attachments = require('../src/attachments');
const { createServer } = require('../src/index');
const { renderOpenAvvikPage } = require('../src/dashboard');

let tmpDir;
let server;
let base;

test.beforeEach(async () => {
  store._reset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-avvik-att-'));
  store._enablePersistenceAt(path.join(tmpDir, 'state.json'));
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.LAGER_AVVIK_STATE_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Eksempeldataene har allerede kommentarer på noen avvik, så testene måler
// mot startverdien i stedet for å anta 0.
function firstId() {
  return store.listAvvik()[1].id;
}
const commentCount = (id) => store.getAvvik(id).comments.length;

function form({ author = 'Kari', text = 'Sjekket', files = [] } = {}) {
  const data = new FormData();
  if (author !== null) data.append('author', author);
  if (text !== null) data.append('text', text);
  for (const [name, content] of files) data.append('files', new Blob([content]), name);
  return data;
}

test('validateFiles: tillatte typer, størrelse og antall', () => {
  assert.equal(attachments.validateFiles([{ name: 'faktura.pdf', size: 10 }]), null);
  assert.match(attachments.validateFiles([{ name: 'virus.exe', size: 10 }]), /ikke tillatt/);
  assert.match(attachments.validateFiles([{ name: 'ingen-endelse', size: 10 }]), /ikke tillatt/);
  assert.match(attachments.validateFiles([{ name: 'stor.pdf', size: attachments.MAX_FILE_BYTES + 1 }]), /større enn/);
  const many = Array.from({ length: attachments.MAX_FILES + 1 }, (_, i) => ({ name: `f${i}.pdf`, size: 1 }));
  assert.match(attachments.validateFiles(many), /Maks/);
});

test('cleanFileName fjerner stier og kontrolltegn', () => {
  assert.equal(attachments.cleanFileName('../../etc/passwd.txt'), 'passwd.txt');
  assert.equal(attachments.cleanFileName(['C:', 'temp', 'a"b.pdf'].join(String.fromCharCode(92))), 'a_b.pdf');
  assert.equal(attachments.cleanFileName(''), 'vedlegg');
});

test('kommentar med vedlegg lagres, vises og kan lastes ned som nedlasting', async () => {
  const id = firstId();
  const before = commentCount(id);
  const res = await fetch(`${base}/api/avvik/${id}/comments`, {
    method: 'POST',
    body: form({ files: [['rapport.pdf', 'PDFDATA']] }),
  });
  assert.equal(res.status, 201);
  const comment = await res.json();
  assert.equal(comment.attachments.length, 1);
  assert.equal(comment.attachments[0].name, 'rapport.pdf');

  const dl = await fetch(`${base}/api/avvik/${id}/attachments/${comment.attachments[0].id}`);
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'PDFDATA');
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.match(dl.headers.get('content-disposition'), /^attachment;/);

  assert.equal(commentCount(id), before + 1);
  const comments = store.getAvvik(id).comments;
  assert.equal(comments[comments.length - 1].attachments[0].id, comment.attachments[0].id);
});

test('vedlegg uten navn eller kommentar avvises og gir ingen kommentar og ingen filer', async () => {
  const id = firstId();
  const before = commentCount(id);
  for (const f of [form({ author: '', files: [['a.pdf', 'x']] }), form({ text: '', files: [['a.pdf', 'x']] }), form({ author: null, files: [['a.pdf', 'x']] })]) {
    const res = await fetch(`${base}/api/avvik/${id}/comments`, { method: 'POST', body: f });
    assert.equal(res.status, 400);
  }
  assert.equal(commentCount(id), before);
  assert.equal(fs.existsSync(path.join(tmpDir, 'attachments')), false);
});

test('ugyldig filtype avvises, og ukjent avvik gir 404 uten filer', async () => {
  const id = firstId();
  const before = commentCount(id);
  const bad = await fetch(`${base}/api/avvik/${id}/comments`, { method: 'POST', body: form({ files: [['x.exe', 'MZ']] }) });
  assert.equal(bad.status, 400);
  assert.equal(commentCount(id), before);
  const missing = await fetch(`${base}/api/avvik/finnesikke/comments`, { method: 'POST', body: form({ files: [['a.pdf', 'x']] }) });
  assert.equal(missing.status, 404);
  assert.equal(fs.existsSync(path.join(tmpDir, 'attachments')), false);
});

test('nedlasting: ukjent eller ugyldig vedleggs-id gir 404, aldri filer utenfor mappen', async () => {
  const id = firstId();
  for (const att of ['finnes-ikke', '..', '%2e%2e%2f%2e%2e%2fstate.json']) {
    const res = await fetch(`${base}/api/avvik/${id}/attachments/${att}`);
    assert.equal(res.status, 404);
  }
});

test('vanlig JSON-kommentar virker som før', async () => {
  const id = firstId();
  const res = await fetch(`${base}/api/avvik/${id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: 'Ola', text: 'hei' }),
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).attachments, undefined);
});

test('åpne avvik: Oppdatert-radene kommer først, sist kommenterte øverst', () => {
  const mk = (id, daysWaiting, comments = []) => ({
    id, orderId: 'O' + id, poNumber: null, articleNumber: 'A', department: 'IT', purchaserName: 'Ola',
    supplierName: 'Lev', discrepancyType: 'Manuell ordre', comments, daysWaiting, resolved: false,
  });
  const c = (createdAt) => [{ id: 1, author: 'A', text: 'x', createdAt }];
  const list = [mk(1, 90), mk(2, 80), mk(3, 70, c('2026-10-01T10:00:00.000Z')), mk(4, 60, c('2026-10-03T10:00:00.000Z'))];
  const html = renderOpenAvvikPage(list, []);
  const order = [...html.matchAll(/class="avvik-row[^"]*"[^>]*data-href="\/avvik\/([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['4', '3', '1', '2']);
});

async function postComment(id, files = [['rapport.pdf', 'PDFDATA']]) {
  const res = await fetch(`${base}/api/avvik/${id}/comments`, { method: 'POST', body: form({ files }) });
  assert.equal(res.status, 201);
  return res.json();
}

const patch = (id, cid, body) =>
  fetch(`${base}/api/avvik/${id}/comments/${cid}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('en kommentar kan rettes: navn og tekst endres, vedlegg og tidspunkt beholdes, markert som redigert', async () => {
  const id = firstId();
  const created = await postComment(id);
  const res = await patch(id, created.id, { author: '  Kari N.  ', text: 'Rettet tekst' });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.author, 'Kari N.');
  assert.equal(updated.text, 'Rettet tekst');
  assert.equal(updated.createdAt, created.createdAt);
  assert.ok(updated.editedAt);
  assert.equal(updated.attachments.length, 1);
  assert.equal(store.getAvvik(id).comments.find((c) => c.id === created.id).text, 'Rettet tekst');
});

test('retting avvises uten navn/tekst, med for lang tekst og for ukjent kommentar', async () => {
  const id = firstId();
  const created = await postComment(id, []);
  assert.equal((await patch(id, created.id, { author: '', text: 'x' })).status, 400);
  assert.equal((await patch(id, created.id, { author: 'A', text: '   ' })).status, 400);
  assert.equal((await patch(id, created.id, { author: 'A', text: 'x'.repeat(2001) })).status, 400);
  assert.equal((await patch(id, 9999, { author: 'A', text: 'x' })).status, 404);
  assert.equal((await patch('finnesikke', 1, { author: 'A', text: 'x' })).status, 404);
  assert.equal(store.getAvvik(id).comments.find((c) => c.id === created.id).text, 'Sjekket');
});

test('et vedlegg kan fjernes: metadata og fil forsvinner, kommentaren og de andre vedleggene blir', async () => {
  const id = firstId();
  const created = await postComment(id, [['a.pdf', 'AAA'], ['b.pdf', 'BBB']]);
  const [a, b] = created.attachments;
  const fileA = attachments.filePath(id, a.id);
  assert.ok(fs.existsSync(fileA));

  const del = await fetch(`${base}/api/avvik/${id}/comments/${created.id}/attachments/${a.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(fs.existsSync(fileA), false);
  const left = store.getAvvik(id).comments.find((c) => c.id === created.id);
  assert.deepEqual(left.attachments.map((x) => x.id), [b.id]);
  assert.equal((await fetch(`${base}/api/avvik/${id}/attachments/${a.id}`)).status, 404);
  assert.equal(await (await fetch(`${base}/api/avvik/${id}/attachments/${b.id}`)).text(), 'BBB');

  await fetch(`${base}/api/avvik/${id}/comments/${created.id}/attachments/${b.id}`, { method: 'DELETE' });
  const none = store.getAvvik(id).comments.find((c) => c.id === created.id);
  assert.equal(none.attachments, undefined);
  assert.ok(none.text);
});

test('fjerning av ukjent vedlegg gir 404 og rører ingenting', async () => {
  const id = firstId();
  const created = await postComment(id);
  for (const att of ['finnes-ikke', '..']) {
    const res = await fetch(`${base}/api/avvik/${id}/comments/${created.id}/attachments/${att}`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  }
  assert.equal((await fetch(`${base}/api/avvik/${id}/comments/9999/attachments/${created.attachments[0].id}`, { method: 'DELETE' })).status, 404);
  assert.equal(store.getAvvik(id).comments.find((c) => c.id === created.id).attachments.length, 1);
});

test('kommentarlisten har Rediger- og Fjern-knapper og markerer redigerte kommentarer', () => {
  const { renderAvvikDetailPage } = require('../src/dashboard');
  const html = renderAvvikDetailPage({
    id: 'abc123', orderId: 'O1', poNumber: null, articleNumber: 'A', department: 'IT', purchaserName: 'Ola', supplierName: 'L',
    discrepancyType: 'Manuell ordre', daysWaiting: 1, resolved: false,
    comments: [{ id: 3, author: 'Kari', text: 'Hei "du"', createdAt: '2026-10-05T12:00:00.000Z', editedAt: '2026-10-05T13:00:00.000Z',
      attachments: [{ id: 'u-1', name: 'a.pdf', size: 10 }] }],
  });
  assert.match(html, /class="bf-link comment-action edit-comment">Rediger</);
  assert.match(html, /data-comment="3" data-author="Kari" data-text="Hei &quot;du&quot;"/);
  assert.match(html, /remove-attachment" data-avvik="abc123" data-comment="3" data-attachment="u-1"/);
  assert.match(html, /, redigert\)/);
});

const patchType = (id, type) =>
  fetch(`${base}/api/avvik/${id}/type`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type }),
  });

function archivedId() {
  const id = firstId();
  store.resolveAvvik(id);
  return id;
}

test('avvikstype kan settes for hånd på en arkivsak og lagres, "Ukjent" fjerner valget', async () => {
  const { UNKNOWN_HISTORY_TYPE } = require('../src/discrepancyTypes');
  const id = archivedId();
  const res = await patchType(id, 'Internbestilling');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id, discrepancyType: 'Internbestilling', manual: true });
  assert.equal(store.getAvvik(id).discrepancyType, 'Internbestilling');
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmpDir, 'state.json'), 'utf8')).avvikList.find((a) => a.id === id).discrepancyTypeManuallySet, true);

  const cleared = await (await patchType(id, UNKNOWN_HISTORY_TYPE)).json();
  assert.equal(cleared.manual, false);
});

test('avvikstype avvises for ukjent type og for åpne avvik, og endrer da ingenting', async () => {
  const id = firstId();
  const before = store.getAvvik(id).discrepancyType;
  assert.equal((await patchType(id, 'Internbestilling')).status, 404);
  store.resolveAvvik(id);
  assert.equal((await patchType(id, 'Noe helt annet')).status, 400);
  assert.equal((await patchType(id, undefined)).status, 400);
  assert.equal((await patchType('finnesikke', 'Internbestilling')).status, 404);
  assert.equal(store.getAvvik(id).discrepancyType, before);
  assert.equal(store.getAvvik(id).discrepancyTypeManuallySet, undefined);
});

test('en manuell type står til dwh selv finner typen, og da tar dwh over; ukjent fra dwh endrer den ikke', () => {
  const { UNKNOWN_HISTORY_TYPE } = require('../src/discrepancyTypes');
  const id = archivedId();
  store.setManualType(id, 'Internbestilling');
  const row = (type) => ({
    id, orderId: String(id), articleNumber: 'A', poNumber: 'P', department: null, purchaserName: null, purchaserEmail: null, ticketUrl: null,
    projectNumber: null, discrepancyType: type, createdAt: null, receivedAt: '2026-08-21T00:00:00.000Z', resolvedAt: '2026-10-02T00:00:00.000Z', daysWaiting: 42,
  });
  const a = store.getAvvik(id);
  a.resolvedSource = 'auto';
  store.mergeHistoryFromDwh([row(UNKNOWN_HISTORY_TYPE)]);
  assert.equal(a.discrepancyType, 'Internbestilling');
  assert.equal(a.discrepancyTypeManuallySet, true);
  store.mergeHistoryFromDwh([row('Manuell ordre')]);
  assert.equal(a.discrepancyType, 'Manuell ordre');
  assert.equal(a.discrepancyTypeManuallySet, false);
});

test('arkivsiden har Endre-knapp og forklaring, åpne avvik har ikke', () => {
  const { renderArchivePage, renderOpenAvvikPage } = require('../src/dashboard');
  const done = { ...store.listAvvik()[1], resolved: true, resolvedAt: '2026-10-02T00:00:00.000Z', receivedAt: '2026-08-21T00:00:00.000Z', discrepancyTypeManuallySet: true };
  const archive = renderArchivePage([done], []);
  assert.match(archive, /class="bf-link comment-action change-type"/);
  assert.match(archive, /\(satt manuelt\)/);
  assert.match(archive, /Bruk «Endre»/);
  assert.doesNotMatch(renderOpenAvvikPage([{ ...done, resolved: false, purchaserName: 'Ola' }], []), /change-type"/);
});
