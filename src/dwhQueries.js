'use strict';

const sql = require('mssql');
const { getConfig } = require('./dwh');

// Every date filter here matches a specific decision recorded in project
// memory lager_avvik_dwh_migration_handoff.md - do not change these without
// checking there first.
const MAIN_TABLE_CUTOFF_DATE = '2026-01-01';
const STOCK_HISTORY_CUTOFF_DATE = '2025-10-01';
const MEDIUS_INVOICE_HEAD_CUTOFF_DATE = '2025-01-01';
const TICKETS_CUTOFF_DATE = '2026-01-01';

async function withPool(run) {
  // A dedicated ConnectionPool instance, not the module-level sql.connect()/
  // sql.close() global singleton - this function is called many times per
  // refresh, and repeatedly opening/closing the shared global pool is exactly
  // the anti-pattern node-mssql's own docs warn against. The pool is also an
  // EventEmitter: without an 'error' listener, an async connection error (e.g.
  // a network hiccup on the Link) throws unhandled and crashes the whole
  // process, not just this one request - this is what a real refresh hit.
  const pool = new sql.ConnectionPool(getConfig());
  pool.on('error', (err) => {
    console.warn(`dwh connection pool error: ${err.message}`);
  });
  await pool.connect();
  try {
    return await run(pool);
  } finally {
    await pool.close();
  }
}

// Faithful port of the TMDL's three UNION ALL branches (see the migration
// handoff, section 10.1/10.2), migrated to the new dwh table/column names:
//   1. supplier_order_line, already-flagged lines (order_status 3015/3030).
//   2. supplier_order_line_copy, same status codes - its own order-number
//      column is called supplier_order_copy_number in the new schema, so it's
//      aliased here to line up with branch 1.
//   3. supplier_order_line again, but order_status = 3000 (not yet flagged),
//      restricted to orders that already have a flagged line elsewhere in
//      this result (this is exactly Spørring2/"mangler mottak": new lines on
//      an order that already has an avvik).
// The original historical query went back to 2020-01-01 for branch 1; per the
// migration handoff decision, every branch here uses the same 2026-01-01
// cutoff instead.
async function fetchOrderLines() {
  return withPool(async (pool) => {
    const result = await pool
      .request()
      .input('cutoff', sql.Date, MAIN_TABLE_CUTOFF_DATE)
      .query(`
        WITH flagged_lines AS (
          SELECT
            supplier_order_number, supplier_number, reference_id, order_date,
            delivery_at, project_number, reference_order_number,
            article_number, product_name, department_number, quantity,
            lot_number, amount, vat_percentage, stock_profile_number,
            main_group_number, intermediate_group_number, sub_group_number,
            order_status
          FROM [dwh].[finance].[supplier_order_line]
          WHERE order_status IN (3015, 3030) AND order_date >= @cutoff

          UNION ALL

          SELECT
            supplier_order_copy_number AS supplier_order_number,
            supplier_number, reference_id, order_date, delivery_at,
            project_number, reference_order_number, article_number,
            product_name, department_number, quantity, lot_number, amount,
            vat_percentage, stock_profile_number, main_group_number,
            intermediate_group_number, sub_group_number, order_status
          FROM [dwh].[finance].[supplier_order_line_copy]
          WHERE order_status IN (3015, 3030) AND order_date >= @cutoff
        )
        SELECT * FROM flagged_lines

        UNION ALL

        SELECT
          supplier_order_number, supplier_number, reference_id, order_date,
          delivery_at, project_number, reference_order_number,
          article_number, product_name, department_number, quantity,
          lot_number, amount, vat_percentage, stock_profile_number,
          main_group_number, intermediate_group_number, sub_group_number,
          order_status
        FROM [dwh].[finance].[supplier_order_line]
        WHERE order_status = 3000
          AND order_date >= @cutoff
          AND supplier_order_number IN (SELECT supplier_order_number FROM flagged_lines)
      `);
    return result.recordset;
  });
}

// "Medius faktura": only the columns scenario.js's invoiceHeadByPo /
// invoiceHeadByInvoiceNumber indexes actually read. Excludes processing_status
// = 'Invalidated' at the SQL level, same as the source TMDL query, so
// scenario.js's dead "Varefaktura — OK, makulert" branch really is
// unreachable in production.
async function fetchMediusInvoiceHead() {
  return withPool(async (pool) => {
    const result = await pool
      .request()
      .input('cutoff', sql.Date, MEDIUS_INVOICE_HEAD_CUTOFF_DATE)
      .query(`
        SELECT supplier_id, invoice_number, visma_purchase_order,
               invoice_type, processing_status
        FROM [dwh].[finance].[medius_invoice_head]
        WHERE invoiced_at >= @cutoff AND processing_status <> 'Invalidated'
      `);
    return result.recordset;
  });
}

