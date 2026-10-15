'use strict';

// TD Synnex (Tech Data) invoice numbers per avvik, shown as extra information next
// to the Medius invoice number. Nothing is written back and nothing is stored on disk.
//
// Searching TD Synnex by PO does not work: its customerOrderNumbers is free text typed
// by the customer ("145480BZF", "Söderberg Stavanger PO 148621-DMG") and the search
// needs an exact match. So the documents created since a date are fetched page by
// page and the PO numbers are found inside that text as standalone 6-digit numbers.
// The first refresh reads everything since DEFAULT_SINCE (~28 pages of 100 for 2026);
// later ones only what was created since the last success (minus a margin).
//
// An avvik is an order line, so a PO alone is not enough (a PO has invoices for
// other articles too): for the POs of the open Tech Data avvik the invoice LINES are
// read as well (IncludeDetails), and an invoice is only shown for an avvik when one
// of its lines has the avvik's article number (TD's manufPartNumber; see matchKind).
// The line's quantity and unit price are compared with the order.
//
// Only invoice numbers, types, dates, currency and per line the part numbers,
// quantity and unit price are kept - no customers, addresses or line amounts.
// Credentials and the token are never logged.

const { getAccessToken, getApiBaseUrl, isConfigured } = require('./tdsynnex');

const SUPPLIER_RE = /tech\s*data|td\s*-?\s*synnex/i;
const PO_TOKEN_RE = /(?<!\d)\d{6}(?!\d)/g;
const DEFAULT_SINCE = process.env.TD_SYNNEX_INVOICES_SINCE || '2026-01-01';
const PAGE_SIZE = 100;
const MAX_PAGES = 60;
const MAX_DETAILS_PER_REFRESH = 80;
const PAGE_PAUSE_MS = 1000;
const MIN_INTERVAL_MS = 30 * 60 * 1000;
const OVERLAP_DAYS = 2;
const PRICE_TOLERANCE = 0.01;
const PART_FIELDS = ['manufPartNumber', 'tdsynnexPartNumber', 'upcEan'];

let byPo = new Map(); // PO -> [{ invoiceNumber, documentType, billingDate }]
let detailsByInvoice = new Map(); // invoiceNumber -> { currency, items: [{ parts, quantity, unitNetPrice }] }
let lastSuccessAt = null;
let lastAttemptAt = 0;
let running = null;

function isTdSynnexSupplier(name) {
  return SUPPLIER_RE.test(String(name || ''));
}

function dateOnly(value) {
  const s = String(value || '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDocuments(documents, index = byPo) {
  let added = 0;
  for (const doc of documents) {
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.customerOrderNumbers)) continue;
    const invoiceNumber = String(doc.invoiceNumber ?? doc.billingDocumentNumber ?? '');
    if (!invoiceNumber) continue;
    const entry = { invoiceNumber, documentType: String(doc.documentType ?? ''), billingDate: dateOnly(doc.billingDate) };
    for (const text of doc.customerOrderNumbers) {
      for (const po of new Set(String(text).match(PO_TOKEN_RE) || [])) {
        const list = index.get(po) || [];
        const existing = list.findIndex((x) => x.invoiceNumber === invoiceNumber);
        if (existing >= 0) list[existing] = entry;
        else {
          list.push(entry);
          added++;
        }
        index.set(po, list);
      }
    }
  }
  return added;
}

function documentsOf(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  if (json && typeof json === 'object') for (const v of Object.values(json)) if (Array.isArray(v)) return v;
  return [];
}

async function getPage(url, token, { fetchImpl, sleep }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, TraceId: 'lager-avvik-td-invoices', Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 5;
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`TD Synnex fakturahenting feilet: HTTP ${res.status}.`);
    return res.json();
  }
  throw new Error('TD Synnex fakturahenting feilet: HTTP 429.');
}

async function fetchDocumentsSince(since, token, { fetchImpl, sleep, maxPages }) {
  const base = getApiBaseUrl();
  const documents = [];
  let truncated = false;
  for (let page = 1; ; page++) {
    if (page > maxPages) {
      truncated = true;
      break;
    }
    const url = `${base}/resellers/v1/invoices?CreatedFrom=${encodeURIComponent(since)}&PageSize=${PAGE_SIZE}&Page=${page}`;
    const json = await getPage(url, token, { fetchImpl, sleep });
    const pageDocs = documentsOf(json);
    documents.push(...pageDocs);
    const totalPages = json && typeof json.totalPages === 'number' ? json.totalPages : null;
    if (!pageDocs.length || (totalPages !== null && page >= totalPages)) break;
    await sleep(PAGE_PAUSE_MS);
  }
  return { documents, truncated };
}

