'use strict';

const { getTypeBadgeClass } = require('./typeBadges');
const { getInstructions } = require('./instructions');
const { isFinanceCase } = require('./financeTypes');

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

function renderStats(avvikList) {
  const open = avvikList.filter((a) => !a.resolved).length;
  const resolved = avvikList.length - open;

  const counts = new Map();
  for (const a of avvikList) {
    counts.set(a.purchaserName, (counts.get(a.purchaserName) || 0) + 1);
  }
  const top3 = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);

  const topList = top3.length
    ? top3
        .map(([name, count]) => `<li>${escapeHtml(name || 'Ukjent')} — ${count} avvik</li>`)
        .join('')
    : '<li class="empty">Ingen avvik registrert.</li>';

  return `
  <div class="stats">
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-number">${avvikList.length}</div>
      <div class="stat-label">Avvik totalt</div>
    </div></div>
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-number">${open}</div>
      <div class="stat-label">Antall åpne avvik</div>
    </div></div>
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-number">${resolved}</div>
      <div class="stat-label">Antall løst</div>
    </div></div>
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-label">Flest avvik (totalt)</div>
      <ol class="top-list">${topList}</ol>
    </div></div>
    ${renderTypeDonut(avvikList)}
  </div>`;
}

// A dependency-free donut chart: each ring segment is one <circle> with a
// 100-unit circumference (r = 15.91549430918954, since 2*pi*r = 100), so
// stroke-dasharray/-dashoffset can be expressed directly as percentages.
// Colors reuse the same Bifrost category as the type's badge, so the chart
// and the table agree visually.
function renderTypeDonut(avvikList) {
  const total = avvikList.length;
  const counts = new Map();
  for (const a of avvikList) {
    counts.set(a.discrepancyType, (counts.get(a.discrepancyType) || 0) + 1);
  }
  const entries = [...counts.entries()].sort((x, y) => y[1] - x[1]);

  let cumulative = 0;
  const segments = entries
    .map(([type, count]) => {
      const percent = total ? (count / total) * 100 : 0;
      const dashoffset = 25 - cumulative;
      cumulative += percent;
      const color = `var(--bfc-${getTypeBadgeClass(type)})`;
      return `<circle cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="${color}" stroke-width="3" stroke-dasharray="${percent.toFixed(2)} ${(100 - percent).toFixed(2)}" stroke-dashoffset="${dashoffset.toFixed(2)}"></circle>`;
    })
    .join('');

  const legend = entries.length
    ? entries
        .map(([type, count]) => {
          const color = `var(--bfc-${getTypeBadgeClass(type)})`;
          const percent = total ? Math.round((count / total) * 100) : 0;
          return `<li><span class="legend-swatch" style="background:${color}"></span>${escapeHtml(type)} — ${count} (${percent}%)</li>`;
        })
        .join('')
    : '<li class="empty">Ingen avvik registrert.</li>';

  return `
    <div class="bf-card donut-card"><div class="bf-card-content">
      <div class="bf-card-title">Fordeling per avvikstype</div>
      <div class="donut-wrap">
        <svg viewBox="0 0 42 42" class="donut" role="img" aria-label="Fordeling av avvikstyper">
          <circle cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="var(--bfc-base-2)" stroke-width="3"></circle>
          ${segments}
        </svg>
        <ul class="donut-legend">${legend}</ul>
      </div>
    </div></div>`;
}

