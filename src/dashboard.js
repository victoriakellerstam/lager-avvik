'use strict';

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
        .map(([name, count]) => `<li>${escapeHtml(name)} — ${count} avvik</li>`)
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
      <div class="stat-label">Åpne</div>
    </div></div>
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-number">${resolved}</div>
      <div class="stat-label">Løste</div>
    </div></div>
    <div class="bf-card"><div class="bf-card-content">
      <div class="stat-label">Flest avvik (totalt)</div>
      <ol class="top-list">${topList}</ol>
    </div></div>
  </div>`;
}

function renderDashboard(avvikList, notifications) {
  const rows = avvikList
    .map((a) => {
      const timesNotified = notifications.filter((n) => n.avvikId === a.id).length;
      const status = a.resolved ? 'løst' : 'åpen';
      return `
    <tr class="avvik-row" data-order="${escapeHtml(a.orderId.toLowerCase())}" data-purchaser="${escapeHtml(a.purchaserName.toLowerCase())}" data-type="${escapeHtml(a.discrepancyType.toLowerCase())}" data-status="${status}">
      <td>${escapeHtml(a.orderId)}</td>
      <td>${escapeHtml(a.purchaserName)}</td>
      <td>${escapeHtml(a.discrepancyType)}</td>
      <td>${a.resolved ? '<span class="bf-badge bfc-success-bg">Løst</span>' : '<span class="bf-badge bfc-attn-bg">Åpen</span>'}</td>
      <td>${a.lastNotifiedAt ? new Date(a.lastNotifiedAt).toLocaleDateString('no-NO') : '—'}</td>
      <td>${a.resolved ? '' : `<button type="button" data-id="${a.id}" class="bf-button resolve">Marker løst</button>`}</td>
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
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="no" data-bf-color-mode="dark">
<head>
<meta charset="utf-8">
<title>Lager-avvik (mockup)</title>
<link rel="stylesheet" href="https://unpkg.com/@intility/bifrost-css@6.11.2/dist/bifrost-all.css">
<style>
  body { font-family: var(--font-open-sans, "Open Sans"), "Segoe UI", sans-serif; margin: var(--bfs32); }
  h1, h2 { font-family: var(--font-satoshi, Satoshi), "Segoe UI", sans-serif; }
  h1 { margin-bottom: var(--bfs2); }
  section { margin-top: var(--bfs48); }
  details summary { cursor: pointer; }
  ul.comments, ul.notif-history { list-style: none; padding: 0; margin: var(--bfs8) 0; }
  ul.comments li, ul.notif-history li { padding: var(--bfs4) 0; border-bottom: var(--bf-border); font-size: var(--bf-font-size-s); }
  ul.comments li.empty, ul.notif-history li.empty { color: var(--bfc-base-c-dimmed); font-style: italic; }
  ul.comments .ts { color: var(--bfc-base-c-dimmed); font-size: var(--bf-font-size-s); }
  form.add-comment { margin-top: var(--bfs8); display: flex; gap: var(--bfs8); flex-wrap: wrap; }
  form.add-comment .bf-input { width: auto; }
  .preview-email { margin-top: var(--bfs8); }
  .email-preview { white-space: pre-wrap; background: var(--bfc-base-2); border: var(--bf-border); border-radius: var(--bf-radius-s); padding: var(--bfs12); margin-top: var(--bfs8); font-size: var(--bf-font-size-s); max-width: 32rem; }
  .stats { display: flex; gap: var(--bfs16); margin-top: var(--bfs24); flex-wrap: wrap; }
  .stats .bf-card { min-width: 10rem; }
  .stat-number { font-size: var(--bf-font-size-h2); font-weight: 700; }
  .stat-label { color: var(--bfc-base-c-dimmed); font-size: var(--bf-font-size-s); }
  .top-list { margin: var(--bfs4) 0 0; padding-left: var(--bfs16); font-size: var(--bf-font-size-s); }
  .filter-row th { padding-top: var(--bfs8); padding-bottom: var(--bfs8); }
  .filter-row .bf-input, .filter-row .bf-select { font-size: var(--bf-font-size-s); padding: var(--bfs4) var(--bfs8); width: 100%; }
</style>
</head>
<body>
  <span class="bf-badge bfc-attn-bg">Mockup — kun for lageravdelingen</span>
  <h1>Lager-avvik</h1>
  <p style="color: var(--bfc-base-c-dimmed)">Denne siden er for oss som rydder opp i avvik - innkjøperne ser den ikke.
     De får kun en e-post om avviket sitt; svarer de på den, eller gir beskjed på annen måte,
     legger vi det inn som en kommentar her. «Sendte e-poster» er kun simulerte forhåndsvisninger —
     ingenting sendes ut på ekte i denne mockupen.</p>
  <button type="button" id="run-job" class="bf-button bf-button-filled">Kjør ukentlig jobb nå (demo)</button>
${renderStats(avvikList)}

  <section>
    <h2>Avvik</h2>
    <table class="bf-table">
      <thead>
        <tr><th>Ordre</th><th>Innkjøper</th><th>Avvikstype</th><th>Status</th><th>Sist varslet</th><th></th><th>Kommentarer</th><th>Varsling på e-post</th></tr>
        <tr class="filter-row">
          <th><input type="text" class="bf-input filter-input" data-col="order" placeholder="Filtrer ordre..."></th>
          <th><input type="text" class="bf-input filter-input" data-col="purchaser" placeholder="Filtrer innkjøper..."></th>
          <th><input type="text" class="bf-input filter-input" data-col="type" placeholder="Filtrer avvikstype..."></th>
          <th>
            <select class="bf-select filter-input" data-col="status">
              <option value="">Alle</option>
              <option value="åpen">Åpen</option>
              <option value="løst">Løst</option>
            </select>
          </th>
          <th></th>
          <th></th>
          <th></th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>

  <script>
    document.querySelectorAll('.resolve').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await fetch('/api/avvik/' + btn.dataset.id + '/resolve', { method: 'POST' });
        location.reload();
      });
    });
    document.getElementById('run-job').addEventListener('click', async () => {
      await fetch('/api/jobs/run-weekly', { method: 'POST' });
      location.reload();
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
    const filterInputs = document.querySelectorAll('.filter-input');
    function applyFilters() {
      const filters = {};
      filterInputs.forEach((el) => {
        const value = el.value.trim().toLowerCase();
        if (value) filters[el.dataset.col] = value;
      });
      document.querySelectorAll('.avvik-row').forEach((row) => {
        const match = Object.keys(filters).every((col) => {
          if (col === 'status') return row.dataset.status === filters[col];
          return row.dataset[col].includes(filters[col]);
        });
        row.hidden = !match;
      });
    }
    filterInputs.forEach((el) => {
      el.addEventListener('input', applyFilters);
      el.addEventListener('change', applyFilters);
    });
  </script>
</body>
</html>`;
}

module.exports = { renderDashboard, escapeHtml };
