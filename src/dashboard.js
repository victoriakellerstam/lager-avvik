'use strict';

const { getTypeBadgeClass } = require('./typeBadges');
const { isFinanceCase } = require('./financeTypes');
const { KOSTNADSFAKTURA_REVERSER } = require('./discrepancyTypes');

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
      return `<circle cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="${color}" stroke-width="3" stroke-dasharray="${percent.toFixed(2)} ${(100 - percent).toFixed(2)}" stroke-dashoffset="${dashoffset.toFixed(2)}"${cls}${filterAttrs}></circle>`;
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
          <circle cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="var(--bfc-base-2)" stroke-width="3"></circle>
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
    </div></div>
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-number">${resolvedCount}</div>
      <div class="stat-label">Antall løst</div>
    </div></div>
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-label">Topp 5 — flest avvik</div>
      <ol class="top-list">${topList}</ol>
    </div></div>
    ${renderTypeDonut(openAvvikList)}
    ${renderDepartmentDonut(openAvvikList)}
  </div>`;
}

function renderAvvikRow(a, notifications, { actionButton, dateField, showPurchaserForm }) {
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
  return `
    <tr class="avvik-row" data-order="${escapeHtml(a.orderId.toLowerCase())}" data-purchaser="${escapeHtml((a.purchaserName || '').toLowerCase())}" data-department="${escapeHtml((a.department || '').toLowerCase())}" data-type="${escapeHtml(a.discrepancyType.toLowerCase())}">
      <td>${escapeHtml(a.orderId)}</td>
      <td>${purchaserCell}</td>
      <td>${a.department ? escapeHtml(a.department) : '—'}</td>
      <td><span class="bf-badge bfc-${getTypeBadgeClass(a.discrepancyType)}-bg">${escapeHtml(a.discrepancyType)}</span></td>
      <td>${typeof a.daysWaiting === 'number' ? a.daysWaiting : '—'}</td>
      <td>${dateValue ? new Date(dateValue).toLocaleDateString('no-NO') : '—'}</td>
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
      <td>
        <details>
          <summary class="bf-link">${timesNotified} ganger varslet på e-post</summary>
          <ul class="notif-history">${renderNotificationHistory(a.id, notifications)}</ul>
        </details>
        <button type="button" class="bf-button bf-button-small preview-email" data-id="${a.id}">Vis e-posteksempel</button>
        <pre class="email-preview" data-id="${a.id}" hidden></pre>
      </td>
    </tr>`;
}

// Finance-only cases never get an email, so there's no email-preview UI here.
// The status column shows the actual discrepancyType badge (not a generic
// Åpen/Løst) since this table now also holds Kostnadsfaktura — reverser
// cases alongside genuine Spesielle caser - Finance ones.
function renderFinanceRow(a) {
  return `
    <tr class="avvik-row" data-order="${escapeHtml(a.orderId.toLowerCase())}" data-purchaser="${escapeHtml((a.purchaserName || '').toLowerCase())}" data-type="${escapeHtml(a.discrepancyType.toLowerCase())}">
      <td>${escapeHtml(a.orderId)}</td>
      <td>${a.purchaserName ? escapeHtml(a.purchaserName) : '—'}</td>
      <td>${a.department ? escapeHtml(a.department) : '—'}</td>
      <td><span class="bf-badge bfc-${getTypeBadgeClass(a.discrepancyType)}-bg">${escapeHtml(a.discrepancyType)}</span></td>
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
    </tr>`;
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
  { key: 'open', href: '/', label: 'Åpne avvik' },
  { key: 'finance', href: '/finance', label: 'Saker som løses av Finance' },
  { key: 'archive', href: '/arkiv', label: 'Arkiv' },
];

function renderSidebar(activeKey) {
  const links = NAV_ITEMS.map(
    (item) =>
      `<li><a href="${item.href}"${item.key === activeKey ? ' class="active" aria-current="page"' : ''}>${item.label}</a></li>`
  ).join('');
  return `
  <aside class="sidebar">
    <div class="brand">Lager-avvik</div>
    <nav><ul>${links}</ul></nav>
  </aside>`;
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
    document.querySelectorAll('#open-section, #no-owner-section, details.archive').forEach((section) => {
      const filterInputs = section.querySelectorAll('.filter-input');
      function applyFilters() {
        const filters = {};
        filterInputs.forEach((el) => {
          const value = el.value.trim().toLowerCase();
          if (value) filters[el.dataset.col] = value;
        });
        section.querySelectorAll('.avvik-row').forEach((row) => {
          const match = Object.keys(filters).every((col) => row.dataset[col].includes(filters[col]));
          row.hidden = !match;
        });
      }
      filterInputs.forEach((el) => {
        el.addEventListener('input', applyFilters);
        el.addEventListener('change', applyFilters);
      });
    });
    // Clicking a name in "Topp 5", a donut legend entry, or a donut segment
    // sets the matching filter box on the open-avvik list and re-runs its
    // existing filter logic (above) via a plain input event - no separate
    // filtering logic needed here.
    document.querySelectorAll('[data-filter-col]').forEach((el) => {
      el.addEventListener('click', () => {
        const input = document.querySelector(
          '#open-section .filter-input[data-col="' + el.dataset.filterCol + '"]'
        );
        if (!input) return;
        input.value = el.dataset.filterValue;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });`;

