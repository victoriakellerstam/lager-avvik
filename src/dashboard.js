'use strict';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderDashboard(avvikList, notifications) {
  const rows = avvikList
    .map(
      (a) => `
    <tr>
      <td>${escapeHtml(a.orderId)}</td>
      <td>${escapeHtml(a.purchaserName)}</td>
      <td>${escapeHtml(a.discrepancyType)}</td>
      <td>${a.resolved ? 'Løst' : 'Åpen'}</td>
      <td>${a.lastNotifiedAt ? new Date(a.lastNotifiedAt).toLocaleDateString('no-NO') : '—'}</td>
      <td>${a.resolved ? '' : `<button data-id="${a.id}" class="resolve">Marker løst</button>`}</td>
    </tr>`
    )
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
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { margin-bottom: 0.2rem; }
  .badge { display:inline-block; padding:0.2rem 0.6rem; background:#fde68a; border-radius:0.4rem; font-size:0.8rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; font-size: 0.9rem; }
  th { background: #f3f4f6; }
  button { cursor: pointer; }
  section { margin-top: 2.5rem; }
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
      <thead><tr><th>Ordre</th><th>Innkjøper</th><th>Avvikstype</th><th>Status</th><th>Sist varslet</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>

  <section>
    <h2>Simulerte varsler (e-postforhåndsvisning)</h2>
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
  </script>
</body>
</html>`;
}

module.exports = { renderDashboard, escapeHtml };