function toNumber(value) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) ? n : null;
}

function toItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const parts = PART_FIELDS.map((f) => raw[f]).filter((v) => v !== undefined && v !== null && v !== '').map(String);
  return { parts, quantity: toNumber(raw.quantity), unitNetPrice: toNumber(raw.unitNetPrice) };
}

// One invoice with its lines. Only the fields above are kept from the answer.
async function fetchInvoiceDetails(invoiceNumber, token, { fetchImpl, sleep }) {
  const url = `${getApiBaseUrl()}/resellers/v1/invoices?InvoiceNumber=${encodeURIComponent(invoiceNumber)}&IncludeDetails=true&PageSize=10`;
  const doc = documentsOf(await getPage(url, token, { fetchImpl, sleep }))[0];
  if (!doc) return null;
  return { currency: String(doc.documentCurrency || ''), items: (Array.isArray(doc.items) ? doc.items : []).map(toItem).filter(Boolean) };
}

function normalizePart(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// How our article number matches a TD Synnex part number: exact (ignoring case, spaces
// and dashes), or one has a suffix after a dash ("CW9164I-E" / "CW9164I-E-RF").
// Arbitrary substrings and short numbers (under 5 characters) never match by prefix.
function matchKind(ours, theirs) {
  const a = String(ours ?? '').toUpperCase().trim();
  const b = String(theirs ?? '').toUpperCase().trim();
  if (!a || !b) return null;
  if (normalizePart(a) === normalizePart(b)) return 'eksakt';
  if (a.length >= 5 && b.startsWith(`${a}-`)) return 'suffiks';
  if (b.length >= 5 && a.startsWith(`${b}-`)) return 'suffiks';
  return null;
}

function itemMatchKind(article, item) {
  for (const part of item.parts) {
    const kind = matchKind(article, part);
    if (kind) return kind;
  }
  return null;
}

// The invoices on the given POs whose lines have not been read yet.
function wantedInvoiceNumbers(getRelevantPos) {
  const wanted = [];
  for (const po of new Set([...getRelevantPos()].map(String))) {
    for (const inv of byPo.get(po) || []) if (!detailsByInvoice.has(inv.invoiceNumber) && !wanted.includes(inv.invoiceNumber)) wanted.push(inv.invoiceNumber);
  }
  return wanted;
}

// Reads the lines of these invoices (stops at the first failure, keeping what was read).
async function readInvoiceDetails(invoiceNumbers, token, { fetchImpl, sleep }) {
  let details = 0;
  for (const invoiceNumber of invoiceNumbers) {
    try {
      const read = await fetchInvoiceDetails(invoiceNumber, token, { fetchImpl, sleep });
      if (read) detailsByInvoice.set(invoiceNumber, read);
      details++;
    } catch (err) {
      console.warn(`TD Synnex invoice lines: stopped, keeping what was read: ${err.message}`);
      break;
    }
    await sleep(PAGE_PAUSE_MS);
  }
  return details;
}

// Never throws: a failure is logged (HTTP status only) and the previous list stays.
// Returns { skipped }, { ok: true, documents, pos, details, truncated } or { ok: false, error }.
async function refreshTdSynnexInvoices({
  getToken = getAccessToken,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date(),
  force = false,
  maxPages = MAX_PAGES,
  maxDetails = MAX_DETAILS_PER_REFRESH,
  getRelevantPos = () => [],
} = {}) {
  if (running) return running;
  if (!isConfigured()) return { skipped: 'not-configured' };
  if (!force && now().getTime() - lastAttemptAt < MIN_INTERVAL_MS) {
    // The list of documents was read recently, so it is not read again - but an avvik that
    // appeared since then still needs the lines of the invoices on its PO.
    const pending = wantedInvoiceNumbers(getRelevantPos);
    if (!pending.length) return { skipped: 'recent' };
    running = (async () => {
      try {
        const details = await readInvoiceDetails(pending.slice(0, maxDetails), await getToken(), { fetchImpl, sleep });
        return { ok: true, documents: 0, pos: byPo.size, details, truncated: false };
      } catch (err) {
        console.warn(`TD Synnex invoice lines failed, keeping the current list: ${err.message}`);
        return { ok: false, error: err.message };
      } finally {
        running = null;
      }
    })();
    return running;
  }
  lastAttemptAt = now().getTime();
  running = (async () => {
    try {
      const startedAt = now();
      const since = lastSuccessAt ? isoDate(new Date(lastSuccessAt.getTime() - OVERLAP_DAYS * 86400000)) : DEFAULT_SINCE;
      const token = await getToken();
      const { documents, truncated } = await fetchDocumentsSince(since, token, { fetchImpl, sleep, maxPages });
      addDocuments(documents);
      // A cut-off read must be redone from the same date next time.
      if (!truncated) lastSuccessAt = startedAt;
      else console.warn(`TD Synnex invoices: stopped after ${maxPages} pages, the list may be incomplete.`);

      // The lines of the invoices on the POs of the open avvik (once per invoice).
      const details = await readInvoiceDetails(wantedInvoiceNumbers(getRelevantPos).slice(0, maxDetails), token, { fetchImpl, sleep });
      return { ok: true, documents: documents.length, pos: byPo.size, details, truncated };
    } catch (err) {
      console.warn(`TD Synnex invoices refresh failed, keeping the current list: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      running = null;
    }
  })();
  return running;
}

function getInvoicesForPo(po) {
  return (byPo.get(String(po || '')) || []).map((x) => ({ ...x }));
}

function mediusNumbersOf(avvik) {
  const numbers = new Set();
  if (avvik.invoiceNumber) numbers.add(String(avvik.invoiceNumber));
  for (const inv of Array.isArray(avvik.invoices) ? avvik.invoices : []) if (inv && inv.invoiceNumber) numbers.add(String(inv.invoiceNumber));
  return numbers;
}

// Quantity and unit price of a (non credit note) invoice compared with the order.
// priceDiffPercent: how far TD's unit price is from the ordered one (null when equal to
// the øre, unknown, or not NOK). coversOpenQuantity: a line has exactly the quantity that
// is still open (received, not yet connected to an invoice) on the order.
function invoiceChecks(avvik, inv) {
  const none = { priceDiffPercent: null, coversOpenQuantity: false };
  if (inv.documentType && inv.documentType !== 'Invoice') return none;
  const orderPrice = avvik.orderUnitPrice;
  const open = avvik.orderOpenQuantity;
  let priceDiffPercent = null;
  let coversOpenQuantity = false;
  for (const line of inv.lines) {
    if (
      priceDiffPercent === null &&
      (!inv.currency || inv.currency === 'NOK') &&
      typeof orderPrice === 'number' && orderPrice !== 0 &&
      typeof line.unitNetPrice === 'number' &&
      Math.abs(orderPrice - line.unitNetPrice) > PRICE_TOLERANCE
    ) {
      priceDiffPercent = Math.round(((line.unitNetPrice - orderPrice) / orderPrice) * 1000) / 10;
    }
    if (typeof open === 'number' && open > 0 && line.quantity === open) coversOpenQuantity = true;
  }
  return { priceDiffPercent, coversOpenQuantity };
}

// The TD Synnex invoices (and credit notes) that belong to this avvik: on its PO, with a
// line carrying its article number. Invoices whose lines are not read yet are left out
// rather than guessed. Each: { invoiceNumber, documentType, billingDate, currency,
// lines: [{ quantity, unitNetPrice, matchKind }], checks }.
function getInvoicesForAvvik(avvik) {
  const article = avvik.articleNumber;
  if (!avvik.poNumber || !article) return [];
  const out = [];
  for (const inv of getInvoicesForPo(avvik.poNumber)) {
    const details = detailsByInvoice.get(inv.invoiceNumber);
    if (!details) continue;
    const lines = details.items
      .map((item) => ({ item, kind: itemMatchKind(article, item) }))
      .filter((x) => x.kind)
      .map(({ item, kind }) => ({ quantity: item.quantity, unitNetPrice: item.unitNetPrice, matchKind: kind }));
    if (!lines.length) continue;
    const match = { ...inv, currency: details.currency, lines };
    out.push({ ...match, checks: invoiceChecks(avvik, match) });
  }
  return out;
}

// The POs of the open Tech Data avvik (the ones whose invoice lines are worth reading).
function relevantPos(avvikList) {
  const pos = new Set();
  for (const a of avvikList) if (!a.resolved && a.poNumber && isTdSynnexSupplier(a.supplierName)) pos.add(String(a.poNumber));
  return [...pos];
}

// The "TD-faktura" mark in the avvik lists: every open Tech Data avvik that TD Synnex has an
// invoice/credit note for (for THIS article). A Map of avvik id -> { numbers, attention,
// tooltip }. attention: something to do - a TD invoice that is not linked to the avvik's
// order line in Medius (or not in Medius at all), or an archived cost invoice that must be
// reversed. Before Medius has been looked up, only "not linked" can be told.
function tdInvoiceBadges(avvikList) {
  const badges = new Map();
  for (const a of avvikList) {
    if (a.resolved || !a.poNumber || !isTdSynnexSupplier(a.supplierName)) continue;
    const invoices = getInvoicesForAvvik(a);
    if (!invoices.length) continue;
    const linked = mediusNumbersOf(a);
    let attention = false;
    const parts = invoices.map((inv) => {
      const head = mediusHeadsLoaded ? getMediusHead(inv.invoiceNumber) : null;
      const flags = [];
      if (mediusHeadsLoaded && !head) flags.push('ikke i Medius');
      else if (!linked.has(inv.invoiceNumber)) flags.push('ikke koblet til ordrelinjen');
      if (head && head.mustReverse) flags.push('må reverseres');
      if (flags.length) attention = true;
      return `${inv.invoiceNumber}${flags.length ? ` (${flags.join(', ')})` : ''}`;
    });
    badges.set(a.id, { numbers: invoices.map((inv) => inv.invoiceNumber), attention, tooltip: parts.join('; ') });
  }
  return badges;
}

// --- what Medius knows about those invoice numbers (medius_invoice_head) ---

const HEAD_STATUS_PRIORITY = { Archived: 0, Open: 1 };
let mediusByInvoice = new Map(); // invoiceNumber -> { kind, status, link, po, mustReverse }
let mediusLinesByInvoice = new Map(); // invoiceNumber -> [{ articleCode, articleName, quantity, unitPrice }]
let mediusHeadsLoaded = false; // false until the first lookup has run: "not found" means nothing before that

function headFrom(row) {
  const isCost = row.invoice_type === 'Non-PO invoice';
  return {
    kind: isCost ? 'kostnadsfaktura' : 'varefaktura',
    status: String(row.processing_status || ''),
    link: row.medius_link || null,
    po: row.visma_purchase_order ? String(row.visma_purchase_order).trim() : null,
    // An archived cost invoice has been booked without the order: it has to be reversed
    // before the invoice can be matched to the goods.
    mustReverse: isCost && row.processing_status === 'Archived',
  };
}

// rows: fetchMediusInvoiceHeadByNumber's. An invoice number can have several heads (e.g.
// an Archived and an Invalidated one): Archived wins, then Open, then the newest.
function setMediusHeads(rows) {
  mediusHeadsLoaded = true;
  const best = new Map();
  for (const row of rows) {
    const number = String(row.invoice_number ?? '').trim();
    if (!number) continue;
    const priority = HEAD_STATUS_PRIORITY[row.processing_status] ?? 2;
    const created = row.created_at ? new Date(row.created_at).getTime() : 0;
    const current = best.get(number);
    if (!current || priority < current.priority || (priority === current.priority && created > current.created)) best.set(number, { priority, created, row });
  }
  mediusByInvoice = new Map([...best].map(([number, { row }]) => [number, headFrom(row)]));
}

const HEAD_STATUS_LABELS = { Archived: 'arkivert', Open: 'åpen', Invalidated: 'makulert' };

// e.g. "arkivert kostnadsfaktura", "åpen varefaktura"; null when Medius does not have it.
function getMediusHead(invoiceNumber) {
  const head = mediusByInvoice.get(String(invoiceNumber));
  if (!head) return null;
  const status = HEAD_STATUS_LABELS[head.status] || head.status.toLowerCase();
  return { ...head, label: `${status ? `${status} ` : ''}${head.kind}` };
}

// The invoice numbers worth looking up in Medius: every invoice TD Synnex has on the POs
// of the open Tech Data avvik (also for other articles - the "Faktura" section lists them
// all), plus what Medius already has linked to the avvik.
function invoiceNumbersToLookUp(avvikList) {
  const numbers = new Set();
  for (const a of avvikList) {
    if (a.resolved || !a.poNumber || !isTdSynnexSupplier(a.supplierName)) continue;
    for (const inv of getInvoicesForPo(a.poNumber)) numbers.add(inv.invoiceNumber);
    for (const n of mediusNumbersOf(a)) numbers.add(n);
  }
  return [...numbers];
}

// rows: fetchMediusInvoiceLinesByNumber's. dwh can hold the same line more than once (one
// row per invoice head), so a line with the same number, article, quantity and price is kept once.
function setMediusLines(rows) {
  const map = new Map();
  const seen = new Set();
  for (const row of rows) {
    const number = String(row.invoice_number ?? '').trim();
    if (!number) continue;
    const line = {
      line: toNumber(row.line_number),
      articleCode: String(row.article_code ?? '').trim(),
      articleName: String(row.article_name ?? '').trim(),
      quantity: toNumber(row.quantity),
      unitPrice: toNumber(row.unit_price),
    };
    const key = [number, line.line, line.articleCode, line.quantity, line.unitPrice].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const list = map.get(number) || [];
    list.push(line);
    map.set(number, list);
  }
  for (const list of map.values()) list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  mediusLinesByInvoice = map;
}

// Everything the "Faktura" section of an avvik page says (Tech Data avvik only):
//  - tdInvoices: ALL TD Synnex invoices/credit notes on the avvik's PO, each with its lines
//    (part number, quantity, unit price; hasArticle marks the avvik's own article), what
//    Medius says about the number (medius: head with label, or null = not in Medius) and
//    the lines Medius has for it (mediusLines: null = not read).
//  - mediusOnly: invoices Medius has linked to the avvik that TD Synnex does not list.
//  - linked: the invoice numbers Medius has linked to the avvik's order line.
//  - tdLoaded: TD Synnex' invoices have been read at all; mediusLoaded: the Medius lookup ran.
function getInvoiceOverview(avvik) {
  const article = avvik.articleNumber;
  const tdInvoices = getInvoicesForPo(avvik.poNumber).map((inv) => {
    const details = detailsByInvoice.get(inv.invoiceNumber) || null;
    const items = details
      ? details.items.map((item) => ({
          part: item.parts[0] || '',
          quantity: item.quantity,
          unitNetPrice: item.unitNetPrice,
          hasArticle: Boolean(article) && itemMatchKind(article, item) !== null,
        }))
      : null;
    return {
      invoiceNumber: inv.invoiceNumber,
      documentType: inv.documentType,
      billingDate: inv.billingDate,
      currency: details ? details.currency : '',
      items,
      hasArticle: Boolean(items && items.some((i) => i.hasArticle)),
      medius: mediusHeadsLoaded ? getMediusHead(inv.invoiceNumber) : undefined,
      mediusLines: mediusLinesByInvoice.get(inv.invoiceNumber) || null,
    };
  });
  const tdNumbers = new Set(tdInvoices.map((i) => i.invoiceNumber));
  const linked = [...mediusNumbersOf(avvik)];
  const mediusOnly = linked.filter((n) => !tdNumbers.has(n)).map((n) => ({ invoiceNumber: n, medius: mediusHeadsLoaded ? getMediusHead(n) : undefined, mediusLines: mediusLinesByInvoice.get(n) || null }));
  return {
    tdLoaded: byPo.size > 0,
    mediusLoaded: mediusHeadsLoaded,
    linked,
    tdInvoices,
    mediusOnly,
  };
}

// number -> Medius head (with label, or null = not in Medius) for the numbers on one
// avvik's detail page. null as a whole until the Medius lookup has run, so a page shown
// before that does not claim that Medius lacks the invoices.
function getMediusHeadsFor(avvik, tdInvoices) {
  if (!mediusHeadsLoaded) return null;
  const heads = {};
  for (const n of [...tdInvoices.map((i) => i.invoiceNumber), ...mediusNumbersOf(avvik)]) heads[n] = getMediusHead(n);
  return heads;
}

// Dev/demo hook: put invoice lines in directly ({ invoiceNumber: { currency, items } }).
function _setDetails(map) {
  detailsByInvoice = new Map(Object.entries(map));
}

function _reset() {
  byPo = new Map();
  detailsByInvoice = new Map();
  mediusByInvoice = new Map();
  mediusLinesByInvoice = new Map();
  mediusHeadsLoaded = false;
  lastSuccessAt = null;
  lastAttemptAt = 0;
  running = null;
}

module.exports = {
  isTdSynnexSupplier,
  addDocuments,
  matchKind,
  refreshTdSynnexInvoices,
  getInvoicesForPo,
  getInvoicesForAvvik,
  invoiceChecks,
  relevantPos,
  tdInvoiceBadges,
  getInvoiceOverview,
  setMediusLines,
  setMediusHeads,
  getMediusHead,
  getMediusHeadsFor,
  invoiceNumbersToLookUp,
  _setDetails,
  _reset,
};