const SHARED_STYLE = `
  * { box-sizing: border-box; }
  body { font-family: var(--font-open-sans, "Open Sans"), "Segoe UI", sans-serif; margin: 0; display: flex; min-height: 100vh; }
  h1, h2, h3 { font-family: var(--font-satoshi, Satoshi), "Segoe UI", sans-serif; }
  .sidebar { width: 17rem; flex-shrink: 0; background: var(--bfc-base-2); border-right: var(--bf-border); padding: var(--bfs24) var(--bfs16); position: sticky; top: 0; align-self: flex-start; height: 100vh; overflow-y: auto; }
  .sidebar .brand { font-weight: 700; font-size: var(--bf-font-size-h2); color: #fff; margin-bottom: var(--bfs24); }
  .sidebar nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--bfs4); }
  .sidebar nav a { display: block; padding: var(--bfs8) var(--bfs12); border-radius: var(--bf-radius-s); color: var(--bfc-base-c); text-decoration: none; font-size: var(--bf-font-size-m); }
  .sidebar nav a:hover { background: var(--bfc-base-3); }
  .sidebar nav a.active { background: var(--bfc-theme); color: var(--bfc-theme-c, #fff); font-weight: 600; }
  .main { flex: 1 1 auto; min-width: 0; }
  .page { max-width: none; margin: 0; padding: var(--bfs40) var(--bfs32) var(--bfs80); }
  .page-header { margin-bottom: var(--bfs32); }
  .page-header h1 { margin: var(--bfs8) 0 var(--bfs4); font-size: var(--bf-font-size-h1); }
  .toolbar { margin-top: var(--bfs16); display: flex; align-items: center; gap: var(--bfs12); flex-wrap: wrap; }
  .test-dwh-result { font-size: var(--bf-font-size-s); }
  .test-dwh-result.ok { color: var(--bfc-success); }
  .test-dwh-result.fail { color: var(--bfc-alert); }
  section { margin-top: var(--bfs48); }
  .section-header { display: flex; align-items: center; gap: var(--bfs12); margin-bottom: var(--bfs16); }
  .section-header h2 { margin: 0; }
  .section-note { margin: 0 0 var(--bfs12); color: var(--bfc-base-c-dimmed); font-size: var(--bf-font-size-s); }
  .section-card { background: var(--bfc-base-3); border-radius: var(--bf-radius-m); border: var(--bf-border); overflow: hidden; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
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
  .stats .bf-card { min-width: 10rem; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
  .stat-number { font-size: var(--bf-font-size-h2); font-weight: 700; color: #fff; }
  .stat-label { color: #fff; font-size: var(--bf-font-size-s); }
  .top-list { margin: var(--bfs4) 0 0; padding-left: var(--bfs16); font-size: var(--bf-font-size-s); color: #fff; }
  .donut-card { min-width: 20rem; flex: 1 1 20rem; }
  .donut-wrap { display: flex; align-items: center; gap: var(--bfs16); flex-wrap: wrap; }
  .donut { width: 8rem; height: 8rem; flex-shrink: 0; transform: rotate(0deg); }
  .donut-legend { list-style: none; margin: 0; padding: 0; font-size: var(--bf-font-size-s); flex: 1 1 12rem; color: #fff; }
  .donut-legend li { display: flex; align-items: center; gap: var(--bfs8); padding: var(--bfs2) 0; }
  .donut-legend li.empty { color: var(--bfc-base-c-dimmed); font-style: italic; }
  .legend-swatch { display: inline-block; width: 0.7rem; height: 0.7rem; border-radius: var(--bf-radius-full); flex-shrink: 0; }
  .clickable { cursor: pointer; }
  li.clickable:hover, .top-list li.clickable:hover { text-decoration: underline; }
  circle.clickable:hover { opacity: 0.8; }
  .filter-row th { padding-top: var(--bfs8); padding-bottom: var(--bfs8); background: var(--bfc-base-2); }
  .filter-row .bf-input { font-size: var(--bf-font-size-s); padding: var(--bfs4) var(--bfs8); width: 100%; min-width: 9rem; }`;

