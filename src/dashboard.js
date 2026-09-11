'use strict';

const crypto = require('node:crypto');
const { getTypeBadgeClass } = require('./typeBadges');
const { isFinanceCase } = require('./financeTypes');
const { KOSTNADSFAKTURA_REVERSER, MANUELL_ORDRE } = require('./discrepancyTypes');
const { getAvvikDetailContent } = require('./avvikDetailContent');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderComments(comments) {
  if (!comments.length) return '<li class="empty">Ingen kommentarer enna.</li>';
  return comments
    .map(
      (c) => `<li><strong>${escapeHtml(c.author)}:</strong> ${escapeHtml(c.text)}
        <span class="ts">(${new Date(c.createdAt).toLocaleString('no-NO')})</span></li>`
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

// A hidden row directly under a data row, toggled by clicking anywhere on
// that row that isn't itself interactive (see the .avvik-row click handler
// in SHARED_SCRIPT). colSpan must match the number of <td>s the calling
// row-renderer produces, or the table columns misalign.
function renderDetailRow(a, colSpan, { actionLabel } = {}) {
  const mediusLinkHtml = a.mediusLink
    ? `<a class="bf-link" href="${escapeHtml(a.mediusLink)}" target="_blank" rel="noopener noreferrer">Vis faktura i Medius</a>`
    : '<span class="section-note">Ingen Medius-lenke funnet for denne linjen.</span>';
  const ticketUrlHtml = a.ticketUrl
    ? `<a class="bf-link" href="${escapeHtml(a.ticketUrl)}" target="_blank" rel="noopener noreferrer">Vis saken</a>`
    : '<span class="section-note">Ingen sak funnet for denne linjen.</span>';
  // Manuelle ordre har ingen PO-nummer i det hele tatt - vis ikke feltet for
  // denne typen i stedet for en tom "—".
  const poNumberHtml =
    a.discrepancyType === MANUELL_ORDRE
      ? ''
      : `<div><strong>PO-nummer:</strong> ${a.poNumber ? escapeHtml(a.poNumber) : '—'}</div>`;
  // The primary action - placed before PO-nummer and styled distinctly
  // (border + theme color, not the bf-button-filled variant, since a page
  // can have several rows expanded and Bifrost only allows one filled
  // button per page) so it reads as the main thing to do with this row.
  // actionLabel differs by row type: "Dette må gjøres" for actionable
  // open-avvik/no-owner rows, "Mer informasjon" for Finance-only rows (see
  // renderAvvikRow/renderFinanceRow) - both link to the same detail page.
  const actionHtml = actionLabel
    ? `<div class="detail-action"><a class="bf-button action-primary" href="/avvik/${encodeURIComponent(a.id)}">
        <i class="fa-solid fa-arrow-right" aria-hidden="true"></i> ${escapeHtml(actionLabel)}
      </a></div>`
    : '';
  return `<tr class="detail-row" hidden><td colspan="${colSpan}">
      <div class="detail-grid">
        ${actionHtml}
        ${poNumberHtml}
        <div><strong>SKU (artikkelnummer):</strong> ${a.articleNumber ? escapeHtml(a.articleNumber) : '—'}</div>
        <div><strong>Partinummer:</strong> ${a.lotNumber ? escapeHtml(a.lotNumber) : '—'}</div>
        <div><strong>Fakturanummer:</strong> ${a.invoiceNumber ? escapeHtml(a.invoiceNumber) : '—'}</div>
        <div><strong>Videresolgt:</strong> ${a.resoldStatus ? escapeHtml(a.resoldStatus) : '—'}</div>
        <div>${mediusLinkHtml}</div>
        <div>${ticketUrlHtml}</div>
      </div>
    </td></tr>`;
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

function renderAvvikRow(
  a,
  notifications,
  { actionButton, dateField, showPurchaserForm, showSku, showDateColumn = true, showNotifiedColumn = true }
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
  // Base cells always present: order, purchaser, department, type badge,
  // days waiting, comments - plus whichever optional cells are switched on
  // above (sku/date/action/notified), so colSpan below always matches the
  // actual number of <td>s regardless of which options this call passed.
  const colSpan = 6 + (showSku ? 1 : 0) + (showDateColumn ? 1 : 0) + (actionCell ? 1 : 0) + (notifiedCell ? 1 : 0);
  return `
    <tr class="avvik-row" data-order="${escapeHtml(a.orderId.toLowerCase())}" data-purchaser="${escapeHtml((a.purchaserName || '').toLowerCase())}" data-department="${escapeHtml((a.department || '').toLowerCase())}" data-type="${escapeHtml(a.discrepancyType.toLowerCase())}">
      <td>${escapeHtml(a.orderId)}</td>
      ${skuCell}
      <td>${purchaserCell}</td>
      <td>${a.department ? escapeHtml(a.department) : '—'}</td>
      <td><span class="bf-badge bfc-${getTypeBadgeClass(a.discrepancyType)}-bg">${escapeHtml(a.discrepancyType)}</span></td>
      <td>${typeof a.daysWaiting === 'number' ? a.daysWaiting : '—'}</td>
      ${dateCell}
      ${actionCell}
      <td>
        <details>
          <summary class="bf-link">${a.comments.length} kommentar${a.comments.length === 1 ? '' : 'er'}</summary>
          <ul class="comments">${renderComments(a.comments)}</ul>
          <form class="add-comment" data-id="${a.id}">
            <input type="text" class="bf-input" name="author" placeholder="Ditt navn" required maxlength="100">
            <input type="text" class="bf-input" name="text" placeholder="Skriv en kommentar" required maxlength="2000">
            <button type="submit" class="bf-button bf-button-small">Legg til</button>
          </form>
        </details>
      </td>
      ${notifiedCell}
    </tr>${renderDetailRow(a, colSpan, { actionLabel: 'Dette må gjøres' })}`;
}

// Finance-only cases never get an email, so there's no email-preview UI here.
// The status column shows the actual discrepancyType badge (not a generic
// Åpen/Løst) since this table now also holds Kostnadsfaktura — reverser
// cases alongside genuine Spesielle caser - Finance ones.
function renderFinanceRow(a) {
  return `
    <tr class="avvik-row" data-order="${escapeHtml(a.orderId.toLowerCase())}" data-purchaser="${escapeHtml((a.purchaserName || '').toLowerCase())}" data-department="${escapeHtml((a.department || '').toLowerCase())}" data-type="${escapeHtml(a.discrepancyType.toLowerCase())}">
      <td>${escapeHtml(a.orderId)}</td>
      <td>${a.purchaserName ? escapeHtml(a.purchaserName) : '—'}</td>
      <td>${a.department ? escapeHtml(a.department) : '—'}</td>
      <td><span class="bf-badge bfc-${getTypeBadgeClass(a.discrepancyType)}-bg">${escapeHtml(a.discrepancyType)}</span></td>
      <td>${typeof a.daysWaiting === 'number' ? a.daysWaiting : '—'}</td>
      <td>
        <details>
          <summary class="bf-link">${a.comments.length} kommentar${a.comments.length === 1 ? '' : 'er'}</summary>
          <ul class="comments">${renderComments(a.comments)}</ul>
          <form class="add-comment" data-id="${a.id}">
            <input type="text" class="bf-input" name="author" placeholder="Ditt navn" required maxlength="100">
            <input type="text" class="bf-input" name="text" placeholder="Skriv en kommentar" required maxlength="2000">
            <button type="submit" class="bf-button bf-button-small">Legg til</button>
          </form>
        </details>
      </td>
      <td>${a.resolved ? '' : `<button type="button" data-id="${a.id}" class="bf-button bf-button-small resolve">Marker løst</button>`}</td>
    </tr>${renderDetailRow(a, 7, { actionLabel: 'Mer informasjon' })}`;
}

// The two literal fallback names dwhQueries.js's ground-truth query produces
// as case_owner when no sakseier could be resolved (see the query's Combined
// CTE) - these get pulled into their own table instead of cluttering the
// normal open-avvik list, same idea as the Finance section.
const NO_OWNER_NAMES = new Set(['Sakseier ikke funnet', 'Manuell ordre – sakseier mangler']);
const byDaysWaitingDesc = (a, b) => (b.daysWaiting || 0) - (a.daysWaiting || 0);

function splitAvvik(avvikList) {
  // Kostnadsfaktura — reverser lives in the Finance section too (its own
  // resolve workflow is Finance-internal, same as the other cases here), but
  // keeps its own discrepancyType/badge rather than being relabeled.
  const isFinanceSectionCase = (a) => isFinanceCase(a.discrepancyType) || a.discrepancyType === KOSTNADSFAKTURA_REVERSER;
  const financeCases = avvikList.filter(isFinanceSectionCase);
  const withoutFinance = avvikList.filter((a) => !isFinanceSectionCase(a));
  const isOpenNoOwner = (a) => !a.resolved && NO_OWNER_NAMES.has(a.purchaserName);
  const noOwnerCases = withoutFinance.filter(isOpenNoOwner).sort(byDaysWaitingDesc);
  const rest = withoutFinance.filter((a) => !isOpenNoOwner(a));
  const open = rest.filter((a) => !a.resolved).sort(byDaysWaitingDesc);
  const resolved = rest.filter((a) => a.resolved);
  return { financeCases, noOwnerCases, open, resolved };
}

const NAV_ITEMS = [
  { key: 'open', href: '/', label: 'Åpne avvik', icon: 'fa-list-check' },
  { key: 'finance', href: '/finance', label: 'Saker som løses av Finance', icon: 'fa-coins' },
  { key: 'archive', href: '/arkiv', label: 'Arkiv', icon: 'fa-box-archive' },
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
      <span class="topbar-brand"><i class="fa-solid fa-warehouse" aria-hidden="true"></i>Lager-avvik</span>
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
        <button type="button" id="run-job" class="bf-button bf-button-filled">Kjør ukentlig jobb nå (demo)</button>
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

      // Desktop starts docked/visible, mobile starts off-canvas/collapsed -
      // correct the server-rendered aria-expanded="false" to match whichever
      // is actually true before any click happens.
      if (isOverlayMode()) {
        document.body.classList.add('nav-collapsed');
      } else {
        navToggle.setAttribute('aria-expanded', 'true');
        navToggle.setAttribute('aria-label', 'Lukk meny');
      }

      function showNav() {
        document.body.classList.remove('nav-collapsed');
        navToggle.setAttribute('aria-expanded', 'true');
        navToggle.setAttribute('aria-label', 'Lukk meny');
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

    // Clicking anywhere on an avvik row that isn't itself interactive
    // toggles a hidden detail row (PO-nummer, SKU, Medius-lenke) right below it.
    document.querySelectorAll('.avvik-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, textarea, form, details, summary')) return;
        const detail = row.nextElementSibling;
        if (detail && detail.classList.contains('detail-row')) {
          detail.hidden = !detail.hidden;
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
    const runJobBtn = document.getElementById('run-job');
    if (runJobBtn) runJobBtn.addEventListener('click', async () => {
      await fetch('/api/jobs/run-weekly', { method: 'POST' });
      location.reload();
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
        const res = await fetch('/api/avvik/' + id + '/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ author, text }),
        });
        if (res.ok) location.reload();
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
    document.querySelectorAll('#open-section, #finance-section, #no-owner-section, details.archive').forEach((section) => {
      const filterInputs = section.querySelectorAll('.filter-input');
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
          const match = Object.keys(filters).every((col) => row.dataset[col].includes(filters[col]));
          row.hidden = !match;
          if (match) {
            visibleCount++;
          } else {
            const detail = row.nextElementSibling;
            if (detail && detail.classList.contains('detail-row')) detail.hidden = true;
          }
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
  details.archive > summary { font-size: var(--bf-font-size-l); font-weight: 600; }
  details.archive .section-card { margin-top: var(--bfs16); }
  details summary { cursor: pointer; }
  ul.comments, ul.notif-history { list-style: none; padding: 0; margin: var(--bfs8) 0; }
  ul.comments li, ul.notif-history li { padding: var(--bfs4) 0; border-bottom: var(--bf-border); font-size: var(--bf-font-size-s); }
  ul.comments li.empty, ul.notif-history li.empty { color: var(--bfc-base-c-dimmed); font-style: italic; }
  ul.comments .ts { color: var(--bfc-base-c-dimmed); font-size: var(--bf-font-size-s); }
  form.add-comment { margin-top: var(--bfs8); display: flex; gap: var(--bfs8); flex-wrap: wrap; }
  form.add-comment .bf-input { width: auto; }
  form.set-purchaser { display: flex; gap: var(--bfs8); flex-wrap: wrap; }
  form.set-purchaser .bf-input { width: auto; min-width: 8rem; }
  .preview-email { margin-top: var(--bfs8); }
  .email-preview { white-space: pre-wrap; background: var(--bfc-base-2); border: var(--bf-border); border-radius: var(--bf-radius-s); padding: var(--bfs12); margin-top: var(--bfs8); font-size: var(--bf-font-size-s); max-width: 32rem; }
  .stats { display: flex; gap: var(--bfs16); flex-wrap: wrap; }
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
  .filter-row th { padding-top: var(--bfs8); padding-bottom: var(--bfs8); background: var(--bfc-base-2); }
  .filter-row .bf-input { font-size: var(--bf-font-size-s); padding: var(--bfs4) var(--bfs8); width: 100%; min-width: 9rem; }
  .avvik-row { cursor: pointer; }
  .detail-row td { background: var(--bfc-base-2); padding: var(--bfs16); }
  .detail-grid { display: flex; gap: var(--bfs32); flex-wrap: wrap; font-size: var(--bf-font-size-s); }
  /* Full-width so it reads as the primary action, not just another field in
     the flex row, and always the first thing (see renderDetailRow). */
  .detail-action { flex: 1 1 100%; order: -1; }
  .action-primary { border: 2px solid var(--bfc-theme); color: var(--bfc-theme); font-weight: 600; }
  .action-primary:hover { background: var(--bfc-theme-fade); }

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
  }`;

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
const ASSET_JS = SHARED_SCRIPT;
const ASSET_CSS_VERSION = crypto.createHash('sha256').update(ASSET_CSS).digest('hex').slice(0, 10);
const ASSET_JS_VERSION = crypto.createHash('sha256').update(ASSET_JS).digest('hex').slice(0, 10);

function renderShell(activeKey, title, contentHtml, { showToolbar, headerActions } = {}) {
  return `<!DOCTYPE html>
<html lang="no" class="bf-theme-purple">
<head>
<meta charset="utf-8">
<script>${THEME_RESTORE_SCRIPT}</script>
<title>${escapeHtml(title)} — Lager-avvik</title>
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
    .map((a) => renderAvvikRow(a, notifications, { actionButton: 'resolve', showSku: true, showDateColumn: false, showNotifiedColumn: false }))
    .join('');

  const content = `
    ${renderStats(open, resolved.length)}

    <section id="open-section">
      <div class="section-header">
        <h2>Åpne avvik</h2>
        <span class="bf-badge bfc-attn-bg">${open.length}</span>
      </div>
      <div class="section-card">
        <table class="bf-table">
          <thead>
            <tr><th>Ordre</th><th>SKU</th><th>Innkjøper</th><th>Avdeling</th><th>Avvikstype</th><th>Dager siden mottak</th><th></th><th>Kommentarer</th></tr>
            <tr class="filter-row">
              <th><input type="text" class="bf-input filter-input" data-col="order" placeholder="Filtrer ordre..."></th>
              <th></th>
              <th><input type="text" class="bf-input filter-input" data-col="purchaser" placeholder="Filtrer innkjøper..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="department" placeholder="Filtrer avdeling..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="type" placeholder="Filtrer avvikstype..."></th>
              <th></th>
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

function renderFinanceStats(financeCount, noOwnerCount) {
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
      <div class="stat-number">${noOwnerCount}</div>
      <div class="stat-label">Sakseier ikke funnet</div>
    </div></div>
  </div>`;
}

function renderFinancePage(avvikList, notifications) {
  const { financeCases, noOwnerCases } = splitAvvik(avvikList);
  const noOwnerRows = noOwnerCases.map((a) => renderAvvikRow(a, notifications, { actionButton: 'resolve', dateField: 'lastNotifiedAt', showPurchaserForm: true })).join('');
  const financeRows = financeCases.map((a) => renderFinanceRow(a)).join('');

  const content = `
    ${renderFinanceStats(financeCases.length, noOwnerCases.length)}

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
function renderInfoCard(label, value, tone = 'neutral') {
  if (!hasValue(value)) return '';
  return `
    <div class="bf-card info-card tone-border-${tone}"><div class="bf-card-content">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(String(value))}</div>
    </div></div>`;
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

// Detail page for a single avvik/ordrelinje, reached from "Dette må gjøres"
// on the open-avvik row panel (see renderDetailRow). Info cards, the header
// icon links, and links all hide themselves rather than rendering an empty
// card/field/placeholder when a value is missing.
function renderAvvikDetailPage(avvik) {
  const { procedure, links, note } = getAvvikDetailContent(avvik);

  // Every key figure shares the same discrepancyType status color (see
  // typeBadges.js - the same mapping already used for the type badge on the
  // open-avvik row and the type donut), rather than each card picking its
  // own tone, so the boxes read as "this avvik's color" at a glance.
  const avvikTone = getTypeBadgeClass(avvik.discrepancyType);
  const infoCards = [
    renderInfoCard('PO-nummer', avvik.poNumber, avvikTone),
    renderInfoCard('Innkjøpsordrenummer', avvik.orderId, avvikTone),
    renderInfoCard('SKU', avvik.articleNumber, avvikTone),
    renderInfoCard('Type avvik', avvik.discrepancyType, avvikTone),
    renderInfoCard('Dager ventende', typeof avvik.daysWaiting === 'number' ? avvik.daysWaiting : null, avvikTone),
    renderInfoCard('Partinummer', avvik.lotNumber, avvikTone),
    renderInfoCard('Videresolgt', avvik.resoldStatus, avvikTone),
    renderInfoCard('Fakturanummer', avvik.invoiceNumber, avvikTone),
  ]
    .filter(Boolean)
    .join('');

  const mediusLinkHtml = avvik.mediusLink
    ? `<a class="external-logo-link" href="${escapeHtml(avvik.mediusLink)}" target="_blank" rel="noopener noreferrer" title="Vis faktura i Medius" aria-label="Vis faktura i Medius">
        <img src="/assets/medius-logo.png" alt="" width="32" height="32">
      </a>`
    : '';
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
  // Spesielle caser - Finance gets the same box/list treatment but under
  // "Informasjon" instead of "Anbefalt fremgangsmåte", since Finance handles
  // it internally rather than following a suggested procedure.
  const procedureHeading =
    avvik.discrepancyType === KOSTNADSFAKTURA_REVERSER ? null : isFinanceCase(avvik.discrepancyType) ? 'Informasjon' : 'Anbefalt fremgangsmåte';

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
        ${renderProcedureSteps(procedure)}
        ${linksHtml}
      </div></div>
    </section>` : ''}`;

  const pageTitle = `${avvik.purchaserName || 'Ukjent sakseier'} – Avvik – ${avvik.orderId}`;
  return renderShell('open', pageTitle, content, { headerActions });
}

function renderArchivePage(avvikList, notifications) {
  const { resolved } = splitAvvik(avvikList);
  const resolvedRows = resolved.map((a) => renderAvvikRow(a, notifications, { actionButton: 'reopen', dateField: 'resolvedAt' })).join('');

  const content = `
    <details class="archive" open>
      <summary class="bf-link">Arkiv — løste avvik (${resolved.length})</summary>
      <div class="section-card">
        <table class="bf-table">
          <thead>
            <tr><th>Ordre</th><th>Innkjøper</th><th>Avdeling</th><th>Avvikstype</th><th>Dager siden mottak</th><th>Løst</th><th></th><th>Kommentarer</th><th>Varsling på e-post</th></tr>
            <tr class="filter-row">
              <th><input type="text" class="bf-input filter-input" data-col="order" placeholder="Filtrer ordre..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="purchaser" placeholder="Filtrer innkjøper..."></th>
              <th></th>
              <th><input type="text" class="bf-input filter-input" data-col="type" placeholder="Filtrer avvikstype..."></th>
              <th></th>
              <th></th>
              <th></th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>${resolvedRows}</tbody>
        </table>
      </div>
    </details>`;

  return renderShell('archive', 'Arkiv', content);
}

module.exports = {
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
