'use strict';

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(9, 0, 0, 0);
  return d.toISOString();
}

// Test data only. No real orders, purchasers, or email addresses.
const SEED_AVVIK = [
  {
    id: 1,
    orderId: 'SO-10245',
    purchaserName: 'Kari Nordmann',
    purchaserEmail: 'kari.nordmann@example.com',
    discrepancyType: 'Feil antall levert',
    createdAt: daysAgo(20),
    resolved: false,
    resolvedAt: null,
    lastNotifiedAt: daysAgo(9),
  },
  {
    id: 2,
    orderId: 'SO-10312',
    purchaserName: 'Ola Hansen',
    purchaserEmail: 'ola.hansen@example.com',
    discrepancyType: 'Feil pris fakturert',
    createdAt: daysAgo(15),
    resolved: false,
    resolvedAt: null,
    lastNotifiedAt: daysAgo(3),
  },
  {
    id: 3,
    orderId: 'SO-10399',
    purchaserName: 'Per Iversen',
    purchaserEmail: 'per.iversen@example.com',
    discrepancyType: 'Mangler kvittering',
    createdAt: daysAgo(5),
    resolved: false,
    resolvedAt: null,
    lastNotifiedAt: null,
  },
  {
    id: 4,
    orderId: 'SO-10410',
    purchaserName: 'Silje Berg',
    purchaserEmail: 'silje.berg@example.com',
    discrepancyType: 'Feil varenummer',
    createdAt: daysAgo(30),
    resolved: true,
    resolvedAt: daysAgo(2),
    lastNotifiedAt: daysAgo(10),
  },
  {
    id: 5,
    orderId: 'SO-10455',
    purchaserName: 'Mona Lund',
    purchaserEmail: 'mona.lund@example.com',
    discrepancyType: 'Feil leveringsadresse',
    createdAt: daysAgo(2),
    resolved: false,
    resolvedAt: null,
    lastNotifiedAt: null,
  },
  {
    id: 6,
    orderId: 'SO-10501',
    purchaserName: 'Thomas Vik',
    purchaserEmail: 'thomas.vik@example.com',
    discrepancyType: 'Dobbel fakturering',
    createdAt: daysAgo(40),
    resolved: false,
    resolvedAt: null,
    lastNotifiedAt: daysAgo(1),
  },
];

module.exports = { SEED_AVVIK, daysAgo };
