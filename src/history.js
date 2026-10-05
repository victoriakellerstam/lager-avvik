'use strict';

// Trend of "Avvik totalt" over time. Nothing here is stored: the series is
// recomputed from each avvik's receivedAt/resolvedAt on every page load, and
// those come from dwh (open lines from supplier_order_line, closed ones from
// supplier_order_line_copy - see avvikSync.js), so the chart survives the
// app's own state being wiped by a restart.

// Same threshold the dwh query uses to turn a received line into an avvik
// (DATEDIFF(day, receipt, today) > 21), so day 22 after receipt is the first
// day a line counts.
const WAIT_DAYS = 21;
const DAY_MS = 86400000;
const CHART_FROM = '2026-01-01';

// Self-contained on purpose (no closure over module scope): dashboard.js also
// ships this function's source to the browser, where the filtered chart is
// recomputed from the same items without another round trip. Any helper it
// needs must live inside it.
//
// items: [{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' | null }] where start is the
// first day the avvik counts and end the day it was resolved (no longer
// counted from that day on). Returns one { date, count } per day, from..to
// inclusive.
function buildDailySeries(items, from, to) {
  const dayMs = 86400000;
  const toDay = (iso) => Math.floor(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / dayMs);
  const fromDay = toDay(from);
  const toDayIdx = toDay(to);
  const length = toDayIdx - fromDay + 1;
  if (length <= 0) return [];
  const delta = new Array(length + 1).fill(0);
  items.forEach((item) => {
    if (!item.start) return;
    const startIdx = Math.max(toDay(item.start) - fromDay, 0);
    const endIdx = item.end ? Math.min(toDay(item.end) - fromDay, length) : length;
    if (startIdx >= endIdx || startIdx >= length) return;
    delta[startIdx] += 1;
    delta[endIdx] -= 1;
  });
  const series = [];
  let running = 0;
  for (let i = 0; i < length; i += 1) {
    running += delta[i];
    series.push({ date: new Date((fromDay + i) * dayMs).toISOString().slice(0, 10), count: running });
  }
  return series;
}

function addDays(iso, days) {
  return new Date(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
}

// One chart item per avvik. start = receipt date + WAIT_DAYS + 1. An open avvik
// without a receipt date (old persisted state) falls back to today minus its
// daysWaiting; a resolved one without it is left out, since there is no honest
// start for it.
function toChartItem(avvik, today) {
  let received = avvik.receivedAt ? String(avvik.receivedAt).slice(0, 10) : null;
  if (!received && !avvik.resolved && typeof avvik.daysWaiting === 'number') {
    received = addDays(today, -avvik.daysWaiting);
  }
  if (!received) return null;
  return {
    start: addDays(received, WAIT_DAYS + 1),
    end: avvik.resolved && avvik.resolvedAt ? String(avvik.resolvedAt).slice(0, 10) : null,
    order: String(avvik.orderId || '').toLowerCase(),
    po: String(avvik.poNumber || '').toLowerCase(),
    department: (avvik.department || '').toLowerCase(),
    purchaser: (avvik.purchaserName || '').toLowerCase(),
    type: (avvik.discrepancyType || '').toLowerCase(),
    // Visningsnavn og status for filtrene på Utvikling-siden.
    supplierName: (avvik.supplierName || '').trim() || 'Ukjent leverandør',
    departmentName: (avvik.department || '').trim() || 'Ukjent avdeling',
    resolved: Boolean(avvik.resolved),
  };
}

function buildChartItems(avvikList, today = new Date().toISOString().slice(0, 10)) {
  return avvikList.map((a) => toChartItem(a, today)).filter(Boolean);
}

// Utvikling-sidens perioder (dager bakover fra i dag).
const PERIODS = { 30: 'Siste 30 dager', 90: 'Siste 90 dager', 365: 'Siste 12 måneder', alle: 'Alle' };

// Perioden som datoer. Historikken starter ikke før CHART_FROM, så en lengre
// periode kuttes der (clamped = true) i stedet for å vise en misvisende flat
// null-linje bakover i tid.
function periodRange(period, today) {
  const days = period !== 'alle' && PERIODS[period] ? Number(period) : null;
  const wanted = days ? addDays(today, -(days - 1)) : CHART_FROM;
  const clamped = days !== null && wanted < CHART_FROM;
  return { from: clamped || !days ? CHART_FROM : wanted, to: today, clamped };
}

// 'apne' = åpne på siste dag i perioden, 'registrert' = begynte å telle i
// perioden, 'lukket' = ble løst i perioden.
function inMode(item, mode, from, to) {
  if (mode === 'registrert') return item.start >= from && item.start <= to;
  if (mode === 'lukket') return Boolean(item.end) && item.end >= from && item.end <= to;
  return item.start <= to && (!item.end || item.end > to);
}

// Radene som passer filtrene og visningen: department/supplier er visningsnavn,
// status er 'apne' | 'lukket' | tom (alle).
function selectChartItems(items, { mode, from, to, department, supplier, status }) {
  return items.filter(
    (item) =>
      (!department || item.departmentName === department) &&
      (!supplier || item.supplierName === supplier) &&
      (!status || (status === 'lukket') === item.resolved) &&
      inMode(item, mode, from, to)
  );
}

// Antall hendelser (start eller end) per bøtte på bucketDays dager, fra `from`.
function buildEventSeries(items, field, from, to, bucketDays) {
  const day = (iso) => Math.floor(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / DAY_MS);
  const fromDay = day(from);
  const length = day(to) - fromDay + 1;
  if (length <= 0) return [];
  const buckets = Math.ceil(length / bucketDays);
  const counts = new Array(buckets).fill(0);
  items.forEach((item) => {
    if (!item[field]) return;
    const idx = Math.floor((day(item[field]) - fromDay) / bucketDays);
    if (idx >= 0 && idx < buckets) counts[idx] += 1;
  });
  return counts.map((count, i) => ({ date: addDays(from, i * bucketDays), count }));
}

module.exports = {
  buildDailySeries,
  buildChartItems,
  buildEventSeries,
  selectChartItems,
  periodRange,
  PERIODS,
  CHART_FROM,
  WAIT_DAYS,
};
