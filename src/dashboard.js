'use strict';

const crypto = require('node:crypto');
const { getTypeBadgeClass } = require('./typeBadges');
const { isFinanceCase } = require('./financeTypes');
const {
  KOSTNADSFAKTURA_REVERSER,
  KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT,
  ALL_DISCREPANCY_TYPES,
  UNKNOWN_HISTORY_TYPE,
} = require('./discrepancyTypes');
const { getAvvikDetailContent } = require('./avvikDetailContent');
const { buildDailySeries, buildChartItems, CHART_FROM } = require('./history');
const { MAX_FILES, MAX_FILE_BYTES, ALLOWED_EXTENSIONS } = require('./attachments');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Leverandørnavnet slik det vises og filtreres på (tom leverandør samles under
// ett navn, felles for radene og for Utvikling-diagrammet).
const UNKNOWN_SUPPLIER = 'Ukjent leverandør';
function supplierLabel(a) {
  return (a.supplierName || '').trim() || UNKNOWN_SUPPLIER;
}

function formatFileSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Vedlegg hører til kommentaren de ble lagt til med, og lastes ned via
// /api/avvik/:id/attachments/:vedleggs-id (alltid som nedlasting).
function renderAttachments(attachments, avvikId, commentId) {
  if (!attachments || !attachments.length) return '';
  const items = attachments
    .map(
      (att) => `<li><i class="fa-solid fa-paperclip" aria-hidden="true"></i>
        <a class="bf-link" href="/api/avvik/${encodeURIComponent(avvikId)}/attachments/${encodeURIComponent(att.id)}" download>${escapeHtml(att.name)}</a>
        <span class="ts">(${formatFileSize(att.size)})</span>
        <button type="button" class="bf-link comment-action remove-attachment" data-avvik="${escapeHtml(avvikId)}" data-comment="${commentId}" data-attachment="${escapeHtml(att.id)}" data-name="${escapeHtml(att.name)}" aria-label="Fjern vedlegget ${escapeHtml(att.name)}">Fjern</button></li>`
    )
    .join('');
  return `<ul class="attachments">${items}</ul>`;
}

// Hver kommentar kan rettes (navn og tekst) og vedleggene kan fjernes enkeltvis;
// knappene styres av delegerte klikk-handlere i SHARED_SCRIPT. Rå verdier ligger
// i data-attributter så redigeringsskjemaet kan fylles ut.
function renderComments(comments, avvikId) {
  if (!comments.length) return '<li class="empty">Ingen kommentarer enna.</li>';
  return comments
    .map(
      (c) => `<li data-avvik="${escapeHtml(avvikId)}" data-comment="${c.id}" data-author="${escapeHtml(c.author)}" data-text="${escapeHtml(c.text)}">
        <span class="comment-body"><strong>${escapeHtml(c.author)}:</strong> ${escapeHtml(c.text)}
        <span class="ts">(${new Date(c.createdAt).toLocaleString('no-NO')}${c.editedAt ? ', redigert' : ''})</span>
        <button type="button" class="bf-link comment-action edit-comment">Rediger</button></span>
        ${renderAttachments(c.attachments, avvikId, c.id)}</li>`
    )
    .join('');
}

function renderNotificationHistory(avvikId, notifications) {
  const entries = notifications.filter((n) => n.avvikId === avvikId);
  if (!entries.length) return '<li class="empty">Ingen varsler sendt enna.</li>';
  return entries
    .map(
      (n) => `<li>${new Date(n.sentAt).toLocaleString('no-NO')} — varslet <strong>${escapeHtml(n.to)}</strong></li>`
    )
    .join('');
}

// Shared ring-segment math for both donuts below: each segment is one
// <circle> with a 100-unit circumference (r = 15.91549430918954, since
// 2*pi*r = 100), so stroke-dasharray/-dashoffset can be expressed directly
// as percentages. filterAttrsFn(label), if given, returns a data-filter-col/
// data-filter-value attribute string for labels that should filter the open
// list when clicked (segment or legend entry) - return '' for a label that
// shouldn't be clickable (e.g. the "Andre" bucket, which isn't a real value
// any row actually has).
function renderDonutParts(entries, total, colorForIndex, emptyLabel, filterAttrsFn) {
  let cumulative = 0;
  const segments = entries
    .map(([label, count], i) => {
      const percent = total ? (count / total) * 100 : 0;
      const dashoffset = 25 - cumulative;
      cumulative += percent;
      const color = colorForIndex(label, i);
      const filterAttrs = filterAttrsFn ? filterAttrsFn(label) : '';
      const cls = filterAttrs ? ' class="clickable"' : '';
      return `<circle cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="${color}" stroke-width="6" stroke-dasharray="${percent.toFixed(2)} ${(100 - percent).toFixed(2)}" stroke-dashoffset="${dashoffset.toFixed(2)}"${cls}${filterAttrs}></circle>`;
    })
    .join('');

  const legend = entries.length
    ? entries
        .map(([label, count], i) => {
          const color = colorForIndex(label, i);
          const percent = total ? Math.round((count / total) * 100) : 0;
          const filterAttrs = filterAttrsFn ? filterAttrsFn(label) : '';
          const cls = filterAttrs ? ' class="clickable"' : '';
          return `<li${cls}${filterAttrs}><span class="legend-swatch" style="background:${color}"></span>${escapeHtml(label)} — ${count} (${percent}%)</li>`;
        })
        .join('')
    : `<li class="empty">${emptyLabel}</li>`;

  return { segments, legend };
}

function renderDonutCard(title, ariaLabel, segments, legend) {
  return `
    <div class="bf-card donut-card"><div class="bf-card-content">
      <div class="bf-card-title">${title}</div>
      <div class="donut-wrap">
        <svg viewBox="0 0 42 42" class="donut" role="img" aria-label="${ariaLabel}">
          <circle cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="var(--bfc-base-2)" stroke-width="6"></circle>
          ${segments}
        </svg>
        <ul class="donut-legend">${legend}</ul>
      </div>
    </div></div>`;
}

// Colors reuse the same Bifrost category as the type's badge, so the chart
// and the table agree visually.
function renderTypeDonut(avvikList) {
  const total = avvikList.length;
  const counts = new Map();
  for (const a of avvikList) {
    counts.set(a.discrepancyType, (counts.get(a.discrepancyType) || 0) + 1);
  }
  const entries = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  const filterAttrs = (type) => ` data-filter-col="type" data-filter-value="${escapeHtml(type.toLowerCase())}"`;
  const { segments, legend } = renderDonutParts(
    entries,
    total,
    (type) => `var(--bfc-${getTypeBadgeClass(type)})`,
    'Ingen avvik registrert.',
    filterAttrs
  );
  return renderDonutCard('Fordeling per avvikstype', 'Fordeling av avvikstyper', segments, legend);
}

// Departments aren't a small fixed enum like discrepancyType, so colors are
// generated (evenly spaced hues) instead of reusing badge classes. Capped to
// the 8 biggest departments plus an "Andre" bucket so the legend stays
// readable. "Andre" - short for "andre avdelinger" (other departments) -
// bundles everything past the top 8 into one slice; it isn't a real
// department value any row has, so it's excluded from click-to-filter (same
// for "Ukjent", the label used when a row has no department at all).
const DEPARTMENT_DONUT_MAX_SLICES = 8;
const DEPARTMENT_DONUT_NON_FILTERABLE = new Set(['Andre', 'Ukjent']);

function renderDepartmentDonut(avvikList) {
  const total = avvikList.length;
  const counts = new Map();
  for (const a of avvikList) {
    const dept = a.department || 'Ukjent';
    counts.set(dept, (counts.get(dept) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  const top = sorted.slice(0, DEPARTMENT_DONUT_MAX_SLICES);
  const rest = sorted.slice(DEPARTMENT_DONUT_MAX_SLICES);
  const entries = rest.length
    ? [...top, ['Andre', rest.reduce((sum, [, count]) => sum + count, 0)]]
    : top;

  const colorForIndex = (_label, i) => `hsl(${Math.round((i * 360) / Math.max(entries.length, 1))}, 60%, 55%)`;
  const filterAttrs = (label) =>
    DEPARTMENT_DONUT_NON_FILTERABLE.has(label)
      ? ''
      : ` data-filter-col="department" data-filter-value="${escapeHtml(label.toLowerCase())}"`;
  const { segments, legend } = renderDonutParts(entries, total, colorForIndex, 'Ingen avvik registrert.', filterAttrs);
  return renderDonutCard('Fordeling per avdeling', 'Fordeling per avdeling', segments, legend);
}

// openAvvikList is exactly what's shown in the "Åpne avvik" table below (see
// splitAvvik) - the top-5/donuts here need to match it 1:1 so that clicking
// into one of them filters that same table meaningfully. resolvedCount is
// tracked separately since resolved avvik aren't part of that list at all.
function renderStats(openAvvikList, resolvedCount) {
  const counts = new Map();
  for (const a of openAvvikList) {
    counts.set(a.purchaserName, (counts.get(a.purchaserName) || 0) + 1);
  }
  const top5 = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5);

  const topList = top5.length
    ? top5
        .map(([name, count]) => {
          // A blank/"Ukjent" name has nothing real to filter by - filtering
          // by an empty value would just match every row (see applyFilters).
          const filterAttrs = name
            ? ` data-filter-col="purchaser" data-filter-value="${escapeHtml(name.toLowerCase())}"`
            : '';
          const cls = filterAttrs ? ' class="clickable"' : '';
          return `<li${cls}${filterAttrs}>${escapeHtml(name || 'Ukjent')} — ${count} avvik</li>`;
        })
        .join('')
    : '<li class="empty">Ingen avvik registrert.</li>';

  return `
  <div class="stats">
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-number">${openAvvikList.length}</div>
      <div class="stat-label">Avvik totalt</div>
      <div class="stat-sublabel" id="filtered-count" hidden></div>
    </div></div>
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-number">${resolvedCount}</div>
      <div class="stat-label">Antall løst</div>
    </div></div>
    <div class="bf-card top-list-card"><div class="bf-card-content">
      <div class="stat-label">Topp 5 — flest avvik</div>
      <ol class="top-list">${topList}</ol>
    </div></div>
    ${renderTypeDonut(openAvvikList)}
    ${renderDepartmentDonut(openAvvikList)}
  </div>`;
}

// Open rows show how long the line has waited so far (daysWaiting, from dwh).
// An archived row shows receipt -> resolved instead: daysWaiting is frozen at
// whatever it was when dwh last returned the line, which is not the time it
// took to resolve. Falls back to daysWaiting only when there is no receipt
// date to count from.
function formatDaysCell(a, dateField) {
  if (dateField === 'resolvedAt' && a.receivedAt && a.resolvedAt) {
    const days = Math.round((Date.parse(a.resolvedAt) - Date.parse(a.receivedAt)) / 86400000);
    if (Number.isFinite(days)) return days;
  }
  return typeof a.daysWaiting === 'number' ? a.daysWaiting : '—';
}

function renderAvvikRow(
  a,
  notifications,
  { actionButton, dateField, showPurchaserForm, showSku, showDateColumn = true, showNotifiedColumn = true, openList = false, editableType = false, commentButton = false }
) {
  const timesNotified = notifications.filter((n) => n.avvikId === a.id).length;
  const dateValue = dateField === 'resolvedAt' ? a.resolvedAt : a.lastNotifiedAt;
  let actionCell = '';
  if (actionButton === 'resolve') {
    actionCell = `<td><button type="button" data-id="${a.id}" class="bf-button bf-button-small resolve">Marker løst</button></td>`;
  } else if (actionButton === 'reopen') {
    actionCell = `<td><button type="button" data-id="${a.id}" class="bf-button bf-button-small reopen">Gjenåpne</button></td>`;
  }
  // A manually-entered owner takes the row out of the "Sakseier ikke funnet"
  // table on next reload (see dashboard.js's NO_OWNER_NAMES check), so the
  // form is only ever shown while no real owner has been resolved yet.
  const purchaserCell = showPurchaserForm
    ? `<form class="set-purchaser" data-id="${a.id}">
        <input type="text" class="bf-input bf-input-small" name="name" placeholder="Innkjøpers navn" required maxlength="100">
        <input type="email" class="bf-input bf-input-small" name="email" placeholder="E-post (valgfritt)" maxlength="200">
        <button type="submit" class="bf-button bf-button-small">Lagre</button>
      </form>`
    : a.purchaserName
      ? escapeHtml(a.purchaserName)
      : '—';
  const skuCell = showSku ? `<td>${a.articleNumber ? escapeHtml(a.articleNumber) : '—'}</td>` : '';
  // Manuell ordre har ikke PO-nummer (dwh gir NULL på de radene), så feltet
  // står tomt der. Vises bare der SKU vises, dvs. i listen over åpne avvik.
  const poCell = showSku ? `<td>${a.poNumber ? escapeHtml(a.poNumber) : ''}</td>` : '';
  // Status i listen over åpne avvik: "Oppdatert" så snart noen har kommentert,
  // ellers "Venter på innkjøper". Beregnes ved visning, lagres ikke.
  const statusCell = openList
    ? `<td>${a.comments.length > 0
        ? '<span class="status-pill status-pill-updated">Oppdatert</span>'
        : '<span class="status-pill status-pill-waiting">Venter på innkjøper</span>'}</td>`
    : '';
  // I åpne avvik er kommentarvisningen en knapp ("Legg til kommentar") i
  // samme stil som "Marker løst"; den åpner kommentarlisten og skjemaet.
  // I arkivet står "N kommentarer" som en knapp (som "Gjenåpne"), ellers som lenke.
  const commentCountLabel = `${a.comments.length} kommentar${a.comments.length === 1 ? '' : 'er'}`;
  const commentSummary = openList
    ? '<summary class="bf-button bf-button-small comment-button">Legg til kommentar</summary>'
    : commentButton
      ? `<summary class="bf-button bf-button-small comment-button">${commentCountLabel}</summary>`
      : `<summary class="bf-link">${commentCountLabel}</summary>`;
  // Arkivet: avvikstypen kan settes for hånd (dwh kan ikke gjenskape den for en
  // lukket linje), se store.setManualType. "Endre" byttes ut med en
  // nedtrekksliste av klientskriptet.
  const typeBadge = `<span class="bf-badge bfc-${getTypeBadgeClass(a.discrepancyType)}-bg">${escapeHtml(a.discrepancyType)}</span>`;
  const typeCell = editableType
    ? `<td class="type-cell" data-id="${escapeHtml(a.id)}" data-current="${escapeHtml(a.discrepancyType)}">${typeBadge}${a.discrepancyTypeManuallySet ? ' <span class="ts">(satt manuelt)</span>' : ''}
        <button type="button" class="bf-link comment-action change-type" aria-label="Endre avvikstype for ordre ${escapeHtml(a.orderId)}">Endre</button></td>`
    : `<td>${typeBadge}</td>`;
  const dateCell = showDateColumn ? `<td>${dateValue ? new Date(dateValue).toLocaleDateString('no-NO') : '—'}</td>` : '';
  const notifiedCell = showNotifiedColumn
    ? `<td>
        <details>
          <summary class="bf-link">${timesNotified} ganger varslet på e-post</summary>
          <ul class="notif-history">${renderNotificationHistory(a.id, notifications)}</ul>
        </details>
        <button type="button" class="bf-button bf-button-small preview-email" data-id="${a.id}">Vis e-posteksempel</button>
        <pre class="email-preview" data-id="${a.id}" hidden></pre>
      </td>`
    : '';
  // data-href/tabindex make the whole row navigate straight to this avvik's
  // "Dette må gjøres" detail page (see the .avvik-row handler in
  // SHARED_SCRIPT) - the row used to expand a detail panel with the same
  // link inline instead; that panel's fields all already appear on the
  // detail page itself (renderAvvikDetailPage), so nothing is lost by
  // navigating straight there.
  return `
    <tr class="avvik-row" tabindex="0" data-href="/avvik/${encodeURIComponent(a.id)}" data-order="${escapeHtml(a.orderId.toLowerCase())}" data-po="${escapeHtml((a.poNumber || '').toLowerCase())}" data-purchaser="${escapeHtml((a.purchaserName || '').toLowerCase())}" data-department="${escapeHtml((a.department || '').toLowerCase())}" data-type="${escapeHtml(a.discrepancyType.toLowerCase())}" data-label-order="${escapeHtml(a.orderId)}" data-label-po="${escapeHtml(a.poNumber || '')}" data-label-purchaser="${escapeHtml(a.purchaserName || '')}" data-label-department="${escapeHtml(a.department || '')}" data-label-type="${escapeHtml(a.discrepancyType)}" data-supplier="${escapeHtml(supplierLabel(a).toLowerCase())}">
      <td>${escapeHtml(a.orderId)}</td>
      ${poCell}
      ${statusCell}
      ${skuCell}
      <td>${purchaserCell}</td>
      <td>${a.department ? escapeHtml(a.department) : '—'}</td>
      ${typeCell}
      <td>${formatDaysCell(a, dateField)}</td>
      ${dateCell}
      ${actionCell}
      <td>
        <details>
          ${commentSummary}
          <ul class="comments">${renderComments(a.comments, a.id)}</ul>
          <form class="add-comment" data-id="${a.id}">
            <input type="text" class="bf-input" name="author" placeholder="Ditt navn" required maxlength="100">
            <input type="text" class="bf-input" name="text" placeholder="Skriv en kommentar" required maxlength="2000">
            ${openList
              ? `<label class="file-pick">
              <span>Vedlegg (valgfritt, maks ${MAX_FILES} filer à ${MAX_FILE_BYTES / (1024 * 1024)} MB). Navn og kommentar må fylles ut.</span>
              <input type="file" name="files" multiple accept="${[...ALLOWED_EXTENSIONS].map((e) => '.' + e).join(',')}">
            </label>`
              : ''}
            <button type="submit" class="bf-button bf-button-small">Legg til</button>
            <p class="form-error" role="alert" hidden></p>
          </form>
        </details>
      </td>
      ${notifiedCell}
    </tr>`;
}

// Finance-only cases never get an email, so there's no email-preview UI here.
// The status column shows the actual discrepancyType badge (not a generic
// Åpen/Løst) since this table now also holds Kostnadsfaktura — reverser
// cases alongside genuine Spesielle caser - Finance ones.
function renderFinanceRow(a) {
  return `
    <tr class="avvik-row" tabindex="0" data-href="/avvik/${encodeURIComponent(a.id)}" data-order="${escapeHtml(a.orderId.toLowerCase())}" data-po="${escapeHtml((a.poNumber || '').toLowerCase())}" data-purchaser="${escapeHtml((a.purchaserName || '').toLowerCase())}" data-department="${escapeHtml((a.department || '').toLowerCase())}" data-type="${escapeHtml(a.discrepancyType.toLowerCase())}" data-label-order="${escapeHtml(a.orderId)}" data-label-po="${escapeHtml(a.poNumber || '')}" data-label-purchaser="${escapeHtml(a.purchaserName || '')}" data-label-department="${escapeHtml(a.department || '')}" data-label-type="${escapeHtml(a.discrepancyType)}" data-supplier="${escapeHtml(supplierLabel(a).toLowerCase())}">
      <td>${escapeHtml(a.orderId)}</td>
      <td>${a.purchaserName ? escapeHtml(a.purchaserName) : '—'}</td>
      <td>${a.department ? escapeHtml(a.department) : '—'}</td>
      <td><span class="bf-badge bfc-${getTypeBadgeClass(a.discrepancyType)}-bg">${escapeHtml(a.discrepancyType)}</span></td>
      <td>${typeof a.daysWaiting === 'number' ? a.daysWaiting : '—'}</td>
      <td>
        <details>
          <summary class="bf-link">${a.comments.length} kommentar${a.comments.length === 1 ? '' : 'er'}</summary>
          <ul class="comments">${renderComments(a.comments, a.id)}</ul>
          <form class="add-comment" data-id="${a.id}">
            <input type="text" class="bf-input" name="author" placeholder="Ditt navn" required maxlength="100">
            <input type="text" class="bf-input" name="text" placeholder="Skriv en kommentar" required maxlength="2000">
            <button type="submit" class="bf-button bf-button-small">Legg til</button>
          </form>
        </details>
      </td>
      <td>${a.resolved ? '' : `<button type="button" data-id="${a.id}" class="bf-button bf-button-small resolve">Marker løst</button>`}</td>
    </tr>`;
}

// The two literal fallback names dwhQueries.js's ground-truth query produces
// as case_owner when no sakseier could be resolved (see the query's Combined
// CTE) - these get pulled into their own table instead of cluttering the
// normal open-avvik list, same idea as the Finance section.
const NO_OWNER_NAMES = new Set(['Sakseier ikke funnet', 'Manuell ordre – sakseier mangler']);
const byDaysWaitingDesc = (a, b) => (b.daysWaiting || 0) - (a.daysWaiting || 0);

// Åpne avvik: de som har fått en kommentar (status "Oppdatert") øverst, den
// sist kommenterte først; resten som før etter dager siden mottak.
const lastCommentAt = (a) => a.comments.reduce((latest, c) => (c.createdAt > latest ? c.createdAt : latest), '');
const byUpdatedFirst = (a, b) => {
  const aUpdated = a.comments.length > 0;
  const bUpdated = b.comments.length > 0;
  if (aUpdated !== bUpdated) return aUpdated ? -1 : 1;
  if (aUpdated) return lastCommentAt(b).localeCompare(lastCommentAt(a)) || byDaysWaitingDesc(a, b);
  return byDaysWaitingDesc(a, b);
};

// Kostnadsfaktura — reverser lives in the Finance section too (its own
// resolve workflow is Finance-internal, same as the other Finance cases),
// but keeps its own discrepancyType/badge rather than being relabeled. Also
// used by renderAvvikDetailPage to pick the right active side-nav item for
// an avvik reached via "Mer informasjon" vs. "Dette må gjøres".
// !a.resolved matters here (mirrors isOpenNoOwner below): once a case is
// resolved - whether by clicking "Marker løst" or automatically because the
// order line no longer has order_status = 3030 (see store.js's
// mergeFromDwh) - it must fall through to the shared open/resolved split
// below instead of lingering in this section forever, so it ends up in
// Arkiv like every other resolved case.
const isFinanceSectionCase = (a) => !a.resolved && (isFinanceCase(a.discrepancyType) || a.discrepancyType === KOSTNADSFAKTURA_REVERSER);

// A separate Finance-closes-it-in-Visma criterion, independent of
// isFinanceSectionCase above: either the whole SKU quantity has been
// written off (writtenOffStatus 'Ja', any discrepancyType), or it's a
// Kredittkort lisenskjøp mistake where the whole quantity was resold
// (resoldStatus 'Ja'). Takes priority over every other section below - a
// matching case is pulled out first, so it shows up only in its own
// section and never in Åpne avvik, Spesielle caser - Finance, or Sakseier
// ikke funnet. Same !a.resolved reasoning as isFinanceSectionCase above -
// once resolved, it drops out of this section too and ends up in Arkiv.
function isVismaStatusChangeCase(a) {
  if (a.resolved) return false;
  if (a.writtenOffStatus === 'Ja') return true;
  return a.discrepancyType === KREDITTKORT_LISENSKJOP_FEILAKTIG_MOTTATT && a.resoldStatus === 'Ja';
}

function splitAvvik(avvikList) {
  const vismaStatusChangeCases = avvikList.filter(isVismaStatusChangeCase).sort(byDaysWaitingDesc);
  const withoutVismaStatusChange = avvikList.filter((a) => !isVismaStatusChangeCase(a));
  const financeCases = withoutVismaStatusChange.filter(isFinanceSectionCase);
  const withoutFinance = withoutVismaStatusChange.filter((a) => !isFinanceSectionCase(a));
  const isOpenNoOwner = (a) => !a.resolved && NO_OWNER_NAMES.has(a.purchaserName);
  const noOwnerCases = withoutFinance.filter(isOpenNoOwner).sort(byDaysWaitingDesc);
  const rest = withoutFinance.filter((a) => !isOpenNoOwner(a));
  const open = rest.filter((a) => !a.resolved).sort(byUpdatedFirst);
  // Most recently resolved first, so the archive reads as a running history
  // (the "Løst" date column) rather than an arbitrary order. Ordered by
  // resolvedAt, not daysWaiting: an archived row's daysWaiting is frozen at
  // whatever it was when dwh last returned the line, since dwh no longer
  // returns it - the date it was closed is the meaningful ordering here.
  // Falls back to daysWaiting for any row without a resolvedAt.
  const resolved = rest
    .filter((a) => a.resolved)
    .sort((a, b) => String(b.resolvedAt || '').localeCompare(String(a.resolvedAt || '')) || byDaysWaitingDesc(a, b));
  return { financeCases, vismaStatusChangeCases, noOwnerCases, open, resolved };
}

const NAV_ITEMS = [
  { key: 'open', href: '/', label: 'Åpne avvik', icon: 'fa-list-check' },
  { key: 'finance', href: '/finance', label: 'Saker som løses av Finance', icon: 'fa-coins' },
  { key: 'archive', href: '/arkiv', label: 'Arkiv', icon: 'fa-box-archive' },
  { key: 'utvikling', href: '/utvikling', label: 'Utvikling', icon: 'fa-chart-line' },
];

function renderSkipLink() {
  return `<a class="skip-link" href="#main-content">Hopp til innhold</a>`;
}

function renderTopBar() {
  return `
  <header class="topbar">
    <div class="topbar-left">
      <button type="button" id="nav-toggle" class="icon-button" aria-expanded="false" aria-controls="side-nav" aria-label="Åpne meny">
        <i class="fa-solid fa-bars" aria-hidden="true"></i>
      </button>
      <span class="topbar-brand"><i class="fa-solid fa-warehouse" aria-hidden="true"></i>Lageravvik</span>
    </div>
    <button type="button" id="settings-toggle" class="icon-button" aria-expanded="false" aria-controls="settings-panel" aria-label="Innstillinger">
      <i class="fa-solid fa-gear" aria-hidden="true"></i>
    </button>
  </header>`;
}

function renderSideNav(activeKey) {
  const links = NAV_ITEMS.map((item) => {
    const isActive = item.key === activeKey;
    return `<li>
      <a href="${item.href}"${isActive ? ' class="active" aria-current="page"' : ''}>
        <i class="fa-solid ${item.icon}${isActive ? ' active-icon' : ''}" aria-hidden="true"></i>
        <span>${item.label}</span>
      </a>
    </li>`;
  }).join('');
  return `
  <nav id="side-nav" class="side-nav" aria-label="Hovedmeny"><ul>${links}</ul></nav>
  <div id="nav-backdrop" class="nav-backdrop" hidden></div>`;
}

function renderSettingsPanel() {
  return `
  <div id="settings-panel" class="settings-panel" role="dialog" aria-modal="true" aria-label="Innstillinger" hidden>
    <div class="settings-panel-header">
      <span class="bf-card-title">Innstillinger</span>
      <button type="button" id="settings-close" class="icon-button" aria-label="Lukk innstillinger">
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>
    </div>
    <fieldset class="settings-group">
      <legend>Fargemodus</legend>
      <label class="bf-radio"><input type="radio" name="color-mode" value="dark"><span>Mørk</span></label>
      <label class="bf-radio"><input type="radio" name="color-mode" value="light"><span>Lys</span></label>
      <label class="bf-radio"><input type="radio" name="color-mode" value="system"><span>Følg systeminnstilling</span></label>
    </fieldset>
  </div>`;
}

function renderToolbar() {
  return `
      <div class="toolbar">
        <button type="button" id="test-dwh" class="bf-button">Test tilkobling til dwh</button>
        <span id="test-dwh-result" class="test-dwh-result"></span>
        <button type="button" id="refresh-dwh" class="bf-button">Oppdater fra dwh</button>
        <span id="refresh-dwh-result" class="test-dwh-result"></span>
      </div>`;
}

const SHARED_SCRIPT = `
    // Side nav: docked-collapse on wide screens (>=960px), overlay drawer on
    // narrow ones. 'nav-collapsed' on <body> means the same thing at both
    // breakpoints (sidebar hidden/width 0), so aria-expanded below is never
    // inverted - only the overlay case adds focus trapping/backdrop, since
    // the wide-screen case is a plain layout collapse, not a modal.
    (function () {
      const navToggle = document.getElementById('nav-toggle');
      const sideNav = document.getElementById('side-nav');
      const backdrop = document.getElementById('nav-backdrop');
      if (!navToggle || !sideNav || !backdrop) return;
      const isOverlayMode = () => !window.matchMedia('(min-width: 960px)').matches;
      const isVisible = () => !document.body.classList.contains('nav-collapsed');
      const NAV_STORAGE_KEY = 'navCollapsed';
      function getStoredCollapsed() {
        try { return localStorage.getItem(NAV_STORAGE_KEY); } catch (e) { return null; }
      }
      function setStoredCollapsed(collapsed) {
        try { localStorage.setItem(NAV_STORAGE_KEY, collapsed ? 'true' : 'false'); } catch (e) {}
      }

      // Each page load is a fresh document, so without this the nav would
      // reset to the responsive default on every navigation. Instead, honor
      // the user's last explicit open/close choice; only fall back to the
      // responsive default (open on desktop, off-canvas on mobile) the very
      // first time, before any choice has been stored.
      const stored = getStoredCollapsed();
      const startCollapsed = stored === null ? isOverlayMode() : stored === 'true';
      if (startCollapsed) {
        document.body.classList.add('nav-collapsed');
      } else {
        document.body.classList.remove('nav-collapsed');
        navToggle.setAttribute('aria-expanded', 'true');
        navToggle.setAttribute('aria-label', 'Lukk meny');
      }

      function showNav() {
        document.body.classList.remove('nav-collapsed');
        navToggle.setAttribute('aria-expanded', 'true');
        navToggle.setAttribute('aria-label', 'Lukk meny');
        setStoredCollapsed(false);
        if (isOverlayMode()) {
          backdrop.hidden = false;
          const firstLink = sideNav.querySelector('a');
          if (firstLink) firstLink.focus();
        }
      }
      function hideNav({ returnFocus } = { returnFocus: true }) {
        document.body.classList.add('nav-collapsed');
        navToggle.setAttribute('aria-expanded', 'false');
        navToggle.setAttribute('aria-label', 'Åpne meny');
        backdrop.hidden = true;
        setStoredCollapsed(true);
        if (returnFocus) navToggle.focus();
      }
      navToggle.addEventListener('click', () => {
        if (isVisible()) hideNav();
        else showNav();
      });
      backdrop.addEventListener('click', () => hideNav());
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOverlayMode() && isVisible()) hideNav();
      });
    })();

    // Settings panel: color-mode radios apply immediately (no Save button).
    // 'system' means neither override class is present, so Bifrost's own
    // prefers-color-scheme handling takes over.
    (function () {
      const settingsToggle = document.getElementById('settings-toggle');
      const panel = document.getElementById('settings-panel');
      const closeBtn = document.getElementById('settings-close');
      if (!settingsToggle || !panel || !closeBtn) return;
      const radios = panel.querySelectorAll('input[name="color-mode"]');

      function currentMode() {
        try { return localStorage.getItem('bfColorMode') || 'dark'; } catch (e) { return 'dark'; }
      }
      function applyMode(mode) {
        document.documentElement.classList.remove('bf-darkmode', 'bf-lightmode');
        if (mode === 'dark') document.documentElement.classList.add('bf-darkmode');
        else if (mode === 'light') document.documentElement.classList.add('bf-lightmode');
        try { localStorage.setItem('bfColorMode', mode); } catch (e) {}
      }
      function openPanel() {
        const mode = currentMode();
        radios.forEach((r) => { r.checked = r.value === mode; });
        panel.hidden = false;
        settingsToggle.setAttribute('aria-expanded', 'true');
        const firstRadio = panel.querySelector('input[name="color-mode"]');
        if (firstRadio) firstRadio.focus();
      }
      function closePanel({ returnFocus } = { returnFocus: true }) {
        panel.hidden = true;
        settingsToggle.setAttribute('aria-expanded', 'false');
        if (returnFocus) settingsToggle.focus();
      }
      settingsToggle.addEventListener('click', () => {
        if (panel.hidden) openPanel();
        else closePanel();
      });
      closeBtn.addEventListener('click', () => closePanel());
      document.addEventListener('click', (e) => {
        if (!panel.hidden && !panel.contains(e.target) && e.target !== settingsToggle && !settingsToggle.contains(e.target)) {
          closePanel({ returnFocus: false });
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !panel.hidden) closePanel();
      });
      radios.forEach((radio) => {
        radio.addEventListener('change', () => { if (radio.checked) applyMode(radio.value); });
      });
    })();

    // Back link on the avvik detail page: prefer history.back() so the
    // browser restores the previous "Åpne avvik" page (filters, sort,
    // scroll position) from its own cache, rather than a fresh server
    // render with everything reset. Falls back to the plain href="/" when
    // there's no history to go back to (e.g. the page was opened directly).
    (function () {
      const backLink = document.getElementById('back-link');
      if (!backLink) return;
      backLink.addEventListener('click', (e) => {
        if (window.history.length > 1) {
          e.preventDefault();
          window.history.back();
        }
      });
    })();

    // Clicking (or pressing Enter/Space while focused on) an avvik row that
    // isn't itself interactive navigates straight to that avvik's detail
    // page - the same target as its old "Dette må gjøres"/"Mer informasjon"
    // link, just without an intermediate expand step. A <tr> isn't natively
    // clickable/focusable, hence tabindex + the explicit keydown handling.
    document.querySelectorAll('.avvik-row[data-href]').forEach((row) => {
      const isOwnInteractive = (e) => e.target.closest('button, a, input, textarea, select, form, details, summary');
      row.addEventListener('click', (e) => {
        if (isOwnInteractive(e)) return;
        window.location.href = row.dataset.href;
      });
      row.addEventListener('keydown', (e) => {
        if (isOwnInteractive(e)) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          window.location.href = row.dataset.href;
        }
      });
    });
    document.querySelectorAll('.resolve').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await fetch('/api/avvik/' + btn.dataset.id + '/resolve', { method: 'POST' });
        location.reload();
      });
    });
    document.querySelectorAll('.reopen').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await fetch('/api/avvik/' + btn.dataset.id + '/reopen', { method: 'POST' });
        location.reload();
      });
    });
    const testDwhBtn = document.getElementById('test-dwh');
    if (testDwhBtn) testDwhBtn.addEventListener('click', async () => {
      const out = document.getElementById('test-dwh-result');
      out.textContent = 'Kobler til...';
      out.className = 'test-dwh-result';
      try {
        const res = await fetch('/api/dwh/test-connection', { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.ok) {
          out.textContent = 'Tilkobling til dwh OK.';
          out.className = 'test-dwh-result ok';
        } else {
          out.textContent = 'Feilet: ' + (data.error || res.status);
          out.className = 'test-dwh-result fail';
        }
      } catch (err) {
        out.textContent = 'Feilet: ' + err.message;
        out.className = 'test-dwh-result fail';
      }
    });
    const refreshDwhBtn = document.getElementById('refresh-dwh');
    if (refreshDwhBtn) refreshDwhBtn.addEventListener('click', async () => {
      const out = document.getElementById('refresh-dwh-result');
      out.textContent = 'Oppdaterer...';
      out.className = 'test-dwh-result';
      try {
        const res = await fetch('/api/dwh/refresh-avvik', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          out.textContent = data.updated + ' oppdatert, ' + data.inserted + ' nye, ' + data.markedMissing + ' savnet.';
          out.className = 'test-dwh-result ok';
          location.reload();
        } else {
          out.textContent = 'Feilet: ' + (data.error || res.status);
          out.className = 'test-dwh-result fail';
        }
      } catch (err) {
        out.textContent = 'Feilet: ' + err.message;
        out.className = 'test-dwh-result fail';
      }
    });
    document.querySelectorAll('.add-comment').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = form.dataset.id;
        const author = form.author.value;
        const text = form.text.value;
        const errorEl = form.querySelector('.form-error');
        const fail = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };
        errorEl.hidden = true;
        const files = form.files ? [...form.files.files] : [];
        // Kommentar med vedlegg sendes som multipart, uten vedlegg som JSON.
        let req;
        if (files.length) {
          if (files.length > ${MAX_FILES}) return fail('Maks ${MAX_FILES} vedlegg per kommentar.');
          const tooBig = files.find((f) => f.size > ${MAX_FILE_BYTES});
          if (tooBig) return fail('«' + tooBig.name + '» er større enn ${MAX_FILE_BYTES / (1024 * 1024)} MB.');
          const data = new FormData();
          data.append('author', author);
          data.append('text', text);
          files.forEach((f) => data.append('files', f));
          req = { method: 'POST', body: data };
        } else {
          req = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author, text }) };
        }
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
          const res = await fetch('/api/avvik/' + id + '/comments', req);
          if (res.ok) return location.reload();
          const err = await res.json().catch(() => ({}));
          fail(err.error || 'Kunne ikke lagre kommentaren (' + res.status + ').');
        } catch (e2) {
          fail('Kunne ikke lagre kommentaren: ' + e2.message);
        }
        submit.disabled = false;
      });
    });
    // Arkivet: "Endre" ved avvikstypen bytter badgen ut med en nedtrekksliste.
    // Et valg lagres på serveren (PATCH .../type) og siden lastes på nytt;
    // "Avbryt" eller Escape legger tilbake den opprinnelige cellen.
    const DISCREPANCY_TYPES = ${JSON.stringify([...ALL_DISCREPANCY_TYPES, UNKNOWN_HISTORY_TYPE])};
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.change-type');
      if (!btn) return;
      const cell = btn.closest('td.type-cell');
      if (!cell || cell.querySelector('select')) return;
      const original = [...cell.childNodes];
      const select = document.createElement('select');
      select.className = 'bf-input type-select';
      select.setAttribute('aria-label', 'Avvikstype');
      DISCREPANCY_TYPES.forEach((type) => {
        const opt = document.createElement('option');
        opt.value = type; opt.textContent = type;
        if (type === cell.dataset.current) opt.selected = true;
        select.appendChild(opt);
      });
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.className = 'bf-link comment-action'; cancel.textContent = 'Avbryt';
      const restore = () => cell.replaceChildren(...original);
      cancel.addEventListener('click', restore);
      select.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') restore(); });
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          const res = await fetch('/api/avvik/' + encodeURIComponent(cell.dataset.id) + '/type', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: select.value }),
          });
          if (res.ok) return location.reload();
          window.alert('Kunne ikke lagre avvikstypen (' + res.status + ').');
        } catch (err) {
          window.alert('Kunne ikke lagre avvikstypen: ' + err.message);
        }
        restore();
      });
      cell.replaceChildren(select, cancel);
      select.focus();
    });
    // Rette en kommentar og fjerne vedlegg. Delegerte klikk, siden listene
    // finnes i hver rad og på detaljsiden. Begge endringer lagres på serveren
    // og siden lastes på nytt, som ved nye kommentarer.
    document.addEventListener('click', async (e) => {
      const removeBtn = e.target.closest('.remove-attachment');
      if (removeBtn) {
        if (!window.confirm('Fjerne vedlegget «' + removeBtn.dataset.name + '»? Filen slettes.')) return;
        removeBtn.disabled = true;
        try {
          const res = await fetch(
            '/api/avvik/' + encodeURIComponent(removeBtn.dataset.avvik) + '/comments/' + removeBtn.dataset.comment +
              '/attachments/' + encodeURIComponent(removeBtn.dataset.attachment),
            { method: 'DELETE' }
          );
          if (res.ok) return location.reload();
          window.alert('Kunne ikke fjerne vedlegget (' + res.status + ').');
        } catch (err) {
          window.alert('Kunne ikke fjerne vedlegget: ' + err.message);
        }
        removeBtn.disabled = false;
        return;
      }
      const editBtn = e.target.closest('.edit-comment');
      if (!editBtn) return;
      const li = editBtn.closest('li[data-comment]');
      if (!li || li.querySelector('.edit-comment-form')) return;
      const body = li.querySelector('.comment-body');
      const form = document.createElement('form');
      form.className = 'edit-comment-form';
      const author = document.createElement('input');
      author.type = 'text'; author.className = 'bf-input'; author.name = 'author'; author.required = true; author.maxLength = 100;
      author.value = li.dataset.author; author.setAttribute('aria-label', 'Navn');
      const text = document.createElement('input');
      text.type = 'text'; text.className = 'bf-input'; text.name = 'text'; text.required = true; text.maxLength = 2000;
      text.value = li.dataset.text; text.setAttribute('aria-label', 'Kommentar');
      const save = document.createElement('button');
      save.type = 'submit'; save.className = 'bf-button bf-button-small'; save.textContent = 'Lagre';
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.className = 'bf-button bf-button-small'; cancel.textContent = 'Avbryt';
      const error = document.createElement('p');
      error.className = 'form-error'; error.setAttribute('role', 'alert'); error.hidden = true;
      form.append(author, text, save, cancel, error);
      body.hidden = true;
      body.after(form);
      text.focus();
      cancel.addEventListener('click', () => { form.remove(); body.hidden = false; });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        error.hidden = true;
        save.disabled = true;
        try {
          const res = await fetch(
            '/api/avvik/' + encodeURIComponent(li.dataset.avvik) + '/comments/' + li.dataset.comment,
            { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author: author.value, text: text.value }) }
          );
          if (res.ok) return location.reload();
          const err = await res.json().catch(() => ({}));
          error.textContent = err.error || 'Kunne ikke lagre rettelsen (' + res.status + ').';
        } catch (err2) {
          error.textContent = 'Kunne ikke lagre rettelsen: ' + err2.message;
        }
        error.hidden = false;
        save.disabled = false;
      });
    });
    document.querySelectorAll('.set-purchaser').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = form.dataset.id;
        const name = form.name.value;
        const email = form.email.value;
        const res = await fetch('/api/avvik/' + id + '/purchaser', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email }),
        });
        if (res.ok) location.reload();
      });
    });
    document.querySelectorAll('.preview-email').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const pre = document.querySelector('.email-preview[data-id="' + id + '"]');
        if (!pre.hidden) {
          pre.hidden = true;
          btn.textContent = 'Vis e-posteksempel';
          return;
        }
        pre.hidden = false;
        pre.textContent = 'Laster e-posteksempel...';
        btn.textContent = 'Skjul e-posteksempel';
        try {
          const res = await fetch('/api/avvik/' + id + '/preview-email');
          if (!res.ok) {
            pre.textContent = 'Kunne ikke laste e-posteksempel (' + res.status + ').';
            return;
          }
          const data = await res.json();
          pre.textContent = 'Til: ' + data.to + '\\nEmne: ' + data.subject + '\\n\\n' + data.body;
        } catch (err) {
          pre.textContent = 'Kunne ikke laste e-posteksempel: ' + err.message;
        }
      });
    });
    // Each section with a filter row is scoped independently, so identically-
    // named filter boxes in different sections/pages don't clobber each other.
    document.querySelectorAll('#open-section, #finance-section, #no-owner-section, #archive-section').forEach((section) => {
      const filterInputs = section.querySelectorAll('.filter-input');
      // Pil ved siden av hvert filterfelt som åpner en søkbar rullgardin med
      // alle ulike verdier i kolonnen. Panelet er position: fixed (tabellkortet
      // har overflow: hidden) og får nøyaktig kolonnens bredde. Valg setter
      // filterfeltet og sender et vanlig input-event, så filtreringen og
      // grafen reagerer som om verdien var skrevet inn.
      function closeCombo() {
        const s = window.__avvikCombo;
        if (!s) return;
        window.__avvikCombo = null;
        s.panel.remove();
        s.arrow.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', s.onOutside, true);
        window.removeEventListener('scroll', s.onScroll, true);
        window.removeEventListener('resize', closeCombo);
      }
      function openCombo(input, arrow, cell) {
        const wasOpen = window.__avvikCombo && window.__avvikCombo.input === input;
        closeCombo();
        if (wasOpen) return;
        const values = new Set();
        section.querySelectorAll('.avvik-row').forEach((row) => {
          const v = (row.getAttribute('data-label-' + input.dataset.col) || '').trim();
          if (v) values.add(v);
        });
        const sorted = [...values].sort((x, y) => x.localeCompare(y, 'no', { numeric: true }));
        const panel = document.createElement('div');
        panel.className = 'combo-panel';
        const search = document.createElement('input');
        search.type = 'text';
        search.className = 'bf-input combo-search';
        search.placeholder = 'Søk...';
        search.autocomplete = 'off';
        const list = document.createElement('ul');
        list.className = 'combo-list';
        list.setAttribute('role', 'listbox');
        panel.append(search, list);
        let active = -1;
        function select(v) {
          input.value = v;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          closeCombo();
        }
        function setActive(i) {
          const items = list.querySelectorAll('.combo-option');
          if (!items.length) { active = -1; return; }
          active = (i + items.length) % items.length;
          items.forEach((li, idx) => li.classList.toggle('combo-active', idx === active));
          items[active].scrollIntoView({ block: 'nearest' });
        }
        function render() {
          const q = search.value.trim().toLowerCase();
          const current = input.value.trim().toLowerCase();
          list.textContent = '';
          const entries = q ? [] : [{ label: 'Alle', value: '' }];
          sorted.forEach((v) => { if (v.toLowerCase().includes(q)) entries.push({ label: v, value: v }); });
          entries.forEach((e) => {
            const li = document.createElement('li');
            li.className = 'combo-option' + (e.value && e.value.toLowerCase() === current ? ' combo-selected' : '');
            li.setAttribute('role', 'option');
            li.textContent = e.label;
            li.addEventListener('click', () => select(e.value));
            list.appendChild(li);
          });
          if (!list.children.length) {
            const li = document.createElement('li');
            li.className = 'combo-empty';
            li.textContent = 'Ingen treff';
            list.appendChild(li);
          }
          active = -1;
        }
        render();
        search.addEventListener('input', () => { render(); setActive(0); });
        search.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { closeCombo(); arrow.focus(); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
          else if (e.key === 'Enter') {
            e.preventDefault();
            const items = list.querySelectorAll('.combo-option');
            if (items[active >= 0 ? active : 0]) items[active >= 0 ? active : 0].click();
          }
        });
        const r = cell.getBoundingClientRect();
        panel.style.left = r.left + 'px';
        panel.style.width = r.width + 'px';
        const below = window.innerHeight - r.bottom - 12;
        if (below >= 200 || below >= r.top) {
          panel.style.top = r.bottom + 'px';
          panel.style.maxHeight = Math.max(below, 120) + 'px';
        } else {
          panel.style.bottom = (window.innerHeight - r.top) + 'px';
          panel.style.maxHeight = Math.max(r.top - 12, 120) + 'px';
        }
        document.body.appendChild(panel);
        arrow.setAttribute('aria-expanded', 'true');
        const state = {
          input, arrow, panel,
          onOutside: (e) => { if (!panel.contains(e.target) && !arrow.contains(e.target)) closeCombo(); },
          onScroll: (e) => { if (!panel.contains(e.target)) closeCombo(); },
        };
        window.__avvikCombo = state;
        document.addEventListener('mousedown', state.onOutside, true);
        window.addEventListener('scroll', state.onScroll, true);
        window.addEventListener('resize', closeCombo);
        search.focus();
      }
      // Pilen står i overskriftscellen (samme kolonne som filterfeltet), rett
      // etter teksten "Ordre", "PO-nummer" osv.
      filterInputs.forEach((el) => {
        const filterCell = el.closest('th');
        // Skjult leverandørfilter (fra Utvikling-diagrammet) har ingen kolonne.
        if (!filterCell) return;
        const headRow = filterCell.closest('thead').rows[0];
        const headCell = headRow.cells[filterCell.cellIndex];
        const arrow = document.createElement('button');
        arrow.type = 'button';
        arrow.className = 'filter-arrow';
        const label = headCell.textContent.trim();
        arrow.setAttribute('aria-label', 'Vis alle verdier for ' + label);
        arrow.setAttribute('aria-haspopup', 'listbox');
        arrow.setAttribute('aria-expanded', 'false');
        arrow.innerHTML = '<i class="fa-solid fa-chevron-down" aria-hidden="true"></i>';
        headCell.appendChild(arrow);
        // Markerer pilen når kolonnen er filtrert, siden filterfeltet er skjult.
        const syncActive = () => arrow.classList.toggle('filter-active', el.value.trim() !== '');
        el.addEventListener('input', syncActive);
        el.addEventListener('change', syncActive);
        syncActive();
        arrow.addEventListener('click', (e) => {
          e.stopPropagation();
          openCombo(el, arrow, headCell);
        });
      });
      // Only #open-section has a matching stat card - null elsewhere, and
      // every use below is guarded on it.
      const filteredCountEl = section.id === 'open-section' ? document.getElementById('filtered-count') : null;
      function applyFilters() {
        const filters = {};
        filterInputs.forEach((el) => {
          const value = el.value.trim().toLowerCase();
          if (value) filters[el.dataset.col] = value;
        });
        const rows = section.querySelectorAll('.avvik-row');
        let visibleCount = 0;
        rows.forEach((row) => {
          // Leverandør matches helt (ikke delvis), så "Arrow" ikke treffer "Arrow ECS".
          const match = Object.keys(filters).every((col) =>
            col === 'supplier' ? row.dataset[col] === filters[col] : row.dataset[col].includes(filters[col])
          );
          row.hidden = !match;
          if (match) visibleCount++;
        });
        if (filteredCountEl) {
          const hasFilter = Object.keys(filters).length > 0;
          filteredCountEl.hidden = !hasFilter;
          filteredCountEl.textContent = hasFilter ? 'Viser ' + visibleCount + ' av ' + rows.length : '';
        }
      }
      filterInputs.forEach((el) => {
        el.addEventListener('input', applyFilters);
        el.addEventListener('change', applyFilters);
      });
      // Lenke fra stolpene i leverandørdiagrammet: /?leverandor=<navn> filtrerer
      // listen på den leverandøren. Chipen over tabellen viser filteret og
      // fjerner det igjen (også når et annet filter nullstiller feltet).
      const supplierInput = section.querySelector('.filter-input[data-col="supplier"]');
      if (supplierInput) {
        const chip = document.getElementById('supplier-chip');
        const chipName = document.getElementById('supplier-chip-name');
        const syncChip = () => {
          const v = supplierInput.value.trim();
          chip.hidden = !v;
          chipName.textContent = v;
        };
        // Alle filterfelt, siden Topp 5/diagrammene tømmer de andre feltene.
        filterInputs.forEach((el) => el.addEventListener('input', syncChip));
        document.getElementById('supplier-chip-clear').addEventListener('click', () => {
          supplierInput.value = '';
          supplierInput.dispatchEvent(new Event('input', { bubbles: true }));
          history.replaceState(null, '', location.pathname);
        });
        const fromUrl = new URLSearchParams(location.search).get('leverandor');
        if (fromUrl) {
          supplierInput.value = fromUrl;
          supplierInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });
    // Clicking a name in "Topp 5", a donut legend entry, or a donut segment
    // sets the matching filter box on the open-avvik list and re-runs its
    // existing filter logic (above) via a plain input event - no separate
    // filtering logic needed here. Clicking the same value again clears it
    // (toggle), rather than just re-setting the same filter. A new selection
    // always replaces whatever filter (click-driven or typed) was active
    // before, rather than combining with it, so every other filter-input is
    // cleared first.
    document.querySelectorAll('[data-filter-col]').forEach((el) => {
      el.addEventListener('click', () => {
        const input = document.querySelector(
          '#open-section .filter-input[data-col="' + el.dataset.filterCol + '"]'
        );
        if (!input) return;
        const alreadyActive = input.value.trim().toLowerCase() === el.dataset.filterValue;
        document.querySelectorAll('#open-section .filter-input').forEach((otherInput) => {
          if (otherInput !== input) otherInput.value = '';
        });
        input.value = alreadyActive ? '' : el.dataset.filterValue;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });`;

const SHARED_STYLE = `
  * { box-sizing: border-box; }
  body { font-family: var(--font-open-sans, "Open Sans"), "Segoe UI", sans-serif; margin: 0; display: flex; flex-direction: column; min-height: 100vh; }
  h1, h2, h3 { font-family: var(--font-satoshi, Satoshi), "Segoe UI", sans-serif; }

  .skip-link { position: absolute; left: var(--bfs16); top: -3rem; background: var(--bfc-base-3); color: var(--bfc-base-c); padding: var(--bfs8) var(--bfs16); border-radius: var(--bf-radius-s); z-index: 100; transition: top 0.15s ease; }
  .skip-link:focus { top: var(--bfs16); }

  .topbar { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--bfs16); padding: var(--bfs16); background: var(--bfc-base-2); border-bottom: var(--bf-border); }
  .topbar-left { display: flex; align-items: center; gap: var(--bfs12); }
  .topbar-brand { display: flex; align-items: center; gap: var(--bfs8); font-weight: 700; font-size: var(--bf-font-size-h2); color: var(--bfc-base-c); }
  .icon-button { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; padding: 0; border: none; background: transparent; color: var(--bfc-base-c); border-radius: var(--bf-radius-s); cursor: pointer; font-size: var(--bf-font-size-l); }
  .icon-button:hover { background: var(--bfc-theme-fade); }

  .body-row { flex: 1 1 auto; display: flex; min-height: 0; }

  .side-nav { width: 17rem; flex-shrink: 0; background: var(--bfc-base-2); border-right: var(--bf-border); padding: var(--bfs24) var(--bfs16); overflow-y: auto; overflow-x: hidden; transition: width 0.15s ease, padding 0.15s ease; }
  .side-nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--bfs4); }
  .side-nav a { display: flex; align-items: center; gap: var(--bfs12); min-height: 44px; padding: var(--bfs8) var(--bfs12); border-radius: var(--bf-radius-s); color: var(--bfc-base-c); text-decoration: none; font-size: var(--bf-font-size-m); white-space: nowrap; }
  .side-nav a i { width: 1.1em; text-align: center; color: var(--bfc-base-c-dimmed); }
  .side-nav a i.active-icon { color: var(--bfc-theme); }
  .side-nav a:hover { background: var(--bfc-theme-fade); }
  .side-nav a.active { background: var(--bfc-shadow); font-weight: 600; }

  .nav-backdrop { display: none; }

  /* 'nav-collapsed' on <body> means "sidebar hidden" at both breakpoints.
     Wide screens: side nav is a docked column by default; collapsing it
     takes it to width 0 and .main fills the freed-up space. Narrow screens:
     side nav is off-canvas by default (a fixed overlay drawer over a
     --bfc-shadow backdrop) and slides in when NOT collapsed. */
  @media (min-width: 960px) {
    body.nav-collapsed .side-nav { width: 0; padding-left: 0; padding-right: 0; border-right: none; }
  }
  @media (max-width: 959px) {
    .side-nav { position: fixed; top: 0; left: 0; height: 100vh; width: 17rem; transform: translateX(-100%); transition: transform 0.15s ease; z-index: 40; }
    body:not(.nav-collapsed) .side-nav { transform: translateX(0); }
    .nav-backdrop { display: block; position: fixed; inset: 0; background: var(--bfc-shadow); z-index: 30; }
    .nav-backdrop[hidden] { display: none; }
  }

  .settings-panel { position: fixed; top: 4.5rem; right: var(--bfs16); width: 18rem; background: var(--bfc-base-2); border: var(--bf-border); border-radius: var(--bf-radius-m); box-shadow: 0 4px 12px var(--bfc-shadow); padding: var(--bfs16); z-index: 50; }
  .settings-panel[hidden] { display: none; }
  .settings-panel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--bfs16); }
  .settings-group { border: none; padding: 0; margin: 0 0 var(--bfs16); }
  .settings-group legend { font-size: var(--bf-font-size-s); color: var(--bfc-base-c-dimmed); margin-bottom: var(--bfs8); padding: 0; }
  .settings-group .bf-radio { display: flex; align-items: center; gap: var(--bfs8); min-height: 44px; }

  .main { flex: 1 1 auto; min-width: 0; overflow-x: auto; }
  .page { max-width: none; margin: 0; padding: var(--bfs40) var(--bfs32) var(--bfs80); }
  .page-header { margin-bottom: var(--bfs32); }
  .page-header h1 { margin: var(--bfs8) 0 var(--bfs4); font-size: var(--bf-font-size-h1); }
  /* Icon links (see renderAvvikDetailPage's headerActions) sit right beside
     the h1 rather than in their own section, so they're immediately visible
     alongside the case they belong to. */
  .page-header-heading { display: flex; align-items: center; gap: var(--bfs16); flex-wrap: wrap; }
  .toolbar { margin-top: var(--bfs16); display: flex; align-items: center; gap: var(--bfs12); flex-wrap: wrap; }
  .test-dwh-result { font-size: var(--bf-font-size-s); }
  .test-dwh-result.ok { color: var(--bfc-success); }
  .test-dwh-result.fail { color: var(--bfc-alert); }
  section { margin-top: var(--bfs48); }
  .section-header { display: flex; align-items: center; gap: var(--bfs12); margin-bottom: var(--bfs16); }
  .section-header h2 { margin: 0; }
  .section-note { margin: 0 0 var(--bfs12); color: var(--bfc-base-c-dimmed); font-size: var(--bf-font-size-s); }
  .section-card { background: var(--bfc-base-3); border-radius: var(--bf-radius-m); border: var(--bf-border); overflow: hidden; box-shadow: 0 1px 3px var(--bfc-shadow); }
  .section-card .bf-table { margin: 0; }
  details summary { cursor: pointer; }
  ul.comments, ul.notif-history { list-style: none; padding: 0; margin: var(--bfs8) 0; }
  ul.comments li, ul.notif-history li { padding: var(--bfs4) 0; border-bottom: var(--bf-border); font-size: var(--bf-font-size-s); }
  ul.comments li.empty, ul.notif-history li.empty { color: var(--bfc-base-c); font-style: italic; }
  ul.comments .ts { color: var(--bfc-base-c); font-size: var(--bf-font-size-s); }
  .comments-section h2 { font-size: var(--bf-font-size-h2); margin: 0 0 var(--bfs16); }
  .comments-section ul.comments { margin: 0; }
  .comments-section ul.comments li { font-size: var(--bf-font-size-m); }
  .comments-section ul.comments li:last-child { border-bottom: none; }
  @media (max-width: 480px) { .comments-section h2 { font-size: var(--bf-font-size-h3); } }
  /* Status i åpne avvik: bare en ramme i en Bifrost-farge, ingen fyllfarge
     (Bifrost har ingen oransje; --bfc-warning er den varme). Samme firkantede
     form og høyde som avvikstype-badgen (.bf-badge: 4px radius, 25px), men
     med tabellens vanlige skrift (arvet fra cellen) og tekstfarge. */
  .status-pill { display: inline-block; box-sizing: border-box; padding: 0 6px; border: 2px solid var(--pill-color); border-radius: 4px; background: transparent; color: inherit; font: inherit; line-height: 21px; white-space: nowrap; }
  .status-pill-waiting { --pill-color: var(--bfc-warning); }
  .status-pill-updated { --pill-color: var(--bfc-success); }
  select.type-select { width: auto; max-width: 100%; font-size: var(--bf-font-size-s); padding: var(--bfs4) var(--bfs8); }
  .comment-action { margin-left: var(--bfs8); padding: 0; border: none; background: transparent; cursor: pointer; font-size: var(--bf-font-size-s); text-decoration: underline; }
  .comment-action:disabled { opacity: 0.5; cursor: default; }
  form.edit-comment-form { display: flex; gap: var(--bfs8); flex-wrap: wrap; margin-top: var(--bfs4); }
  form.edit-comment-form .bf-input { width: auto; flex: 1 1 10rem; }
  form.edit-comment-form .form-error { width: 100%; margin: 0; font-size: var(--bf-font-size-s); font-weight: 600; }
  form.edit-comment-form .form-error:not([hidden])::before { content: "\\26A0\\FE0E  "; }
  ul.comments ul.attachments { list-style: none; margin: var(--bfs4) 0 0; padding: 0; }
  ul.comments ul.attachments li { padding: 0; border-bottom: none; }
  form.add-comment .file-pick { display: flex; flex-direction: column; gap: var(--bfs4); width: 100%; font-size: var(--bf-font-size-s); color: var(--bfc-base-c); }
  form.add-comment .form-error { width: 100%; margin: 0; color: var(--bfc-base-c); font-size: var(--bf-font-size-s); font-weight: 600; }
  form.add-comment .form-error:not([hidden])::before { content: "\\26A0\\FE0E  "; }
  form.add-comment .bf-input::placeholder { color: var(--bfc-base-c); opacity: 0.8; }
  /* "Legg til kommentar": summary i knappestil ("Marker løst"), uten
     standard trekant. */
  summary.comment-button { display: inline-flex; list-style: none; cursor: pointer; white-space: nowrap; }
  summary.comment-button::-webkit-details-marker { display: none; }
  form.add-comment { margin-top: var(--bfs8); display: flex; gap: var(--bfs8); flex-wrap: wrap; }
  form.add-comment .bf-input { width: auto; }
  form.set-purchaser { display: flex; gap: var(--bfs8); flex-wrap: wrap; }
  form.set-purchaser .bf-input { width: auto; min-width: 8rem; }
  .preview-email { margin-top: var(--bfs8); }
  .email-preview { white-space: pre-wrap; background: var(--bfc-base-2); border: var(--bf-border); border-radius: var(--bf-radius-s); padding: var(--bfs12); margin-top: var(--bfs8); font-size: var(--bf-font-size-s); max-width: 32rem; }
  .stats { display: flex; gap: var(--bfs16); flex-wrap: wrap; }
  #trend-section { display: flex; min-width: 0; margin: 0; }
  .trend-card { flex: 1; display: flex; min-width: 0; box-shadow: 0 1px 3px var(--bfc-shadow); }
  .trend-card .bf-card-content { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .trend-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--bfs8); flex-wrap: wrap; }
  .trend-title { font-size: var(--bf-font-size-m); font-weight: 600; color: var(--bfc-base-c); }
  .trend-legend { display: flex; align-items: center; gap: var(--bfs12); font-size: var(--bf-font-size-s); color: var(--bfc-base-c); }
  .trend-legend [hidden] { display: none; }
  .legend-line { display: inline-block; width: 1.25rem; border-top: 2px solid; vertical-align: middle; margin-right: var(--bfs4); }
  .legend-total { border-color: var(--bfc-theme); }
  .legend-filter { border-color: var(--bfc-base-c); }
  .trend-chart { position: relative; flex: 1; min-height: 11rem; margin-top: var(--bfs8); }
  .trend-svg { position: absolute; inset: 0; }
  .trend-grid { stroke: var(--bfc-base-c); stroke-opacity: 0.15; stroke-width: 1; }
  .trend-line { stroke: var(--bfc-theme); stroke-width: 2; stroke-linejoin: round; fill: none; }
  .trend-line-filter { stroke: var(--bfc-base-c); stroke-width: 2; stroke-linejoin: round; fill: none; }
  .trend-label { fill: var(--bfc-base-c); fill-opacity: 0.7; font-size: 10px; }
  .trend-hit { fill: transparent; }
  .trend-hit:hover { fill: var(--bfc-theme); }
  .trend-note { color: var(--bfc-base-c); opacity: 0.7; font-size: var(--bf-font-size-s); margin-top: var(--bfs4); }
  /* Utvikling-siden: grafen og leverandørdiagrammet får hele bredden. */
  .utvikling-page { display: flex; flex-direction: column; gap: var(--bfs24); }
  .utvikling-trend .trend-chart { min-height: 20rem; }
  .supplier-card { box-shadow: 0 1px 3px var(--bfc-shadow); }
  .chart-sub { margin: var(--bfs4) 0 var(--bfs12); color: var(--bfc-base-c); opacity: 0.7; font-size: var(--bf-font-size-s); }
  .bar-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .bar-row { display: grid; grid-template-columns: minmax(8rem, 18rem) minmax(0, 1fr); align-items: center; gap: var(--bfs12); padding: 3px var(--bfs8); border-radius: var(--bf-radius-s); outline-offset: -2px; }
  .bar-row:hover, .bar-row:focus-visible { background: var(--bfc-theme-fade); }
  a.bar-row { color: inherit; text-decoration: none; cursor: pointer; }
  .filter-chip { display: inline-flex; align-items: center; gap: var(--bfs4); margin-bottom: var(--bfs12); padding: var(--bfs4) var(--bfs4) var(--bfs4) var(--bfs12); background: var(--bfc-theme-fade); border: var(--bf-border); border-radius: var(--bf-radius-full); font-size: var(--bf-font-size-s); }
  .filter-chip[hidden] { display: none; }
  .chip-clear { min-width: 28px; min-height: 28px; }
  .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--bf-font-size-s); color: var(--bfc-base-c); text-align: right; }
  .bar-track { position: relative; height: 18px; margin-right: 3rem; border-left: 1px solid var(--bfc-base-c); border-left-color: color-mix(in srgb, var(--bfc-base-c) 35%, transparent); }
  .bar-fill { display: block; height: 100%; min-width: 2px; background: var(--bfc-theme); border-radius: 0 4px 4px 0; }
  .bar-value { position: absolute; top: 50%; transform: translateY(-50%); margin-left: 6px; font-size: var(--bf-font-size-s); font-weight: 600; color: var(--bfc-base-c); white-space: nowrap; }
  .chart-tooltip { position: fixed; z-index: 70; pointer-events: none; background: var(--bfc-base-3); color: var(--bfc-base-c); border: var(--bf-border); border-radius: var(--bf-radius-s); box-shadow: 0 4px 12px var(--bfc-shadow); padding: var(--bfs8) var(--bfs12); font-size: var(--bf-font-size-s); max-width: 22rem; }
  .chart-tooltip strong { display: block; font-size: var(--bf-font-size-m); }
  .chart-table { margin-top: var(--bfs12); }
  .chart-table table { margin-top: var(--bfs8); max-width: 36rem; }
  .chart-table td:last-child, .chart-table th:last-child { text-align: right; }
  .stats .bf-card { min-width: 10rem; box-shadow: 0 1px 3px var(--bfc-shadow); }
  .stat-number { font-size: var(--bf-font-size-h2); font-weight: 700; color: var(--bfc-base-c); }
  .stat-label { color: var(--bfc-base-c); font-size: var(--bf-font-size-l); font-weight: 600; }
  .stat-sublabel { color: var(--bfc-base-c); font-size: var(--bf-font-size-s); margin-top: var(--bfs4); opacity: 0.85; }
  .bf-card-title { font-size: var(--bf-font-size-l); font-weight: 600; color: var(--bfc-base-c); }
  .top-list-card { min-width: 20rem; flex: 1 1 20rem; }
  .top-list { margin: var(--bfs4) 0 0; padding-left: var(--bfs16); font-size: var(--bf-font-size-m); color: var(--bfc-base-c); }
  .top-list li { break-inside: avoid; }
  .donut-card { min-width: 20rem; flex: 1 1 20rem; }
  .donut-wrap { display: flex; align-items: center; gap: var(--bfs16); flex-wrap: wrap; }
  .donut { width: 8rem; height: 8rem; flex-shrink: 0; transform: rotate(0deg); }
  .donut-legend { list-style: none; margin: 0; padding: 0; font-size: var(--bf-font-size-m); flex: 1 1 12rem; color: var(--bfc-base-c); columns: 2 12rem; column-gap: var(--bfs16); }
  .donut-legend li { display: flex; align-items: center; gap: var(--bfs8); padding: var(--bfs2) 0; break-inside: avoid; }
  .donut-legend li.empty { color: var(--bfc-base-c-dimmed); font-style: italic; }
  .legend-swatch { display: inline-block; width: 0.7rem; height: 0.7rem; border-radius: var(--bf-radius-full); flex-shrink: 0; }
  .clickable { cursor: pointer; }
  li.clickable:hover, .top-list li.clickable:hover { text-decoration: underline; }
  circle.clickable:hover { opacity: 0.8; }
  /* Filterraden vises ikke lenger: filterfeltene ligger skjult i DOM-en og
     settes fra rullgardinene (pil i overskriften) og fra klikk på diagram/
     Topp 5, slik at filtrering og graf bruker samme input-events som før. */
  .filter-row { display: none; }
  .filter-row th { padding-top: var(--bfs8); padding-bottom: var(--bfs8); background: var(--bfc-base-2); }
  .filter-row .bf-input { font-size: var(--bf-font-size-s); padding: var(--bfs4) var(--bfs8); width: 100%; min-width: 9rem; }
  .filter-arrow { display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; width: 1.75rem; height: 1.75rem; margin-left: var(--bfs4); padding: 0; border: none; background: transparent; color: var(--bfc-base-c); border-radius: var(--bf-radius-s); cursor: pointer; font-size: var(--bf-font-size-s); }
  .filter-arrow:hover, .filter-arrow[aria-expanded="true"] { color: var(--bfc-base-c); background: var(--bfc-theme-fade); }
  .filter-arrow.filter-active { color: var(--bfc-theme-c, var(--bfc-base-c)); background: var(--bfc-theme-fade); }
  .filter-arrow[aria-expanded="true"] i { transform: rotate(180deg); }
  /* Rullgardinen er position: fixed og legges rett under filterfeltet med
     nøyaktig kolonnens bredde (satt i skriptet). Samme bakgrunn, ramme,
     avrunding og skygge som tabellkortet rundt. */
  .combo-panel { position: fixed; z-index: 60; display: flex; flex-direction: column; background: var(--bfc-base-3); color: var(--bfc-base-c); border: var(--bf-border); border-radius: var(--bf-radius-m); box-shadow: 0 4px 12px var(--bfc-shadow); overflow: hidden; }
  .combo-search { margin: var(--bfs8); width: calc(100% - 2 * var(--bfs8)); font-size: var(--bf-font-size-s); padding: var(--bfs4) var(--bfs8); }
  .combo-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; border-top: var(--bf-border); }
  .combo-option, .combo-empty { padding: var(--bfs8) var(--bfs12); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .combo-option { cursor: pointer; }
  .combo-option:hover, .combo-option.combo-active { background: var(--bfc-theme-fade); }
  .combo-option.combo-selected { font-weight: 700; }
  .combo-empty { color: var(--bfc-base-c-dimmed); font-style: italic; }
  /* Row itself navigates to the avvik's detail page (see the .avvik-row
     handler in SHARED_SCRIPT) - hover/focus-visible make that obvious
     without relying on cursor alone. outline-offset is negative since a
     <tr> has no padding of its own to draw the outline into. */
  .avvik-row { cursor: pointer; }
  .avvik-row:hover { background: var(--bfc-theme-fade); }
  .avvik-row:focus-visible { outline: 2px solid var(--bfc-theme); outline-offset: -2px; }

  .back-link { display: inline-flex; align-items: center; gap: var(--bfs8); min-height: 44px; color: var(--bfc-base-c); text-decoration: none; margin-bottom: var(--bfs16); }
  .back-link:hover { text-decoration: underline; }
  /* Each box grows to help its row fill the full page width, starting from a
     content-sized basis (no forced equal columns) - only the border carries
     the avvik's status color (see the shared tone-border-<tone> classes
     below, reused by both renderInfoCard and the procedure-card); the
     background stays the page's own neutral card background so it reads
     correctly in both themes. */
  .info-cards { display: flex; flex-wrap: wrap; gap: var(--bfs16); margin-bottom: var(--bfs32); }
  .info-card { border-radius: var(--bf-radius-m); border-width: 2px; border-style: solid; flex: 1 1 auto; }
  .info-card .bf-card-content { padding: var(--bfs24); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; height: 100%; }
  .info-card .stat-label { font-size: var(--bf-font-size-m); }
  .info-card .stat-value { font-size: var(--bf-font-size-h3); font-weight: 700; margin-top: var(--bfs4); }
  /* Shared avvik status-color border, reused by the info cards above and the
     procedure-card below - keeps the color mapping in one place (see
     typeBadges.js's getTypeBadgeClass, the single source for this mapping). */
  .tone-border-theme { border-color: var(--bfc-theme); }
  .tone-border-success { border-color: var(--bfc-success); }
  .tone-border-warning { border-color: var(--bfc-warning); }
  .tone-border-attn { border-color: var(--bfc-attn); }
  .tone-border-alert { border-color: var(--bfc-alert); }
  .tone-border-chill { border-color: var(--bfc-chill); }
  .tone-border-brand { border-color: var(--bfc-brand); }
  .tone-border-neutral { border-color: var(--bfc-neutral); }
  @media (max-width: 480px) {
    .info-card { flex: 1 1 100%; }
  }
  .detail-page-section { margin-top: var(--bfs32); }
  .detail-page-section h2 { font-size: var(--bf-font-size-l); margin: 0 0 var(--bfs12); }
  .detail-page-section .bf-card-content { font-size: var(--bf-font-size-m); line-height: 1.6; }
  .external-logo-links { display: flex; gap: var(--bfs16); flex-wrap: wrap; }
  .external-logo-link { display: inline-flex; align-items: center; justify-content: center; width: 3rem; height: 3rem; border-radius: var(--bf-radius-m); border: var(--bf-border); background: var(--bfc-base-2); }
  .external-logo-link.has-caption { width: auto; gap: var(--bfs8); padding: 0 var(--bfs12) 0 var(--bfs8); }
  .external-logo-caption { font-size: var(--bf-font-size-s); font-weight: 600; color: var(--bfc-base-c); white-space: nowrap; }
  .invoice-numbers > div + div { margin-top: var(--bfs4); }
  .external-logo-link:hover { background: var(--bfc-theme-fade); }
  .external-logo-link:focus-visible { outline: 2px solid var(--bfc-theme); outline-offset: 2px; }
  .external-logo-link img { width: 2rem; height: 2rem; object-fit: contain; }
  /* A fixed, always-true fact for this avvik's type (see avvikDetailContent.js's
     DETAIL_NOTES) - a plain neutral card, distinct from the status-colored
     info cards/procedure-card since it isn't itself a key figure or the
     recommended action, just supporting context for it. */
  .detail-note { margin-bottom: var(--bfs32); }
  .detail-note .bf-card-content { display: flex; align-items: center; gap: var(--bfs12); font-size: var(--bf-font-size-m); }
  .detail-note i { color: var(--bfc-base-c-dimmed); font-size: var(--bf-font-size-l); }
  /* The clearest primary message on the page: a larger heading, generous
     padding and a status-colored border (tone-border-<tone>, same avvik
     status color as the info cards) set it apart from the supporting
     nøkkeltall content around it (see renderAvvikDetailPage). The
     background stays neutral, matching the active theme. */
  .procedure-section { margin-top: var(--bfs48); }
  .procedure-section h2 { font-size: var(--bf-font-size-h2); margin: 0 0 var(--bfs16); }
  .procedure-card { border-width: 2px; border-style: solid; }
  .procedure-card .bf-card-content { padding: var(--bfs32); }
  .procedure-steps { margin: 0; padding-left: var(--bfs24); display: flex; flex-direction: column; gap: var(--bfs12); font-size: var(--bf-font-size-l); line-height: 1.7; }
  .procedure-card .bf-button { margin-top: var(--bfs16); }
  @media (max-width: 480px) {
    .procedure-section h2 { font-size: var(--bf-font-size-h3); }
    .procedure-card .bf-card-content { padding: var(--bfs16); }
    .procedure-steps { font-size: var(--bf-font-size-m); }
  }
`;

// Trend chart for "Avvik totalt", shown beside the key figures. The server only
// embeds one item per avvik (when it started counting, when it was resolved,
// and the values the filter boxes match against); the browser builds both
// series with history.js's buildDailySeries, whose source is shipped below so
// the total and the filtered line can never disagree. Filtering the table adds
// a second line to this same chart rather than a second chart. A closed avvik
// has no purchaser or avvikstype in dwh (see avvikSync.js's
// syncResolvedHistory), so those two filters only see open ones - the note
// under the chart says so.
function renderTrendSection(avvikList) {
  const today = new Date().toISOString().slice(0, 10);
  const items = buildChartItems(avvikList, today);
  // "<" inside the JSON would let a value close the script element early.
  const payload = JSON.stringify({ items, from: CHART_FROM, to: today }).replace(/</g, '\\u003c');
  const fromLabel = new Date(CHART_FROM).toLocaleDateString('no-NO', { day: 'numeric', month: 'long', year: 'numeric' });
  return `
    <section id="trend-section">
      <div class="bf-card trend-card"><div class="bf-card-content">
        <div class="trend-head">
          <span class="trend-title">Avvik over tid (fra ${fromLabel})</span>
          <span class="trend-legend">
            <span><span class="legend-line legend-total"></span>Totalt</span>
            <span id="trend-filter-legend" hidden><span class="legend-line legend-filter"></span><span id="trend-filter-label"></span></span>
          </span>
        </div>
        <div id="trend-chart" class="trend-chart" aria-label="Antall avvik over tid"></div>
        <div class="trend-note" id="trend-note" hidden>Løste saker har ikke avvikstype i historikken, og noen mangler innkjøper, så filterlinjen kan være for lav bakover i tid.</div>
      </div></div>
      <script type="application/json" id="trend-data">${payload}</script>
    </section>`;
}

// Plain string concatenation on purpose (no nested template literal): this is
// a JS-in-a-JS-string, and a stray backtick inside it ends the string early
// and crashes the app at startup (that already happened once in SHARED_STYLE).
const TREND_SCRIPT = [
  '(function () {',
  '  var buildDailySeries = ' + buildDailySeries.toString() + ';',
  "  var dataEl = document.getElementById('trend-data');",
  "  var chart = document.getElementById('trend-chart');",
  '  if (!dataEl || !chart) return;',
  '  var payload = JSON.parse(dataEl.textContent);',
  "  var NS = 'http://www.w3.org/2000/svg';",
  '  var totalSeries = buildDailySeries(payload.items, payload.from, payload.to);',
  '  var filteredSeries = null;',
  '  function el(name, attrs, text) {',
  '    var node = document.createElementNS(NS, name);',
  '    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });',
  '    if (text) node.textContent = text;',
  '    return node;',
  '  }',
  '  function draw() {',
  '    var W = chart.clientWidth, H = chart.clientHeight;',
  '    if (W < 60 || H < 60) return;',
  '    var L = 26, R = 8, T = 8, B = 18;',
  "    chart.textContent = '';",
  '    var all = filteredSeries ? totalSeries.concat(filteredSeries) : totalSeries;',
  '    var max = Math.max(1, Math.max.apply(null, all.map(function (p) { return p.count; })));',
  '    var step = max <= 5 ? 1 : Math.ceil(max / 4);',
  '    var top = Math.ceil(max / step) * step;',
  '    var n = totalSeries.length;',
  '    var x = function (i) { return L + (n <= 1 ? 0 : (i * (W - L - R)) / (n - 1)); };',
  '    var y = function (v) { return T + (H - T - B) * (1 - v / top); };',
  "    var svg = el('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'class': 'trend-svg' });",
  '    for (var g = 0; g <= top; g += step) {',
  "      svg.appendChild(el('line', { x1: L, x2: W - R, y1: y(g), y2: y(g), 'class': 'trend-grid' }));",
  "      svg.appendChild(el('text', { x: L - 5, y: y(g) + 3, 'text-anchor': 'end', 'class': 'trend-label' }, String(g)));",
  '    }',
  '    totalSeries.forEach(function (p, i) {',
  "      if (p.date.slice(8) === '01' || p.date.slice(8) === '15') {",
  "        svg.appendChild(el('text', { x: x(i), y: H - 4, 'text-anchor': 'middle', 'class': 'trend-label' }, p.date.slice(8) + '.' + p.date.slice(5, 7)));",
  '      }',
  '    });',
  '    function line(series, cls) {',
  "      var points = series.map(function (p, i) { return x(i).toFixed(1) + ',' + y(p.count).toFixed(1); }).join(' ');",
  "      svg.appendChild(el('polyline', { points: points, 'class': cls }));",
  '    }',
  "    line(totalSeries, 'trend-line');",
  "    if (filteredSeries) line(filteredSeries, 'trend-line-filter');",
  '    totalSeries.forEach(function (p, i) {',
  "      var hit = el('circle', { cx: x(i), cy: y(p.count), r: 4, 'class': 'trend-hit' });",
  "      var label = p.date + ': ' + p.count + ' avvik';",
  "      if (filteredSeries) label += ' (filter: ' + filteredSeries[i].count + ')';",
  "      hit.appendChild(el('title', {}, label));",
  '      svg.appendChild(hit);',
  '    });',
  '    chart.appendChild(svg);',
  '  }',
  "  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(draw).observe(chart);",
  "  window.addEventListener('resize', draw);",
  '  draw();',
  "  window.addEventListener('load', draw);",
  "  if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);",
  '',
  "  var section = document.getElementById('open-section');",
  '  if (!section) return;',
  "  var inputs = section.querySelectorAll('.filter-input');",
  "  var LABELS = { order: 'ordre', po: 'PO-nummer', purchaser: 'innkjøper', department: 'avdeling', type: 'avvikstype' };",
  '  function update() {',
  '    var filters = {};',
  '    inputs.forEach(function (input) {',
  '      var v = input.value.trim().toLowerCase();',
  '      if (v) filters[input.dataset.col] = v;',
  '    });',
  '    var cols = Object.keys(filters);',
  "    document.getElementById('trend-filter-legend').hidden = cols.length === 0;",
  "    document.getElementById('trend-note').hidden = !(filters.purchaser || filters.type);",
  '    if (!cols.length) {',
  '      filteredSeries = null;',
  '    } else {',
  '      var subset = payload.items.filter(function (item) {',
  "        return cols.every(function (c) { return (item[c] || '').indexOf(filters[c]) !== -1; });",
  '      });',
  "      document.getElementById('trend-filter-label').textContent =",
  "        cols.map(function (c) { return LABELS[c] + ' \\u00ab' + filters[c] + '\\u00bb'; }).join(', ');",
  '      filteredSeries = buildDailySeries(subset, payload.from, payload.to);',
  '    }',
  '    draw();',
  '  }',
  '  inputs.forEach(function (input) {',
  "    input.addEventListener('input', update);",
  "    input.addEventListener('change', update);",
  '  });',
  '  update();',
  '}());',
].join('\n');

// Runs before the stylesheet/body so a stored preference applies with no
// flash of the server-rendered default (dark) on load. 'system' stores/adds
// neither override class, leaving Bifrost's own prefers-color-scheme
// handling in charge.
const THEME_RESTORE_SCRIPT = `
  (function () {
    var stored = 'dark';
    try {
      var saved = localStorage.getItem('bfColorMode');
      if (saved === 'light' || saved === 'dark' || saved === 'system') stored = saved;
    } catch (e) {}
    if (stored === 'dark') document.documentElement.classList.add('bf-darkmode');
    else if (stored === 'light') document.documentElement.classList.add('bf-lightmode');
  })();`;

// Content-hashed so the URL itself changes whenever SHARED_STYLE/SHARED_SCRIPT
// do - browsers always fetch fresh content on the next deploy, with no need
// for anyone to hard-refresh (see the /assets routes in index.js).
const ASSET_CSS = SHARED_STYLE;
// Hover-forklaring for stolpene på Utvikling-siden: én tooltip som følger
// musepekeren (og vises ved tastaturfokus). Tekst settes med textContent.
const BAR_TOOLTIP_SCRIPT = `
(function () {
  var rows = document.querySelectorAll('.bar-chart .bar-row');
  if (!rows.length) return;
  var tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  tip.hidden = true;
  var strong = document.createElement('strong');
  var line = document.createElement('span');
  tip.append(strong, line);
  document.body.appendChild(tip);
  function show(row, x, y) {
    strong.textContent = row.dataset.label;
    line.textContent = row.dataset.value + ' åpne avvik (' + row.dataset.share + ' % av alle)';
    tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(x + 14, window.innerWidth - w - 8)) + 'px';
    tip.style.top = Math.max(8, Math.min(y + 14, window.innerHeight - h - 8)) + 'px';
  }
  rows.forEach(function (row) {
    row.addEventListener('pointermove', function (e) { show(row, e.clientX, e.clientY); });
    row.addEventListener('pointerleave', function () { tip.hidden = true; });
    row.addEventListener('focus', function () {
      var r = row.getBoundingClientRect();
      show(row, r.left + r.width / 2, r.top);
    });
    row.addEventListener('blur', function () { tip.hidden = true; });
  });
}());
`;

const ASSET_JS = SHARED_SCRIPT + '\n' + TREND_SCRIPT + '\n' + BAR_TOOLTIP_SCRIPT;
const ASSET_CSS_VERSION = crypto.createHash('sha256').update(ASSET_CSS).digest('hex').slice(0, 10);
const ASSET_JS_VERSION = crypto.createHash('sha256').update(ASSET_JS).digest('hex').slice(0, 10);

function renderShell(activeKey, title, contentHtml, { showToolbar, headerActions } = {}) {
  return `<!DOCTYPE html>
<html lang="no" class="bf-theme-purple">
<head>
<meta charset="utf-8">
<script>${THEME_RESTORE_SCRIPT}</script>
<title>${escapeHtml(title)} — Lageravvik</title>
<link rel="stylesheet" href="https://unpkg.com/@intility/bifrost-css@6.11.2/dist/bifrost-all.css">
<link rel="stylesheet" href="/assets/app.css?v=${ASSET_CSS_VERSION}">
<script src="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/7.0.0/js/solid.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/7.0.0/js/fontawesome.min.js"></script>
</head>
<body>
  ${renderSkipLink()}
  ${renderTopBar()}
  <div class="body-row">
    ${renderSideNav(activeKey)}
    <main id="main-content" class="main">
      <div class="page">
        <header class="page-header">
          <span class="bf-badge bfc-attn-bg">Under arbeid</span>
          <div class="page-header-heading">
            <h1>${escapeHtml(title)}</h1>
            ${headerActions || ''}
          </div>
          ${showToolbar ? renderToolbar() : ''}
        </header>
        ${contentHtml}
      </div>
    </main>
  </div>
  ${renderSettingsPanel()}
  <script src="/assets/app.js?v=${ASSET_JS_VERSION}"></script>
</body>
</html>`;
}

function renderOpenAvvikPage(avvikList, notifications) {
  const { open, resolved } = splitAvvik(avvikList);
  const openRows = open
    .map((a) => renderAvvikRow(a, notifications, { showSku: true, showDateColumn: false, showNotifiedColumn: false, openList: true }))
    .join('');

  const content = `
    ${renderStats(open, resolved.length)}

    <section id="open-section">
      <div class="section-header">
        <h2>Åpne avvik</h2>
        <span class="bf-badge bfc-attn-bg">${open.length}</span>
      </div>
      <div id="supplier-chip" class="filter-chip" hidden>
        <span>Leverandør: <strong id="supplier-chip-name"></strong></span>
        <button type="button" id="supplier-chip-clear" class="icon-button chip-clear" aria-label="Fjern leverandørfilter"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
      <input type="hidden" class="filter-input" data-col="supplier">
      <div class="section-card">
        <table class="bf-table">
          <thead>
            <tr><th>Ordre</th><th>PO-nummer</th><th>Status</th><th>SKU</th><th>Innkjøper</th><th>Avdeling</th><th>Avvikstype</th><th>Dager siden mottak</th><th>Kommentarer</th></tr>
            <tr class="filter-row">
              <th><input type="text" class="bf-input filter-input" data-col="order" placeholder="Filtrer ordre..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="po" placeholder="Filtrer PO-nummer..."></th>
              <th></th>
              <th></th>
              <th><input type="text" class="bf-input filter-input" data-col="purchaser" placeholder="Filtrer innkjøper..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="department" placeholder="Filtrer avdeling..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="type" placeholder="Filtrer avvikstype..."></th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>${openRows}</tbody>
        </table>
      </div>
    </section>`;

  return renderShell('open', 'Åpne avvik', content, { showToolbar: true });
}

function renderFinanceStats(financeCount, vismaStatusChangeCount, noOwnerCount) {
  return `
  <div class="stats">
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-number">${financeCount + noOwnerCount}</div>
      <div class="stat-label">Totalt (begge tabeller)</div>
    </div></div>
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-number">${financeCount}</div>
      <div class="stat-label">Spesielle caser - Finance</div>
    </div></div>
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-number">${vismaStatusChangeCount}</div>
      <div class="stat-label">Løses av Finance – Endre status i Visma</div>
    </div></div>
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-number">${noOwnerCount}</div>
      <div class="stat-label">Sakseier ikke funnet</div>
    </div></div>
  </div>`;
}

function renderFinancePage(avvikList, notifications) {
  const { financeCases, vismaStatusChangeCases, noOwnerCases } = splitAvvik(avvikList);
  const noOwnerRows = noOwnerCases.map((a) => renderAvvikRow(a, notifications, { actionButton: 'resolve', dateField: 'lastNotifiedAt', showPurchaserForm: true })).join('');
  const financeRows = financeCases.map((a) => renderFinanceRow(a)).join('');
  const vismaStatusChangeRows = vismaStatusChangeCases.map((a) => renderFinanceRow(a)).join('');

  const content = `
    ${renderFinanceStats(financeCases.length, vismaStatusChangeCases.length, noOwnerCases.length)}

    <section id="finance-section">
      <div class="section-header">
        <h2>Spesielle caser - Finance</h2>
        <span class="bf-badge bfc-theme-bg">${financeCases.length}</span>
      </div>
      <p class="section-note">En varefaktura (ikke kostnadsfaktura) matchet på PO-nummer + artikkel som er arkivert i Medius, men linjen står likevel som et åpent avvik (&gt;21 dager). Altså: fakturaen er ferdigbehandlet/arkivert, men noe stemmer ikke siden ordren fortsatt vises som avvik — Finance må se nærmere på det.</p>
      <div class="section-card">
        <table class="bf-table">
          <thead>
            <tr><th>Ordre</th><th>Innkjøper</th><th>Avdeling</th><th>Avvikstype</th><th>Dager siden mottak</th><th>Kommentarer</th><th></th></tr>
            <tr class="filter-row">
              <th><input type="text" class="bf-input filter-input" data-col="order" placeholder="Filtrer ordre..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="purchaser" placeholder="Filtrer innkjøper..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="department" placeholder="Filtrer avdeling..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="type" placeholder="Filtrer avvikstype..."></th>
              <th></th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>${financeRows}</tbody>
        </table>
      </div>
    </section>

    <section id="visma-status-change-section">
      <div class="section-header">
        <h2>Løses av Finance – Endre status i Visma</h2>
        <span class="bf-badge bfc-theme-bg">${vismaStatusChangeCases.length}</span>
      </div>
      <p class="section-note">Enten er hele SKU-antallet skrevet ut av lager, eller avviket er «Kredittkort lisenskjøp, feilaktig mottatt» og hele antallet er videresolgt — i begge tilfeller løser Finance saken ved å endre status direkte i Visma.</p>
      <div class="section-card">
        <table class="bf-table">
          <thead>
            <tr><th>Ordre</th><th>Innkjøper</th><th>Avdeling</th><th>Avvikstype</th><th>Dager siden mottak</th><th>Kommentarer</th><th></th></tr>
            <tr class="filter-row">
              <th><input type="text" class="bf-input filter-input" data-col="order" placeholder="Filtrer ordre..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="purchaser" placeholder="Filtrer innkjøper..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="department" placeholder="Filtrer avdeling..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="type" placeholder="Filtrer avvikstype..."></th>
              <th></th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>${vismaStatusChangeRows}</tbody>
        </table>
      </div>
    </section>

    <section id="no-owner-section">
      <div class="section-header">
        <h2>Sakseier ikke funnet</h2>
        <span class="bf-badge bfc-attn-bg">${noOwnerCases.length}</span>
      </div>
      <p class="section-note">Ingen sakseier kunne identifiseres for disse - Finance må fylle inn riktig innkjøper her før saken flyttes til «Åpne avvik».</p>
      <div class="section-card">
        <table class="bf-table">
          <thead>
            <tr><th>Ordre</th><th>Innkjøper</th><th>Avdeling</th><th>Avvikstype</th><th>Dager siden mottak</th><th>Sist varslet</th><th></th><th>Kommentarer</th><th>Varsling på e-post</th></tr>
            <tr class="filter-row">
              <th><input type="text" class="bf-input filter-input" data-col="order" placeholder="Filtrer ordre..."></th>
              <th></th>
              <th></th>
              <th><input type="text" class="bf-input filter-input" data-col="type" placeholder="Filtrer avvikstype..."></th>
              <th></th>
              <th></th>
              <th></th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>${noOwnerRows}</tbody>
        </table>
      </div>
    </section>`;

  return renderShell('finance', 'Saker som løses av Finance', content);
}

// value === 0 is a real value (e.g. "0 dager ventende"), so this checks for
// null/undefined/empty-string specifically rather than falsiness in general
// - see renderInfoCard below.
function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

// tone picks one of Bifrost's category colors (--bfc-<tone>, via the shared
// tone-border-<tone> class also used by the procedure-card) for the border
// only - the card's own neutral background comes from the plain bf-card
// class, so each key figure reads as its own clearly bordered box without
// tinting the page background.
// subValue reuses the same .stat-sublabel small-text-under-the-number
// pattern already used for the "Viser X av Y" line in renderStats, e.g. for
// Videresolgt/Skrevet ut av lager's "{quantity} av {totalQuantity}".
function renderInfoCard(label, value, tone = 'neutral', subValue) {
  if (!hasValue(value)) return '';
  return `
    <div class="bf-card info-card tone-border-${tone}"><div class="bf-card-content">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(String(value))}</div>
      ${hasValue(subValue) ? `<div class="stat-sublabel">${escapeHtml(String(subValue))}</div>` : ''}
    </div></div>`;
}

// Fakturaene (og kreditnotaene) som hører til avviket. Eldre lagret tilstand
// har bare invoiceNumber/mediusLink; da brukes de som én faktura til neste
// dwh-synk fyller inn hele listen.
function getAvvikInvoices(avvik) {
  if (Array.isArray(avvik.invoices) && avvik.invoices.length) return avvik.invoices;
  return hasValue(avvik.invoiceNumber)
    ? [{ invoiceNumber: avvik.invoiceNumber, mediusLink: avvik.mediusLink || null, isCreditNote: false }]
    : [];
}

// "Fakturanummer"-kortet: ett nummer per linje, lenket til Medius når det
// finnes en lenke, og kreditnotaer merket som det.
function renderInvoiceCard(invoices, tone = 'neutral') {
  if (!invoices.length) return '';
  const items = invoices
    .map((inv) => {
      const text = `${escapeHtml(String(inv.invoiceNumber))}${inv.isCreditNote ? ' (kreditnota)' : ''}`;
      const label = inv.isCreditNote ? 'kreditnota' : 'faktura';
      return inv.mediusLink
        ? `<div><a class="bf-link" href="${escapeHtml(inv.mediusLink)}" target="_blank" rel="noopener noreferrer" title="Vis ${label} ${escapeHtml(String(inv.invoiceNumber))} i Medius">${text}</a></div>`
        : `<div>${text}</div>`;
    })
    .join('');
  return `
    <div class="bf-card info-card tone-border-${tone}"><div class="bf-card-content">
      <div class="stat-label">Fakturanummer</div>
      <div class="stat-value invoice-numbers">${items}</div>
    </div></div>`;
}

// Defensive display-only clamp: avvikSync.js's resolveStockBreakdown logs a
// warning if resoldQuantity + writtenOffQuantity ever exceeds totalQuantity
// (duplicate stock_history rows or a bad lot join) without altering the
// underlying computed values - this only keeps the shown "x av y" from
// reading a nonsensical count above the total, per the user's explicit call.
function formatQuantityOfTotal(quantity, totalQuantity) {
  return `${Math.min(quantity, totalQuantity)} av ${totalQuantity}`;
}

// One <li> per sentence/step - presentation only, the underlying text and
// order still come straight from getAvvikDetailContent/instructions.js
// unchanged. Splits after a ./!/? that's followed by whitespace, which every
// procedure string in avvikDetailContent.js/instructions.js satisfies.
function renderProcedureSteps(procedure) {
  const steps = procedure
    .split(/(?<=[.!?])\s+/)
    .map((step) => step.trim())
    .filter(Boolean);
  return `<ul class="procedure-steps">${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ul>`;
}

// Detail page for a single avvik/ordrelinje, reached by clicking its row (or
// its old "Dette må gjøres"/"Mer informasjon" action) anywhere it appears -
// open avvik, Finance, or Arkiv. Info cards, the header icon links, and
// links all hide themselves rather than rendering an empty card/field/
// placeholder when a value is missing.
function renderAvvikDetailPage(avvik) {
  const { procedure, links, note } = getAvvikDetailContent(avvik);
  const invoices = getAvvikInvoices(avvik);

  // Every key figure shares the same discrepancyType status color (see
  // typeBadges.js - the same mapping already used for the type badge on the
  // open-avvik row and the type donut), rather than each card picking its
  // own tone, so the boxes read as "this avvik's color" at a glance.
  const avvikTone = getTypeBadgeClass(avvik.discrepancyType);
  const infoCards = [
    renderInfoCard('PO-nummer', avvik.poNumber, avvikTone),
    renderInfoCard('Innkjøpsordrenummer', avvik.orderId, avvikTone),
    renderInfoCard('SKU', avvik.articleNumber, avvikTone),
    renderInfoCard('Leverandør', avvik.supplierName, avvikTone),
    renderInfoCard('Prosjekt', avvik.projectNumber, avvikTone),
    renderInfoCard('Bestillingsdato', avvik.createdAt ? new Date(avvik.createdAt).toLocaleDateString('no-NO') : null, avvikTone),
    renderInfoCard('Type avvik', avvik.discrepancyType, avvikTone),
    renderInfoCard('Dager ventende', typeof avvik.daysWaiting === 'number' ? avvik.daysWaiting : null, avvikTone),
    renderInfoCard('Partinummer', avvik.lotNumber, avvikTone),
    renderInfoCard(
      'Videresolgt',
      avvik.resoldStatus,
      avvikTone,
      // 'Nei' means "nothing resold yet" - no "0 av totalQuantity" text.
      avvik.resoldQuantity > 0 ? formatQuantityOfTotal(avvik.resoldQuantity, avvik.totalQuantity) : null
    ),
    renderInfoCard(
      'Skrevet ut av lager',
      avvik.writtenOffStatus,
      avvikTone,
      avvik.writtenOffStatus ? formatQuantityOfTotal(avvik.writtenOffQuantity, avvik.totalQuantity) : null
    ),
    renderInvoiceCard(invoices, avvikTone),
  ]
    .filter(Boolean)
    .join('');

  // Ett Medius-ikon per faktura/kreditnota med lenke. Når det er flere, står
  // fakturanummeret ved siden av ikonet så de kan skilles fra hverandre.
  const linkedInvoices = invoices.filter((inv) => inv.mediusLink);
  const mediusLinkHtml = linkedInvoices
    .map((inv) => {
      const what = inv.isCreditNote ? 'kreditnota' : 'faktura';
      const title = linkedInvoices.length > 1 ? `Vis ${what} ${inv.invoiceNumber} i Medius` : `Vis ${what} i Medius`;
      const caption =
        linkedInvoices.length > 1
          ? `<span class="external-logo-caption">${escapeHtml(String(inv.invoiceNumber))}${inv.isCreditNote ? ' (kreditnota)' : ''}</span>`
          : '';
      return `<a class="external-logo-link${caption ? ' has-caption' : ''}" href="${escapeHtml(inv.mediusLink)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
        <img src="/assets/medius-logo.png" alt="" width="32" height="32">${caption}
      </a>`;
    })
    .join('');
  const ticketUrlHtml = avvik.ticketUrl
    ? `<a class="external-logo-link" href="${escapeHtml(avvik.ticketUrl)}" target="_blank" rel="noopener noreferrer" title="Vis saken i Ticket Manager" aria-label="Vis saken i Ticket Manager">
        <img src="/assets/ticket-manager-logo.png" alt="" width="32" height="32">
      </a>`
    : '';
  const headerActions =
    mediusLinkHtml || ticketUrlHtml ? `<div class="external-logo-links">${mediusLinkHtml}${ticketUrlHtml}</div>` : '';

  const linksHtml = links
    .map(
      (link) =>
        `<a class="bf-button" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`
    )
    .join('');

  // Kostnadsfaktura — reverser has nothing actionable to recommend (the note
  // box above already says why it's resolved) - drop the section entirely.
  // Spesielle caser - Finance gets the same box treatment but under
  // "Informasjon" instead of "Anbefalt fremgangsmåte", since Finance handles
  // it internally rather than following a suggested procedure - its box is
  // intentionally left empty for now (content still being decided).
  const isSpesielleCaserFinance = isFinanceCase(avvik.discrepancyType);
  const procedureHeading =
    avvik.discrepancyType === KOSTNADSFAKTURA_REVERSER ? null : isSpesielleCaserFinance ? 'Informasjon' : 'Anbefalt fremgangsmåte';
  const procedureBodyHtml = isSpesielleCaserFinance ? '' : `${renderProcedureSteps(procedure)}${linksHtml}`;

  const content = `
    <a id="back-link" class="back-link" href="/"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Åpne avvik</a>

    <div class="info-cards">${infoCards}</div>

    ${note ? `<section class="detail-page-section">
      <div class="bf-card detail-note"><div class="bf-card-content">
        <i class="fa-solid fa-circle-info" aria-hidden="true"></i> ${escapeHtml(note)}
      </div></div>
    </section>` : ''}

    ${procedureHeading ? `<section class="detail-page-section procedure-section">
      <h2>${procedureHeading}</h2>
      <div class="bf-card procedure-card tone-border-${avvikTone}"><div class="bf-card-content">
        ${procedureBodyHtml}
      </div></div>
    </section>` : ''}

    <section class="detail-page-section comments-section">
      <h2>Kommentarer og vedlegg</h2>
      <div class="bf-card"><div class="bf-card-content">
        <ul class="comments">${renderComments(avvik.comments || [], avvik.id)}</ul>
      </div></div>
    </section>`;

  const pageTitle = `${avvik.purchaserName || 'Ukjent sakseier'} – Avvik – ${avvik.orderId}`;
  // "Mer informasjon" (Finance-section cases) should light up "Saker som
  // løses av Finance" in the side nav, not "Åpne avvik" - see
  // isFinanceSectionCase/splitAvvik above.
  const activeKey = isFinanceSectionCase(avvik) ? 'finance' : 'open';
  return renderShell(activeKey, pageTitle, content, { headerActions });
}

function renderArchivePage(avvikList, notifications) {
  const { resolved } = splitAvvik(avvikList);
  // showNotifiedColumn: false drops "Varsling på e-post" - resolved avvik
  // are no longer notified, and the column isn't relevant in the archive.
  const resolvedRows = resolved
    .map((a) => renderAvvikRow(a, notifications, { actionButton: 'reopen', dateField: 'resolvedAt', showNotifiedColumn: false, editableType: true, commentButton: true }))
    .join('');

  const content = `
    <div class="stats">
      <div class="bf-card"><div class="bf-card-content">
        <div class="stat-number">${resolved.length}</div>
        <div class="stat-label">Antall løst</div>
      </div></div>
    </div>

    <section id="archive-section">
      <div class="section-header">
        <h2>Arkiv — løste avvik</h2>
        <span class="bf-badge bfc-theme-bg">${resolved.length}</span>
      </div>
      <p class="section-note">DWH kan ikke gjenskape avvikstypen for saker som er lukket (prosjektnummer kan være endret, ordrehodet er borte). Bruk «Endre» ved avvikstypen for å sette den selv. Den står til DWH selv klarer å finne typen, og blir da byttet ut automatisk.</p>
      <div class="section-card">
        <table class="bf-table">
          <thead>
            <tr><th>Ordre</th><th>Innkjøper</th><th>Avdeling</th><th>Avvikstype</th><th>Dager siden mottak til løst</th><th>Løst</th><th></th><th>Kommentarer</th></tr>
            <tr class="filter-row">
              <th><input type="text" class="bf-input filter-input" data-col="order" placeholder="Filtrer ordre..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="purchaser" placeholder="Filtrer innkjøper..."></th>
              <th></th>
              <th><input type="text" class="bf-input filter-input" data-col="type" placeholder="Filtrer avvikstype..."></th>
              <th></th>
              <th></th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>${resolvedRows}</tbody>
        </table>
      </div>
    </section>`;

  return renderShell('archive', 'Arkiv', content);
}

const SUPPLIER_BARS = 15;

// Åpne avvik fordelt på leverandør, størst først. De SUPPLIER_BARS største
// får hver sin stolpe, resten slås sammen til "Andre"; tabellvisningen under
// har alle leverandørene. Én serie, så ingen legende - tittelen sier hva
// stolpene viser, og verdien står ved stolpespissen.
function renderSupplierChart(openList) {
  const counts = new Map();
  for (const a of openList) {
    const name = supplierLabel(a);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], 'no'));
  const bars = sorted.slice(0, SUPPLIER_BARS);
  const rest = sorted.slice(SUPPLIER_BARS);
  // "Andre" er flere leverandører og kan ikke filtreres som én, så den stolpen
  // er ikke en lenke.
  if (rest.length) bars.push([`Andre (${rest.length} leverandører)`, rest.reduce((sum, [, c]) => sum + c, 0), false]);
  const total = openList.length;
  const max = Math.max(1, ...bars.map(([, c]) => c));

  const rows = bars
    .map(([name, count, linkable = true]) => {
      const pct = (count / max) * 100;
      const share = total ? Math.round((count / total) * 100) : 0;
      const attrs = `class="bar-row${linkable ? ' bar-row-link' : ''}" data-label="${escapeHtml(name)}" data-value="${count}" data-share="${share}"`;
      const inner = `
        <span class="bar-label" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(2)}%"></span><span class="bar-value" style="left:${pct.toFixed(2)}%">${count}</span></span>`;
      // Stolpen er en lenke til Åpne avvik filtrert på leverandøren.
      return linkable
        ? `<li><a ${attrs} href="/?leverandor=${encodeURIComponent(name)}" aria-label="${escapeHtml(name)}: ${count} åpne avvik, vis dem">${inner}</a></li>`
        : `<li><div ${attrs} tabindex="0">${inner}</div></li>`;
    })
    .join('');
  const tableRows = sorted
    .map(([name, count]) => `<tr><td>${escapeHtml(name)}</td><td>${count}</td></tr>`)
    .join('');

  return `
    <section id="supplier-section">
      <div class="bf-card supplier-card"><div class="bf-card-content">
        <span class="trend-title">Åpne avvik per leverandør</span>
        <p class="chart-sub">${total} åpne avvik fordelt på ${sorted.length} leverandører${rest.length ? ` (de ${SUPPLIER_BARS} største vises, resten samlet under «Andre»)` : ''}.</p>
        ${total ? `<ul class="bar-list bar-chart" aria-label="Antall åpne avvik per leverandør">${rows}</ul>` : '<p class="chart-sub">Ingen åpne avvik.</p>'}
        <details class="chart-table">
          <summary class="bf-link">Vis som tabell</summary>
          <table class="bf-table">
            <thead><tr><th>Leverandør</th><th>Antall avvik</th></tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </details>
      </div></div>
    </section>`;
}

function renderUtviklingPage(avvikList) {
  const { open, resolved } = splitAvvik(avvikList);
  const content = `
    <div class="utvikling-page">
      <div class="utvikling-trend">${renderTrendSection([...open, ...resolved])}</div>
      ${renderSupplierChart(open)}
    </div>`;
  return renderShell('utvikling', 'Utvikling', content);
}

module.exports = {
  renderUtviklingPage,
  renderOpenAvvikPage,
  renderFinancePage,
  renderArchivePage,
  renderAvvikDetailPage,
  escapeHtml,
  ASSET_CSS,
  ASSET_JS,
  ASSET_CSS_VERSION,
  ASSET_JS_VERSION,
};