function renderAvvikRow(a, notifications, { actionButton, dateField }) {
  const timesNotified = notifications.filter((n) => n.avvikId === a.id).length;
  const dateValue = dateField === 'resolvedAt' ? a.resolvedAt : a.lastNotifiedAt;
  let actionCell = '';
  if (actionButton === 'resolve') {
    actionCell = `<td><button type="button" data-id="${a.id}" class="bf-button bf-button-small resolve">Marker løst</button></td>`;
  } else if (actionButton === 'reopen') {
    actionCell = `<td><button type="button" data-id="${a.id}" class="bf-button bf-button-small reopen">Gjenåpne</button></td>`;
  }
  return `
    <tr class="avvik-row" data-order="${escapeHtml(a.orderId.toLowerCase())}" data-purchaser="${escapeHtml((a.purchaserName || '').toLowerCase())}" data-type="${escapeHtml(a.discrepancyType.toLowerCase())}">
      <td>${escapeHtml(a.orderId)}</td>
      <td>${a.purchaserName ? escapeHtml(a.purchaserName) : '—'}</td>
      <td><span class="bf-badge bfc-${getTypeBadgeClass(a.discrepancyType)}-bg">${escapeHtml(a.discrepancyType)}</span></td>
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

// Finance-only cases never get an email, so this row shows a resolution
// procedure (the same instruction steps that would otherwise go in an
// email) instead of any email-preview UI.
function renderFinanceRow(a) {
  const steps = getInstructions(a.discrepancyType);
  const procedure = steps.length
    ? `<ol class="procedure-list">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
    : '—';
  return `
    <tr class="avvik-row" data-order="${escapeHtml(a.orderId.toLowerCase())}" data-purchaser="${escapeHtml((a.purchaserName || '').toLowerCase())}" data-type="${escapeHtml(a.discrepancyType.toLowerCase())}">
      <td>${escapeHtml(a.orderId)}</td>
      <td>${a.purchaserName ? escapeHtml(a.purchaserName) : '—'}</td>
      <td>${a.resolved ? '<span class="bf-badge bfc-success-bg">Løst</span>' : '<span class="bf-badge bfc-attn-bg">Åpen</span>'}</td>
      <td>${procedure}</td>
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

function renderDashboard(avvikList, notifications) {
  const financeCases = avvikList.filter((a) => isFinanceCase(a.discrepancyType));
  const rest = avvikList.filter((a) => !isFinanceCase(a.discrepancyType));
  const open = rest.filter((a) => !a.resolved);
  const resolved = rest.filter((a) => a.resolved);

  const openRows = open.map((a) => renderAvvikRow(a, notifications, { actionButton: 'resolve', dateField: 'lastNotifiedAt' })).join('');
  const resolvedRows = resolved.map((a) => renderAvvikRow(a, notifications, { actionButton: 'reopen', dateField: 'resolvedAt' })).join('');
  const financeRows = financeCases.map((a) => renderFinanceRow(a)).join('');

  return `<!DOCTYPE html>
<html lang="no" data-bf-color-mode="dark">
<head>
<meta charset="utf-8">
<title>Lager-avvik (mockup)</title>
<link rel="stylesheet" href="https://unpkg.com/@intility/bifrost-css@6.11.2/dist/bifrost-all.css">
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--font-open-sans, "Open Sans"), "Segoe UI", sans-serif; margin: 0; }
  h1, h2, h3 { font-family: var(--font-satoshi, Satoshi), "Segoe UI", sans-serif; }
  .page { max-width: 68rem; margin: 0 auto; padding: var(--bfs40) var(--bfs32) var(--bfs80); }
  .page-header { margin-bottom: var(--bfs32); }
  .page-header h1 { margin: var(--bfs8) 0 var(--bfs4); font-size: var(--bf-font-size-h1); }
  .page-header p { margin: 0; max-width: 46rem; color: var(--bfc-base-c-dimmed); }
  .toolbar { margin-top: var(--bfs16); display: flex; align-items: center; gap: var(--bfs12); flex-wrap: wrap; }
  .test-dwh-result { font-size: var(--bf-font-size-s); }
  .test-dwh-result.ok { color: var(--bfc-success); }
  .test-dwh-result.fail { color: var(--bfc-alert); }
  section { margin-top: var(--bfs48); }
  .section-header { display: flex; align-items: center; gap: var(--bfs12); margin-bottom: var(--bfs16); }
  .section-header h2 { margin: 0; }
  .section-note { margin: 0 0 var(--bfs12); color: var(--bfc-base-c-dimmed); font-size: var(--bf-font-size-s); }
  .procedure-list { margin: 0; padding-left: var(--bfs16); font-size: var(--bf-font-size-s); }
  .procedure-list li { padding: var(--bfs2) 0; }
  .section-card { background: var(--bfc-base-3); border-radius: var(--bf-radius-m); border: var(--bf-border); overflow: hidden; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
  .section-card .bf-table { margin: 0; }
  details.archive { margin-top: var(--bfs48); }
  details.archive > summary { font-size: var(--bf-font-size-l); font-weight: 600; }
  details.archive .section-card { margin-top: var(--bfs16); }
  details summary { cursor: pointer; }
  ul.comments, ul.notif-history { list-style: none; padding: 0; margin: var(--bfs8) 0; }
  ul.comments li, ul.notif-history li { padding: var(--bfs4) 0; border-bottom: var(--bf-border); font-size: var(--bf-font-size-s); }
  ul.comments li.empty, ul.notif-history li.empty { color: var(--bfc-base-c-dimmed); font-style: italic; }
  ul.comments .ts { color: var(--bfc-base-c-dimmed); font-size: var(--bf-font-size-s); }
  form.add-comment { margin-top: var(--bfs8); display: flex; gap: var(--bfs8); flex-wrap: wrap; }
  form.add-comment .bf-input { width: auto; }
  .preview-email { margin-top: var(--bfs8); }
  .email-preview { white-space: pre-wrap; background: var(--bfc-base-2); border: var(--bf-border); border-radius: var(--bf-radius-s); padding: var(--bfs12); margin-top: var(--bfs8); font-size: var(--bf-font-size-s); max-width: 32rem; }
  .stats { display: flex; gap: var(--bfs16); flex-wrap: wrap; }
  .stats .bf-card { min-width: 10rem; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
  .stat-number { font-size: var(--bf-font-size-h2); font-weight: 700; }
  .stat-label { color: var(--bfc-base-c-dimmed); font-size: var(--bf-font-size-s); }
  .top-list { margin: var(--bfs4) 0 0; padding-left: var(--bfs16); font-size: var(--bf-font-size-s); }
  .donut-card { min-width: 20rem; flex: 1 1 20rem; }
  .donut-wrap { display: flex; align-items: center; gap: var(--bfs16); flex-wrap: wrap; }
  .donut { width: 8rem; height: 8rem; flex-shrink: 0; transform: rotate(0deg); }
  .donut-legend { list-style: none; margin: 0; padding: 0; font-size: var(--bf-font-size-s); flex: 1 1 12rem; }
  .donut-legend li { display: flex; align-items: center; gap: var(--bfs8); padding: var(--bfs2) 0; }
  .donut-legend li.empty { color: var(--bfc-base-c-dimmed); font-style: italic; }
  .legend-swatch { display: inline-block; width: 0.7rem; height: 0.7rem; border-radius: var(--bf-radius-full); flex-shrink: 0; }
  .filter-row th { padding-top: var(--bfs8); padding-bottom: var(--bfs8); background: var(--bfc-base-2); }
  .filter-row .bf-input { font-size: var(--bf-font-size-s); padding: var(--bfs4) var(--bfs8); width: 100%; min-width: 9rem; }
</style>
</head>
<body>
  <div class="page">
    <header class="page-header">
      <span class="bf-badge bfc-attn-bg">Under arbeid</span>
      <h1>Lager-avvik</h1>
      <p>Denne siden er for oss som rydder opp i avvik - innkjøperne ser den ikke.
        De får kun en e-post om avviket sitt; svarer de på den, eller gir beskjed på annen måte,
        legger vi det inn som en kommentar her. «Sendte e-poster» er kun simulerte forhåndsvisninger —
        ingenting sendes ut på ekte i denne mockupen.</p>
      <div class="toolbar">
        <button type="button" id="run-job" class="bf-button bf-button-filled">Kjør ukentlig jobb nå (demo)</button>
        <button type="button" id="test-dwh" class="bf-button">Test tilkobling til dwh</button>
        <span id="test-dwh-result" class="test-dwh-result"></span>
        <button type="button" id="refresh-dwh" class="bf-button">Oppdater fra dwh</button>
        <span id="refresh-dwh-result" class="test-dwh-result"></span>
      </div>
    </header>

    ${renderStats(avvikList)}

    <section id="open-section">
      <div class="section-header">
        <h2>Åpne avvik</h2>
        <span class="bf-badge bfc-attn-bg">${open.length}</span>
      </div>
      <div class="section-card">
        <table class="bf-table">
          <thead>
            <tr><th>Ordre</th><th>Innkjøper</th><th>Avvikstype</th><th>Sist varslet</th><th></th><th>Kommentarer</th><th>Varsling på e-post</th></tr>
            <tr class="filter-row">
              <th><input type="text" class="bf-input filter-input" data-col="order" placeholder="Filtrer ordre..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="purchaser" placeholder="Filtrer innkjøper..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="type" placeholder="Filtrer avvikstype..."></th>
              <th></th>
              <th></th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>${openRows}</tbody>
        </table>
      </div>
    </section>

    <section>
      <div class="section-header">
        <h2>Spesielle caser - Finance</h2>
        <span class="bf-badge bfc-theme-bg">${financeCases.length}</span>
      </div>
      <p class="section-note">Disse håndteres av Finance internt - innkjøper varsles aldri på e-post om dem.</p>
      <div class="section-card">
        <table class="bf-table">
          <thead>
            <tr><th>Ordre</th><th>Innkjøper</th><th>Status</th><th>Fremgangsmåte</th><th>Kommentarer</th><th></th></tr>
          </thead>
          <tbody>${financeRows}</tbody>
        </table>
      </div>
    </section>

    <details class="archive">
      <summary class="bf-link">Arkiv — løste avvik (${resolved.length})</summary>
      <div class="section-card">
        <table class="bf-table">
          <thead>
            <tr><th>Ordre</th><th>Innkjøper</th><th>Avvikstype</th><th>Løst</th><th></th><th>Kommentarer</th><th>Varsling på e-post</th></tr>
            <tr class="filter-row">
              <th><input type="text" class="bf-input filter-input" data-col="order" placeholder="Filtrer ordre..."></th>
              <th><input type="text" class="bf-input filter-input" data-col="purchaser" placeholder="Filtrer innkjøper..."></th>
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
    </details>
  </div>

  <script>
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
    document.getElementById('run-job').addEventListener('click', async () => {
      await fetch('/api/jobs/run-weekly', { method: 'POST' });
      location.reload();
    });
    document.getElementById('test-dwh').addEventListener('click', async () => {
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
    document.getElementById('refresh-dwh').addEventListener('click', async () => {
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
    // Each section (open avvik, archive) has its own filter row - scoped
    // per-section so the two "Filtrer innkjøper..." boxes don't clobber
    // each other's filters.
    document.querySelectorAll('#open-section, details.archive').forEach((section) => {
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
  </script>
</body>
</html>`;
}

module.exports = { renderDashboard, escapeHtml };