function renderShell(activeKey, title, contentHtml, { showToolbar } = {}) {
  return `<!DOCTYPE html>
<html lang="no" data-bf-color-mode="dark">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — Lager-avvik</title>
<link rel="stylesheet" href="https://unpkg.com/@intility/bifrost-css@6.11.2/dist/bifrost-all.css">
<style>${SHARED_STYLE}</style>
</head>
<body>
  ${renderSidebar(activeKey)}
  <main class="main">
    <div class="page">
      <header class="page-header">
        <span class="bf-badge bfc-attn-bg">Under arbeid</span>
        <h1>${escapeHtml(title)}</h1>
        ${showToolbar ? renderToolbar() : ''}
      </header>
      ${contentHtml}
    </div>
  </main>
  <script>${SHARED_SCRIPT}</script>
</body>
</html>`;
}

function renderOpenAvvikPage(avvikList, notifications) {
  const { open, resolved } = splitAvvik(avvikList);
  const openRows = open.map((a) => renderAvvikRow(a, notifications, { actionButton: 'resolve', dateField: 'lastNotifiedAt' })).join('');

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
            <tr><th>Ordre</th><th>Innkjøper</th><th>Avdeling</th><th>Avvikstype</th><th>Dager siden mottak</th><th>Sist varslet</th><th></th><th>Kommentarer</th><th>Varsling på e-post</th></tr>
            <tr class="filter-row">
              <th><input type="text" class="bf-input filter-input" data-col="order" placeholder="Filtrer ordre..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="purchaser" placeholder="Filtrer innkjøper..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="department" placeholder="Filtrer avdeling..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="type" placeholder="Filtrer avvikstype..."></th>
              <th></th>
              <th></th>
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

function renderFinancePage(avvikList, notifications) {
  const { financeCases, noOwnerCases } = splitAvvik(avvikList);
  const noOwnerRows = noOwnerCases.map((a) => renderAvvikRow(a, notifications, { actionButton: 'resolve', dateField: 'lastNotifiedAt', showPurchaserForm: true })).join('');
  const financeRows = financeCases.map((a) => renderFinanceRow(a)).join('');

  const content = `
    <section>
      <div class="section-header">
        <h2>Spesielle caser - Finance</h2>
        <span class="bf-badge bfc-theme-bg">${financeCases.length}</span>
      </div>
      <p class="section-note">En varefaktura (ikke kostnadsfaktura) matchet på PO-nummer + artikkel som er arkivert i Medius, men linjen står likevel som et åpent avvik (&gt;21 dager). Altså: fakturaen er ferdigbehandlet/arkivert, men noe stemmer ikke siden ordren fortsatt vises som avvik — Finance må se nærmere på det.</p>
      <div class="section-card">
        <table class="bf-table">
          <thead>
            <tr><th>Ordre</th><th>Innkjøper</th><th>Avdeling</th><th>Avvikstype</th><th>Kommentarer</th><th></th></tr>
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

module.exports = { renderOpenAvvikPage, renderFinancePage, renderArchivePage, escapeHtml };
