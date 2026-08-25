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
      <td>${a.resolved ? 'Løst' : 'Åpen'}</td>
      <td>${a.lastNotifiedAt ? new Date(a.lastNotifiedAt).toLocaleDateString('no-NO') : '—'}</td>
      <td>${a.resolved ? '' : `<button data-id="${a.id}" class="resolve">Marker løst</button>`}</td>
      <td>
        <details>
          <summary>${a.comments.length} kommentar${a.comments.length === 1 ? '' : 'er'}</summary>
          <ul class="comments">${renderComments(a.comments)}</ul>
          <form class="add-comment" data-id="${a.id}">
            <input type="text" name="author" placeholder="Ditt navn" required maxlength="100">
            <input type="text" name="text" placeholder="Skriv en kommentar" required maxlength="2000">
            <button type="submit">Legg til</button>
          </form>
        </details>
      </td>
      <td>
        <details>
          <summary>${timesNotified} ganger varslet på e-post</summary>
          <ul class="notif-history">${renderNotificationHistory(a.id, notifications)}</ul>
        </details>
        <button type="button" class="preview-email" data-id="${a.id}">Vis e-posteksempel</button>
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
<html lang="no">
<head>
<meta charset="utf-8">
<title>Lager-avvik (mockup)</title>
<style>
  :root {
    --bg: #0f1115;
    --surface: #1a1d24;
    --surface-alt: #22262f;
    --border: #333844;
    --text: #e5e7eb;
    --text-muted: #9aa1ad;
    --accent: #f5c451;
    --accent-text: #1a1408;
    --link: #7aa2f7;
  }
  body { font-family: system-ui, sans-serif; margin: 2rem; color: var(--text); background: var(--bg); }
  h1 { margin-bottom: 0.2rem; color: #fff; }
  h2 { color: #fff; }
  p { color: var(--text-muted); }
  .badge { display:inline-block; padding:0.2rem 0.6rem; background: var(--accent); color: var(--accent-text); border-radius:0.4rem; font-size:0.8rem; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; background: var(--surface); }
  th, td { border: 1px solid var(--border); padding: 0.5rem; text-align: left; font-size: 0.9rem; }
  th { background: var(--surface-alt); color: #fff; }
  button { cursor: pointer; background: var(--surface-alt); color: var(--text); border: 1px solid var(--border); border-radius: 0.3rem; padding: 0.35rem 0.7rem; }
  button:hover { background: var(--border); }
  #run-job { background: var(--accent); color: var(--accent-text); border: none; font-weight: 600; padding: 0.5rem 1rem; }
  section { margin-top: 2.5rem; }
  details summary { cursor: pointer; color: var(--link); }
  ul.comments { list-style: none; padding: 0; margin: 0.5rem 0; }
  ul.comments li { padding: 0.25rem 0; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
  ul.comments li.empty { color: var(--text-muted); font-style: italic; }
  ul.comments .ts { color: var(--text-muted); font-size: 0.75rem; }
  form.add-comment { margin-top: 0.5rem; display: flex; gap: 0.4rem; flex-wrap: wrap; }
  form.add-comment input { padding: 0.3rem; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 0.25rem; }
  ul.notif-history { list-style: none; padding: 0; margin: 0.5rem 0; }
  ul.notif-history li { padding: 0.25rem 0; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
  ul.notif-history li.empty { color: var(--text-muted); font-style: italic; }
  .preview-email { margin-top: 0.5rem; }
  .email-preview { white-space: pre-wrap; background: var(--surface-alt); color: var(--text); border: 1px solid var(--border); padding: 0.6rem; margin-top: 0.5rem; font-size: 0.8rem; max-width: 32rem; }
</style>
</head>
<body>
  <span class="badge">Mockup — ingen ekte e-post sendes</span>
  <h1>Lager-avvik: varsling til innkjøpere</h1>
  <p>Denne siden viser hvordan ukentlig varsling om avvik på ordre kunne fungert.
     Data er testdata, og «sendte e-poster» er kun simulerte forhåndsvisninger —
     ingenting sendes ut på ekte.</p>
  <button id="run-job">Kjør ukentlig jobb nå (demo)</button>

  <section>
    <h2>Avvik</h2>
    <table>
      <thead><tr><th>Ordre</th><th>Innkjøper</th><th>Avvikstype</th><th>Status</th><th>Sist varslet</th><th></th><th>Kommentarer</th><th>Varsling på e-post</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>

  <section>
    <h2>Alle sendte varsler (hvem er varslet på e-post, og når)</h2>
    <table>
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
