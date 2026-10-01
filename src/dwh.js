'use strict';

// Two ways to reach dwh, chosen by which env var is present - there's no
// Windows identity to use once this runs on Minato, so that path (the only
// one that existed before) always sets MINATO_LINK_DWH_ADDR; a developer
// running the app directly on their own Windows host never has that link
// attached, so the absence of the var is what selects the local path, not
// NODE_ENV or any other flag.
const usingMinatoLink = Boolean(process.env.MINATO_LINK_DWH_ADDR);

// mssql/msnodesqlv8 is an optional dependency (native, Windows-only - see
// package.json) that isn't installed in environments that only ever use the
// Minato Link path (e.g. the Linux build on Minato itself, or `npm test`
// anywhere). Requiring it must therefore be deferred until a connection is
// actually opened (getSql() below), not done at module load - this file is
// required unconditionally by dwhQueries.js, which every test importing
// avvikSync.js pulls in transitively.
let cachedSql;
function getSql() {
  if (!cachedSql) {
    cachedSql = usingMinatoLink ? require('mssql') : require('mssql/msnodesqlv8');
  }
  return cachedSql;
}

const LOCAL_DWH_SERVER = process.env.DWH_LOCAL_SERVER || 'g-datascience-3.gamma.xcv.net';
const LOCAL_DWH_PORT = Number(process.env.DWH_LOCAL_PORT || 1433);
const LOCAL_DWH_DATABASE = process.env.DWH_LOCAL_DATABASE || 'dwh';

// The address comes from the Minato Link's injected env var, never
// hardcoded, since the local port/host are only stable for as long as the
// link stays attached this way.
function getConfig() {
  if (usingMinatoLink) {
    const addr = process.env.MINATO_LINK_DWH_ADDR;
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
      connectionTimeout: 10000,
      // 5s was fine for testConnection's trivial SELECT 1, but dwhQueries.js's
      // real fetches (the main order-line union, a year-plus of medius_invoice_head,
      // etc.) run against production data and legitimately take longer.
      requestTimeout: 60000,
    };
  }

  // Local dev: connect straight to the DWH SQL Server (no Minato Link,
  // no tunnel) using the developer's own Windows identity - no DWH_USER or
  // password read or needed here. Only works when this process itself runs
  // on the developer's Windows host: a container doesn't inherit it.
  return {
    server: LOCAL_DWH_SERVER,
    port: LOCAL_DWH_PORT,
    database: LOCAL_DWH_DATABASE,
    driver: process.env.DWH_LOCAL_ODBC_DRIVER || 'ODBC Driver 18 for SQL Server',
    options: {
      trustedConnection: true,
      readOnlyIntent: true,
      encrypt: true,
      trustServerCertificate: true,
    },
    // mssql/msnodesqlv8 drops trustServerCertificate and readOnlyIntent when it
    // builds the ODBC connection string, ODBC Driver 18 rejects the DWH's
    // certificate without the former, and it writes Encrypt=true where the
    // driver only accepts Yes/No - so the string is fixed up here.
    beforeConnect: (cfg) => {
      const base = cfg.conn_str.replace(/Encrypt=true/i, 'Encrypt=Yes').replace(/;?$/, ';');
      cfg.conn_str = `${base}TrustServerCertificate=Yes;ApplicationIntent=ReadOnly;`;
    },
    connectionTimeout: 10000,
    requestTimeout: 60000,
  };
}

async function testConnection() {
  const sql = getSql();
  // A dedicated pool, not the sql.connect()/sql.close() global singleton -
  // see dwhQueries.js's withPool for why. Also needs its own 'error' listener
  // so an async connection error can't crash the whole process.
  const pool = new sql.ConnectionPool(getConfig());
  pool.on('error', (err) => {
    console.warn(`dwh connection pool error: ${err.message}`);
  });
  await pool.connect();
  try {
    const result = await pool.request().query('SELECT 1 AS ok');
    return { ok: true, recordset: result.recordset };
  } finally {
    await pool.close();
  }
}

module.exports = { testConnection, getConfig, getSql };
