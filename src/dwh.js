'use strict';

const sql = require('mssql');

// Connectivity check only - this does not read or expose any real avvik
// data yet. The address comes from the Minato Link's injected env var, never
// hardcoded, since the local port/host are only stable for as long as the
// link stays attached this way.
function getConfig() {
  const addr = process.env.MINATO_LINK_DWH_ADDR;
  if (!addr) {
    throw new Error('MINATO_LINK_DWH_ADDR is not set - is the "dwh" link attached and Ready?');
  }
  const [server, portStr] = addr.split(':');
  const port = Number(portStr);
  if (!server || !port) {
    throw new Error(`MINATO_LINK_DWH_ADDR has an unexpected shape: "${addr}"`);
  }

  return {
    server,
    port,
    user: process.env.DWH_USER,
    password: process.env.LAGER_AVVIK,
    database: process.env.DWH_DATABASE,
    options: {
      // The link is a private, authenticated tunnel into the tenant's own
      // network, not a public endpoint, so a self-signed/internal cert on
      // the SQL Server itself is expected here.
      encrypt: true,
      trustServerCertificate: true,
    },
    connectionTimeout: 5000,
    requestTimeout: 5000,
  };
}

async function testConnection() {
  const pool = await sql.connect(getConfig());
  try {
    const result = await pool.request().query('SELECT 1 AS ok');
    return { ok: true, recordset: result.recordset };
  } finally {
    await pool.close();
  }
}

module.exports = { testConnection, getConfig };
