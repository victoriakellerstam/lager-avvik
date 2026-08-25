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

function renderDashboard(avvikList, notifications) {
  const rows = avvikList
    .map((a) => {
      const timesNotified = notifications.filter((n) => n.avvikId === a.id).length;
      return `
    <tr>
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

  const notifRows = notifications
    .map(
      (n) => `
    <tr>
      <td>${new Date(n.sentAt).toLocaleString('no-NO')}</td>
      <td>${escapeHtml(n.to)}</td>
      <td>${escapeHtml(n.subject)}</td>
    </tr>`
    )
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
</style>
</head>
<body>
  <span class="bf-badge bfc-attn-bg">Mockup — ingen ekte e-post sendes</span>
  <h1>Lager-avvik: varsling til innkjøpere</h1>
  <p style="color: var(--bfc-base-c-dimmed)">Denne siden viser hvordan ukentlig varsling om avvik på ordre kunne fungert.
     Data er testdata, og «sendte e-poster» er kun simulerte forhåndsvisninger —
     ingenting sendes ut på ekte.</p>
  <button type="button" id="run-job" class="bf-button bf-button-filled">Kjør ukentlig jobb nå (demo)</button>

  <section>
    <h2>Avvik</h2>
    <table class="bf-table">
      <thead><tr><th>Ordre</th><th>Innkjøper</th><th>Avvikstype</th><th>Status</th><th>Sist varslet</th><th></th><th>Kommentarer</th><th>Varsling på e-post</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>

  <section>
    <h2>Alle sendte varsler (hvem er varslet på e-post, og når)</h2>
    <table class="bf-table">
      <thead><tr><th>Tidspunkt</th><th>Til</th><th>Emne</th></tr></thead>
      <tbody>${notifRows}</tbody>
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
        pre.hidden = false;
        pre.textContent = 'Laster e-posteksempel...';
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
  </script>
</body>
</html>`;
}

module.exports = { renderDashboard, escapeHtml };
