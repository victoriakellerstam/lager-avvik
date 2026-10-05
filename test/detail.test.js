'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderAvvikDetailPage } = require('../src/dashboard');

const avvik = (extra = {}) => ({
  id: 'f82522b49ffeef09',
  orderId: '305590',
  poNumber: '145718',
  articleNumber: 'A1',
  department: 'IT',
  purchaserName: 'Ola',
  supplierName: 'Lev AS',
  discrepancyType: 'Ikke mottatt faktura i Medius',
  comments: [],
  daysWaiting: 30,
  resolved: false,
  ...extra,
});

test('detaljsiden viser kommentarer med vedlegg som nedlastingslenker', () => {
  const html = renderAvvikDetailPage(
    avvik({
      comments: [
        {
          id: 1,
          author: 'Kari <b>',
          text: 'Sjekket',
          createdAt: '2026-10-05T12:00:00.000Z',
          attachments: [{ id: '7a6e053d-c7d6-4d76-82b3-7bca04a7d8a7', name: 'notat æøå.txt', size: 2048 }],
        },
      ],
    })
  );
  assert.match(html, /Kommentarer og vedlegg/);
  assert.match(html, /Kari &lt;b&gt;:/);
  assert.match(html, /href="\/api\/avvik\/f82522b49ffeef09\/attachments\/7a6e053d-c7d6-4d76-82b3-7bca04a7d8a7" download>notat æøå\.txt</);
  assert.match(html, /\(2 KB\)/);
});

test('detaljsiden uten kommentarer sier det, og har ikke lenger fakturaforslag', () => {
  const html = renderAvvikDetailPage(
    avvik({ invoiceSuggestions: [{ strength: 'strong', invoiceNumber: 'F1', reason: 'x' }] })
  );
  assert.match(html, /Ingen kommentarer enna/);
  assert.doesNotMatch(html, /Forslag til faktura/);
  assert.doesNotMatch(html, /invoice-suggestions/);
});

test('detaljsiden viser og lenker alle fakturaer, og merker kreditnotaen', () => {
  const html = renderAvvikDetailPage(
    avvik({
      invoiceNumber: '8281805845',
      mediusLink: 'https://medius.example/1',
      invoices: [
        { invoiceNumber: '8281805845', mediusLink: 'https://medius.example/1', isCreditNote: false },
        { invoiceNumber: '8284689594', mediusLink: 'https://medius.example/2', isCreditNote: true },
      ],
    })
  );
  assert.match(html, />8281805845<\/a>/);
  assert.match(html, />8284689594 \(kreditnota\)<\/a>/);
  assert.equal((html.match(/class="external-logo-link has-caption"/g) || []).length, 2);
  assert.match(html, /href="https:\/\/medius\.example\/2"/);
  assert.match(html, /Vis kreditnota 8284689594 i Medius/);
});

test('detaljsiden med én faktura (eller bare eldre invoiceNumber) ser ut som før', () => {
  const legacy = renderAvvikDetailPage(avvik({ invoiceNumber: 'F9', mediusLink: 'https://medius.example/9' }));
  assert.match(legacy, />F9<\/a>/);
  assert.match(legacy, /title="Vis faktura i Medius"/);
  assert.doesNotMatch(legacy, /has-caption/);
  const none = renderAvvikDetailPage(avvik());
  assert.doesNotMatch(none, /Fakturanummer/);
});
