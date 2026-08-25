'use strict';

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(9, 0, 0, 0);
  return d.toISOString();
}

// Test data only. No real orders, purchasers, or email addresses. The
// discrepancyType values match the real scenario catalog (SCENARIOER OG
// ANBEFALTE TILTAK), see src/instructions.js and src/typeBadges.js.
const SEED_AVVIK = [
  {
    id: 1,
    orderId: 'SO-10245',
    purchaserName: 'Kari Nordmann',
    purchaserEmail: 'kari.nordmann@example.com',
    discrepancyType: 'Ikke mottatt faktura i Medius',
    createdAt: daysAgo(20),
    resolved: false,
    resolvedAt: null,
    lastNotifiedAt: daysAgo(9),
    comments: [
      {
        id: 1,
        author: 'Ole (lager)',
        text: 'Har sjekket Medius, ingen faktura registrert enna. Venter pa svar fra innkjoper.',
        createdAt: daysAgo(8),
      },
    ],
  },
  {
    id: 2,
    orderId: 'SO-10312',
    purchaserName: 'Ola Hansen',
    purchaserEmail: 'ola.hansen@example.com',
    discrepancyType: 'Internbestilling',
    createdAt: daysAgo(15),
    resolved: false,
    resolvedAt: null,
    lastNotifiedAt: daysAgo(3),
    comments: [],
  },
  {
    id: 3,
    orderId: 'SO-10399',
    purchaserName: 'Per Iversen',
    purchaserEmail: 'per.iversen@example.com',
    discrepancyType: 'Kostnadsfaktura — reverser',
    createdAt: daysAgo(5),
    resolved: false,
    resolvedAt: null,
    lastNotifiedAt: null,
    comments: [
      {
        id: 1,
        author: 'Per Iversen',
        text: 'Skal reversere fakturaen denne uken.',
        createdAt: daysAgo(4),
      },
    ],
  },
  {
    id: 4,
    orderId: 'SO-10410',
    purchaserName: 'Silje Berg',
    purchaserEmail: 'silje.berg@example.com',
    discrepancyType: 'Kredittkort lisenskjøp, feilaktig mottatt',
    createdAt: daysAgo(30),
    resolved: true,
    resolvedAt: daysAgo(2),
    lastNotifiedAt: daysAgo(10),
    comments: [
      {
        id: 1,
        author: 'Silje Berg',
        text: 'Rettet i systemet, lisenskjopet er na korrekt registrert.',
        createdAt: daysAgo(2),
      },
    ],
  },
  {
    id: 5,
    orderId: 'SO-10455',
    purchaserName: 'Mona Lund',
    purchaserEmail: 'mona.lund@example.com',
    discrepancyType: 'Manuell ordre',
    createdAt: daysAgo(2),
    resolved: false,
    resolvedAt: null,
    lastNotifiedAt: null,
    comments: [],
  },
  {
    id: 6,
    orderId: 'SO-10501',
    purchaserName: 'Thomas Vik',
    purchaserEmail: 'thomas.vik@example.com',
    discrepancyType: 'Ordre opprettet med feilaktig distributør',
    createdAt: daysAgo(40),
    resolved: false,
    resolvedAt: null,
    lastNotifiedAt: daysAgo(1),
    comments: [],
  },
  {
    id: 7,
    orderId: 'SO-10530',
    purchaserName: 'Kari Nordmann',
    purchaserEmail: 'kari.nordmann@example.com',
    discrepancyType: 'Spesielle caser - Finance',
    createdAt: daysAgo(12),
    resolved: false,
    resolvedAt: null,
    lastNotifiedAt: null,
    comments: [],
  },
  {
    id: 8,
    orderId: 'SO-10560',
    purchaserName: 'Ola Hansen',
    purchaserEmail: 'ola.hansen@example.com',
    discrepancyType: 'Varefaktura — under behandling',
    createdAt: daysAgo(9),
    resolved: false,
    resolvedAt: null,
    lastNotifiedAt: daysAgo(6),
    comments: [],
  },
];

module.exports = { SEED_AVVIK, daysAgo };