// "Medius linje": excludes FreightCost lines and lines with no PO, and
// excludes lines whose head is Invalidated via the same NOT IN subquery the
// source TMDL query uses (this is the "push the exclusion into the SQL join"
// mentioned in the implementation plan).
async function fetchMediusInvoiceLines() {
  return withPool(async (pool) => {
    const result = await pool.request().query(`
      SELECT il.supplier_id, il.invoice_number, il.visma_purchase_order,
             il.article_code
      FROM [dwh].[finance].[medius_invoice_lines] il
      WHERE il.article_code <> 'FreightCost'
        AND il.visma_purchase_order IS NOT NULL
        AND il.invoice_number NOT IN (
          SELECT invoice_number FROM [dwh].[finance].[medius_invoice_head]
          WHERE processing_status = 'Invalidated'
        )
    `);
    return result.recordset;
  });
}

// "Medius connection": the invoice_number <-> visma_purchase_order bridge
// table. connection_type = 'Line detail' matches the source TMDL query.
async function fetchMediusOrderConnections() {
  return withPool(async (pool) => {
    const result = await pool.request().query(`
      SELECT visma_purchase_order, invoice_number
      FROM [dwh].[finance].[medius_order_connections]
      WHERE connection_type = 'Line detail'
    `);
    return result.recordset;
  });
}

// Stock History: filtered to positive-quantity movements (receipts) from
// 2025-10-01 onward. Column choice caveat: the old "Bil./fakt. dato" column
// (sh.Created) is mapped here to created_at by naming convention, but the new
// source also has date_of_movement, which may be semantically more correct
// for "days waiting" - this is a known open blocker (see the migration
// handoff), to be confirmed once real rows can be eyeballed.
async function fetchStockHistory() {
  return withPool(async (pool) => {
    const result = await pool
      .request()
      .input('cutoff', sql.Date, STOCK_HISTORY_CUTOFF_DATE)
      .query(`
        SELECT lot_number, created_at, quantity
        FROM [dwh].[workplace].[stock_history]
        WHERE created_at >= @cutoff AND quantity > 0
      `);
    return result.recordset;
  });
}

// "Sakseier ny"'s underlying source: only the columns purchaser.js's
// pickWinningSakseier/resolvePurchaser actually read. Matches the source
// TMDL query's WHERE clause exactly (including its slightly odd "fullname is
// NULL or non-blank" condition) rather than narrowing it further here.
async function fetchTickets() {
  return withPool(async (pool) => {
    const result = await pool
      .request()
      .input('cutoff', sql.Date, TICKETS_CUTOFF_DATE)
      .query(`
        SELECT ticket_title, category_name, category_top_level,
               classification_name, intility_worker_fullname,
               intility_worker_title
        FROM [dwh].[customer_inquiries].[tickets]
        WHERE last_changed_at > @cutoff
          AND (intility_worker_fullname IS NULL OR LTRIM(RTRIM(intility_worker_fullname)) <> '')
      `);
    return result.recordset;
  });
}

// "Vår ref": supplier_order_number is the join key back to the main table's
// Best.nr, our_ref is the payload purchaser.js normalizes and uses for
// manual (no-PO) orders.
async function fetchSupplierOrders() {
  return withPool(async (pool) => {
    const result = await pool.request().query(`
      SELECT supplier_order_number, our_ref
      FROM [dwh].[finance].[supplier_order]
    `);
    return result.recordset;
  });
}

// Employee directory, used to look up an email address for a resolved
// purchaser full name.
async function fetchIntilityUsers() {
  return withPool(async (pool) => {
    const result = await pool.request().query(`
      SELECT user_full_name, email
      FROM [dwh].[dbo].[intility_users]
    `);
    return result.recordset;
  });
}

module.exports = {
  fetchOrderLines,
  fetchMediusInvoiceHead,
  fetchMediusInvoiceLines,
  fetchMediusOrderConnections,
  fetchStockHistory,
  fetchTickets,
  fetchSupplierOrders,
  fetchIntilityUsers,
};
