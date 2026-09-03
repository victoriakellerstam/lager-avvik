'use strict';

const sql = require('mssql');
const { getConfig } = require('./dwh');

// Both cutoffs are parameterized from the same hardcoded dates in the
// ground-truth query below ('20260101' in two places) - do not change either
// without checking with the user first.
const MAIN_TABLE_CUTOFF_DATE = '2026-01-01';
const TICKETS_CUTOFF_DATE = '2026-01-01';

async function withPool(run) {
  // A dedicated ConnectionPool instance, not the module-level sql.connect()/
  // sql.close() global singleton - this function is called many times per
  // refresh, and repeatedly opening/closing the shared global pool is exactly
  // the anti-pattern node-mssql's own docs warn against. The pool is also an
  // EventEmitter: without an 'error' listener, an async connection error (e.g.
  // a network hiccup on the Link) throws unhandled and crashes the whole
  // process, not just this one request.
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

// The single ground-truth query (supplied directly by the user) that does
// everything the old dwhQueries.js/scenario.js/purchaser.js/avvikSync.js
// pipeline was reimplementing in JS: PO-nummer derivation, the >21-days-
// waiting filter (computed from order_date directly, not stock_history),
// manual-vs-PO-order detection (employee_number > 11), software detection
// (main_group_number = 6), internal-order detection (project_number IN
// (11246, 14000)), Medius cost/goods invoice matching (direct, via PO+article,
// and via the connection bridge), a 7-tier ticket-ranking for sakseier
// resolution, and the final deviation_scenario classification - all in one
// query against dwh. See scenario.js's mapDeviationScenario for how its
// output maps onto this app's discrepancyTypes.js constants.
//
// Only the columns avvikSync.js actually consumes are projected in the final
// SELECT; every join/CTE above it is preserved exactly as given.
async function fetchAvvikRows() {
  return withPool(async (pool) => {
    const result = await pool
      .request()
      .input('mainCutoff', sql.Date, MAIN_TABLE_CUTOFF_DATE)
      .input('ticketsCutoff', sql.Date, TICKETS_CUTOFF_DATE)
      .query(`
        WITH EarliestReceiptByOrderArticle AS
        (
            /* "Mottak" = en lagerbevegelse med positiv quantity, for samme
            bestillingsnummer (order_number) og artikkelnummer (article_number)
            som ordrelinjen. Dager siden mottak regnes fra den TIDLIGSTE slike
            bevegelsen (samme logikk som den opprinnelige "Dager ventende"-
            målingen: MIN(dato) WHERE Antall > 0). En ordrelinje uten noen
            match her er ikke mottatt ennå, og skal dermed ikke telles/vises. */
            SELECT
                sh.order_number COLLATE Danish_Norwegian_CI_AS AS order_number,
                sh.article_number COLLATE Danish_Norwegian_CI_AS AS article_number,
                MIN(sh.date_of_movement) AS earliest_receipt_at
            FROM [dwh].[workplace].[stock_history] AS sh
            WHERE sh.quantity > 0
            GROUP BY
                sh.order_number COLLATE Danish_Norwegian_CI_AS,
                sh.article_number COLLATE Danish_Norwegian_CI_AS
        ),

        SupplierOrderLines AS
        (
            SELECT
                sol.*,

                /* PO-nummer = delen før første bindestrek */
                NULLIF(
                    LTRIM(RTRIM(
                        CASE
                            WHEN CHARINDEX('-', sol.reference_id) > 0
                                THEN LEFT(
                                    sol.reference_id,
                                    CHARINDEX('-', sol.reference_id) - 1
                                )
                            ELSE sol.reference_id
                        END
                    )),
                    ''
                ) COLLATE Danish_Norwegian_CI_AS AS po_number,

                CONVERT(varchar(50), sol.supplier_number)
                    COLLATE Danish_Norwegian_CI_AS AS supplier_id_text,

                DATEDIFF(
                    DAY,
                    CAST(er.earliest_receipt_at AS date),
                    CAST(GETDATE() AS date)
                ) AS days_waiting

            FROM [dwh].[finance].[supplier_order_line] AS sol

            INNER JOIN EarliestReceiptByOrderArticle AS er
                ON er.order_number
                 = sol.supplier_order_number COLLATE Danish_Norwegian_CI_AS
               AND er.article_number
                 = sol.article_number COLLATE Danish_Norwegian_CI_AS

            WHERE sol.order_status = 3030
              AND sol.order_date >= @mainCutoff
              AND DATEDIFF(
                      DAY,
                      CAST(er.earliest_receipt_at AS date),
                      CAST(GETDATE() AS date)
                  ) > 21
        ),

        /*
        For manuelle ordre brukes our_ref når:
        - employee_number > 11
        - our_ref ikke er tom
        - our_ref ikke er Intility Webshop
        */
        SupplierOrders AS
        (
            SELECT
                so.supplier_order_number
                    COLLATE Danish_Norwegian_CI_AS AS supplier_order_number,

                MAX(
                    CASE
                        WHEN NULLIF(LTRIM(RTRIM(so.our_ref)), '') IS NOT NULL
                         AND LTRIM(RTRIM(so.our_ref))
                                COLLATE Danish_Norwegian_CI_AS
                             <> 'Intility Webshop'
                                COLLATE Danish_Norwegian_CI_AS
                            THEN LTRIM(RTRIM(so.our_ref))
                                 COLLATE Danish_Norwegian_CI_AS
                    END
                ) AS manual_order_owner

            FROM [dwh].[finance].[supplier_order] AS so

            GROUP BY
                so.supplier_order_number
                    COLLATE Danish_Norwegian_CI_AS
        ),

        /*
        Medius-fakturaer som matcher på:
        - PO-nummer
        - leverandørnummer
        - artikkelnummer
        */
        MediusArticleMatches AS
        (
            SELECT
                ih.visma_purchase_order
                    COLLATE Danish_Norwegian_CI_AS AS po_number,

                ih.supplier_id
                    COLLATE Danish_Norwegian_CI_AS AS supplier_id,

                il.article_code
                    COLLATE Danish_Norwegian_CI_AS AS article_code,

                COUNT_BIG(*) AS matching_invoice_line_count,

                MAX(
                    CASE
                        WHEN ih.invoice_type = 'Non-PO invoice'
                            THEN 1
                        ELSE 0
                    END
                ) AS is_cost_invoice_via_po,

                MAX(
                    CASE
                        WHEN ih.processing_status = 'Archived'
                         AND ih.invoice_type = 'Non-PO invoice'
                            THEN 1
                        ELSE 0
                    END
                ) AS is_cost_archived_via_po,

                MAX(
                    CASE
                        WHEN ih.processing_status = 'Archived'
                         AND
                         (
                             ih.invoice_type <> 'Non-PO invoice'
                             OR ih.invoice_type IS NULL
                         )
                            THEN 1
                        ELSE 0
                    END
                ) AS is_goods_archived_via_po,

                MAX(
                    CASE
                        WHEN ih.processing_status = 'Invalidated'
                         AND
                         (
                             ih.invoice_type <> 'Non-PO invoice'
                             OR ih.invoice_type IS NULL
                         )
                            THEN 1
                        ELSE 0
                    END
                ) AS is_goods_invalidated_via_po,

                MAX(
                    CASE
                        WHEN ih.processing_status = 'Open'
                         AND
                         (
                             ih.invoice_type <> 'Non-PO invoice'
                             OR ih.invoice_type IS NULL
                         )
                            THEN 1
                        ELSE 0
                    END
                ) AS is_goods_open_via_po

            FROM [dwh].[finance].[medius_invoice_head] AS ih

            INNER JOIN [dwh].[finance].[medius_invoice_lines] AS il
                ON il.document_id COLLATE Danish_Norwegian_CI_AS
                 = ih.document_id COLLATE Danish_Norwegian_CI_AS

            WHERE ih.visma_purchase_order IS NOT NULL

            GROUP BY
                ih.visma_purchase_order COLLATE Danish_Norwegian_CI_AS,
                ih.supplier_id COLLATE Danish_Norwegian_CI_AS,
                il.article_code COLLATE Danish_Norwegian_CI_AS
        ),

        /* Kostnadsfaktura direkte på PO-nummer */
        MediusDirectCostInvoices AS
        (
            SELECT
                ih.visma_purchase_order
                    COLLATE Danish_Norwegian_CI_AS AS po_number,

                ih.supplier_id
                    COLLATE Danish_Norwegian_CI_AS AS supplier_id,

                MAX(
                    CASE
                        WHEN ih.invoice_type = 'Non-PO invoice'
                         AND ih.processing_status = 'Archived'
                            THEN 1
                        ELSE 0
                    END
                ) AS is_cost_archived_directly,

                MAX(
                    CASE
                        WHEN ih.invoice_type = 'Non-PO invoice'
                         AND ih.processing_status = 'Open'
                            THEN 1
                        ELSE 0
                    END
                ) AS is_cost_open_directly

            FROM [dwh].[finance].[medius_invoice_head] AS ih
            WHERE ih.visma_purchase_order IS NOT NULL

            GROUP BY
                ih.visma_purchase_order COLLATE Danish_Norwegian_CI_AS,
                ih.supplier_id COLLATE Danish_Norwegian_CI_AS
        ),

        /* Medius-koblinger via bestillingsnummer */
        MediusConnectionMatches AS
        (
            SELECT
                moc.visma_purchase_order
                    COLLATE Danish_Norwegian_CI_AS AS po_number,

                ih.supplier_id
                    COLLATE Danish_Norwegian_CI_AS AS supplier_id,

                COUNT_BIG(*) AS connection_count,

                MAX(
                    CASE
                        WHEN ih.invoice_type = 'Non-PO invoice'
                         AND ih.processing_status = 'Archived'
                            THEN 1
                        ELSE 0
                    END
                ) AS is_cost_archived_via_order_number,

                MAX(
                    CASE
                        WHEN ih.invoice_type = 'Non-PO invoice'
                         AND ih.processing_status = 'Open'
                            THEN 1
                        ELSE 0
                    END
                ) AS is_cost_open_via_order_number

            FROM [dwh].[finance].[medius_order_connections] AS moc

            INNER JOIN [dwh].[finance].[medius_invoice_head] AS ih
                ON ih.document_id COLLATE Danish_Norwegian_CI_AS
                 = moc.document_id COLLATE Danish_Norwegian_CI_AS

            WHERE moc.visma_purchase_order IS NOT NULL

            GROUP BY
                moc.visma_purchase_order COLLATE Danish_Norwegian_CI_AS,
                ih.supplier_id COLLATE Danish_Norwegian_CI_AS
        ),

        /* Avgrenser ticketstabellen tidlig */
        TicketSource AS
        (
            SELECT
                t.ticket_id,
                t.reference_number,
                t.ticket_title,
                t.ticket_status,
                t.ticket_status_english,
                t.category_name,
                t.category_top_level,
                t.classification_name,
                t.intility_worker_fullname,
                t.intility_worker_username,
                t.intility_worker_title,
                t.created_at,
                t.closed_at,
                t.last_changed_at,
                t.ticket_url,
                t.ticket_portal_url

            FROM [dwh].[customer_inquiries].[tickets] AS t

            WHERE t.last_changed_at >= @ticketsCutoff
        ),

        /*
        Finner seks-sifret PO-nummer etter # i ticket_title.
        */
        TicketTokens AS
        (
            SELECT
                ts.ticket_id,
                ts.reference_number,
                ts.ticket_title,
                ts.ticket_status,
                ts.ticket_status_english,
                ts.category_name,
                ts.category_top_level,
                ts.classification_name,
                ts.intility_worker_fullname,
                ts.intility_worker_username,
                ts.intility_worker_title,
                ts.created_at,
                ts.closed_at,
                ts.last_changed_at,
                ts.ticket_url,
                ts.ticket_portal_url,

                LTRIM(RTRIM(s.value)) AS title_part,

                LEFT(LTRIM(RTRIM(s.value)), 6)
                    COLLATE Danish_Norwegian_CI_AS AS po_number

            FROM TicketSource AS ts

            CROSS APPLY STRING_SPLIT(ts.ticket_title, '#') AS s

            WHERE CHARINDEX('#', ts.ticket_title) > 0
              AND LEN(LEFT(LTRIM(RTRIM(s.value)), 6)) = 6
              AND LEFT(LTRIM(RTRIM(s.value)), 2)
                  IN ('14', '15', '16', '17')
              AND LEFT(LTRIM(RTRIM(s.value)), 6)
                  NOT LIKE '%[^0-9]%'
              AND LOWER(LEFT(LTRIM(RTRIM(s.value)), 20))
                  NOT LIKE '%cancl%'
        ),

        /*
        Prioritering av sakseier per PO:

        1. Egenbestillinger med utfylt sakseier
        2. Tittel inneholder Egenbestilling, med utfylt sakseier, uten PLUKK
        3. Innkjøp med utfylt sakseier, uten PLUKK
        4. Annen gyldig ticket med utfylt sakseier, uten PLUKK
        5. Annen ticket med utfylt sakseier, uten PLUKK
        6. Ticket uten sakseier, uten PLUKK
        7. PLUKK-ticket

        Innenfor samme gruppe:
        - tittel som ikke starter med [ prioriteres
        - deretter nyeste ticket
        */
        RankedTickets AS
        (
            SELECT
                tt.*,

                CASE
                    WHEN NULLIF(
                             LTRIM(RTRIM(tt.intility_worker_fullname)),
                             ''
                         ) IS NOT NULL
                     AND tt.category_name COLLATE Danish_Norwegian_CI_AS
                         = 'Egenbestillinger' COLLATE Danish_Norwegian_CI_AS
                        THEN 1

                    WHEN NULLIF(
                             LTRIM(RTRIM(tt.intility_worker_fullname)),
                             ''
                         ) IS NOT NULL
                     AND tt.ticket_title COLLATE Danish_Norwegian_CI_AS
                         LIKE '%Egenbestilling%' COLLATE Danish_Norwegian_CI_AS
                     AND tt.ticket_title COLLATE Danish_Norwegian_CI_AS
                         NOT LIKE '%PLUKK%' COLLATE Danish_Norwegian_CI_AS
                        THEN 2

                    WHEN NULLIF(
                             LTRIM(RTRIM(tt.intility_worker_fullname)),
                             ''
                         ) IS NOT NULL
                     AND tt.category_name COLLATE Danish_Norwegian_CI_AS
                         = 'Innkjøp' COLLATE Danish_Norwegian_CI_AS
                     AND
                     (
                         tt.ticket_title IS NULL
                         OR tt.ticket_title COLLATE Danish_Norwegian_CI_AS
                            NOT LIKE '%PLUKK%' COLLATE Danish_Norwegian_CI_AS
                     )
                        THEN 3

                    WHEN NULLIF(
                             LTRIM(RTRIM(tt.intility_worker_fullname)),
                             ''
                         ) IS NOT NULL
                     AND
                     (
                         tt.ticket_title IS NULL
                         OR tt.ticket_title COLLATE Danish_Norwegian_CI_AS
                            NOT LIKE '%PLUKK%' COLLATE Danish_Norwegian_CI_AS
                     )
                     AND
                     (
                         tt.category_top_level IS NULL
                         OR tt.category_top_level COLLATE Danish_Norwegian_CI_AS
                            <> 'Logistics' COLLATE Danish_Norwegian_CI_AS
                     )
                     AND
                     (
                         tt.category_top_level IS NULL
                         OR tt.category_top_level COLLATE Danish_Norwegian_CI_AS
                            <> 'Setup' COLLATE Danish_Norwegian_CI_AS
                         OR NULLIF(
                                LTRIM(RTRIM(tt.classification_name)),
                                ''
                            ) IS NOT NULL
                     )
                     AND
                     (
                         tt.intility_worker_title IS NULL
                         OR tt.intility_worker_title COLLATE Danish_Norwegian_CI_AS
                            NOT LIKE '%Warehouse%' COLLATE Danish_Norwegian_CI_AS
                     )
                        THEN 4

                    WHEN NULLIF(
                             LTRIM(RTRIM(tt.intility_worker_fullname)),
                             ''
                         ) IS NOT NULL
                     AND
                     (
                         tt.ticket_title IS NULL
                         OR tt.ticket_title COLLATE Danish_Norwegian_CI_AS
                            NOT LIKE '%PLUKK%' COLLATE Danish_Norwegian_CI_AS
                     )
                        THEN 5

                    WHEN
                    (
                        tt.ticket_title IS NULL
                        OR tt.ticket_title COLLATE Danish_Norwegian_CI_AS
                           NOT LIKE '%PLUKK%' COLLATE Danish_Norwegian_CI_AS
                    )
                        THEN 6

                    ELSE 7
                END AS owner_priority,

                CASE
                    WHEN NULLIF(LTRIM(RTRIM(tt.ticket_title)), '') IS NULL
                        THEN 2

                    WHEN LEFT(LTRIM(tt.ticket_title), 1)
                            COLLATE Danish_Norwegian_CI_AS
                         = '[' COLLATE Danish_Norwegian_CI_AS
                        THEN 1

                    ELSE 0
                END AS title_priority,

                ROW_NUMBER() OVER
                (
                    PARTITION BY tt.po_number

                    ORDER BY
                        CASE
                            WHEN NULLIF(
                                     LTRIM(RTRIM(tt.intility_worker_fullname)),
                                     ''
                                 ) IS NOT NULL
                             AND tt.category_name COLLATE Danish_Norwegian_CI_AS
                                 = 'Egenbestillinger'
                                   COLLATE Danish_Norwegian_CI_AS
                                THEN 1

                            WHEN NULLIF(
                                     LTRIM(RTRIM(tt.intility_worker_fullname)),
                                     ''
                                 ) IS NOT NULL
                             AND tt.ticket_title COLLATE Danish_Norwegian_CI_AS
                                 LIKE '%Egenbestilling%'
                                      COLLATE Danish_Norwegian_CI_AS
                             AND tt.ticket_title COLLATE Danish_Norwegian_CI_AS
                                 NOT LIKE '%PLUKK%'
                                          COLLATE Danish_Norwegian_CI_AS
                                THEN 2

                            WHEN NULLIF(
                                     LTRIM(RTRIM(tt.intility_worker_fullname)),
                                     ''
                                 ) IS NOT NULL
                             AND tt.category_name COLLATE Danish_Norwegian_CI_AS
                                 = 'Innkjøp' COLLATE Danish_Norwegian_CI_AS
                             AND
                             (
                                 tt.ticket_title IS NULL
                                 OR tt.ticket_title
                                        COLLATE Danish_Norwegian_CI_AS
                                    NOT LIKE '%PLUKK%'
                                        COLLATE Danish_Norwegian_CI_AS
                             )
                                THEN 3

                            WHEN NULLIF(
                                     LTRIM(RTRIM(tt.intility_worker_fullname)),
                                     ''
                                 ) IS NOT NULL
                             AND
                             (
                                 tt.ticket_title IS NULL
                                 OR tt.ticket_title
                                        COLLATE Danish_Norwegian_CI_AS
                                    NOT LIKE '%PLUKK%'
                                        COLLATE Danish_Norwegian_CI_AS
                             )
                             AND
                             (
                                 tt.category_top_level IS NULL
                                 OR tt.category_top_level
                                        COLLATE Danish_Norwegian_CI_AS
                                    <> 'Logistics'
                                        COLLATE Danish_Norwegian_CI_AS
                             )
                             AND
                             (
                                 tt.category_top_level IS NULL
                                 OR tt.category_top_level
                                        COLLATE Danish_Norwegian_CI_AS
                                    <> 'Setup'
                                        COLLATE Danish_Norwegian_CI_AS
                                 OR NULLIF(
                                        LTRIM(RTRIM(tt.classification_name)),
                                        ''
                                    ) IS NOT NULL
                             )
                             AND
                             (
                                 tt.intility_worker_title IS NULL
                                 OR tt.intility_worker_title
                                        COLLATE Danish_Norwegian_CI_AS
                                    NOT LIKE '%Warehouse%'
                                        COLLATE Danish_Norwegian_CI_AS
                             )
                                THEN 4

                            WHEN NULLIF(
                                     LTRIM(RTRIM(tt.intility_worker_fullname)),
                                     ''
                                 ) IS NOT NULL
                             AND
                             (
                                 tt.ticket_title IS NULL
                                 OR tt.ticket_title
                                        COLLATE Danish_Norwegian_CI_AS
                                    NOT LIKE '%PLUKK%'
                                        COLLATE Danish_Norwegian_CI_AS
                             )
                                THEN 5

                            WHEN
                            (
                                tt.ticket_title IS NULL
                                OR tt.ticket_title
                                       COLLATE Danish_Norwegian_CI_AS
                                   NOT LIKE '%PLUKK%'
                                       COLLATE Danish_Norwegian_CI_AS
                            )
                                THEN 6

                            ELSE 7
                        END,

                        CASE
                            WHEN NULLIF(
                                     LTRIM(RTRIM(tt.ticket_title)),
                                     ''
                                 ) IS NULL
                                THEN 2

                            WHEN LEFT(LTRIM(tt.ticket_title), 1)
                                     COLLATE Danish_Norwegian_CI_AS
                                 = '[' COLLATE Danish_Norwegian_CI_AS
                                THEN 1

                            ELSE 0
                        END,

                        tt.last_changed_at DESC,
                        tt.ticket_id DESC
                ) AS ticket_rank,

                COUNT(*) OVER
                (
                    PARTITION BY tt.po_number
                ) AS ticket_count

            FROM TicketTokens AS tt
        ),

        /* Beholder én prioritert ticket per PO-nummer */
        PreferredTicket AS
        (
            SELECT
                rt.po_number,
                rt.ticket_count,
                rt.owner_priority,
                rt.title_priority,
                rt.ticket_id,
                rt.reference_number,
                rt.ticket_title,
                rt.ticket_status,
                rt.ticket_status_english,
                rt.category_name,
                rt.category_top_level,
                rt.classification_name,
                rt.intility_worker_fullname,
                rt.intility_worker_username,
                rt.intility_worker_title,
                rt.created_at,
                rt.closed_at,
                rt.last_changed_at,
                rt.ticket_url,
                rt.ticket_portal_url

            FROM RankedTickets AS rt
            WHERE rt.ticket_rank = 1
        ),

        Combined AS
        (
            SELECT
                sol.supplier_order_number,
                sol.article_number,
                sol.lot_number,
                sol.order_date,
                sol.days_waiting,
                sol.department_number,

                /*
                Sakseier:
                1. Manuell ordre: our_ref
                2. Ikke-manuell ordre: prioritert ticket
                */
                CASE
                    WHEN sol.employee_number > 11
                     AND so.manual_order_owner IS NOT NULL
                        THEN so.manual_order_owner

                    WHEN sol.employee_number <= 11
                     AND NULLIF(
                             LTRIM(RTRIM(pt.intility_worker_fullname)),
                             ''
                         ) IS NOT NULL
                        THEN LTRIM(RTRIM(pt.intility_worker_fullname))
                             COLLATE Danish_Norwegian_CI_AS

                    WHEN sol.employee_number > 11
                        THEN 'Manuell ordre – sakseier mangler'

                    ELSE 'Sakseier ikke funnet'
                END COLLATE Danish_Norwegian_CI_AS AS case_owner,

                /*
                Internbestilling får alltid fast scenario. Kun 14000 - 11246
                er en annen, urelatert "Internbestilling status"-kolonne i
                kildemodellen, ikke en del av selve klassifiseringen (bekreftet
                via konkrete ordre-eksempler som ellers feilklassifiseres).
                */
                CASE
                    WHEN sol.project_number = 14000
                        THEN 'Internbestilling'

                    WHEN sol.employee_number > 11
                        THEN 'Manuell ordre'

                    WHEN sol.supplier_number = 60067
                     AND sol.main_group_number = 6
                        THEN 'Kredittkort lisenskjøp, feilaktig mottak'

                    WHEN sol.supplier_number = 60067
                     AND ISNULL(sol.main_group_number, -1) <> 6
                        THEN 'Ordre opprettet med feilaktig distributør'

                    WHEN COALESCE(mam.matching_invoice_line_count, 0) = 0
                     AND COALESCE(mcm.connection_count, 0) = 0
                     AND COALESCE(mdci.is_cost_archived_directly, 0) = 0
                     AND COALESCE(mdci.is_cost_open_directly, 0) = 0
                        THEN 'Ikke mottatt faktura i Medius'

                    WHEN COALESCE(mam.matching_invoice_line_count, 0) = 0
                     AND COALESCE(
                             mcm.is_cost_archived_via_order_number,
                             0
                         ) = 1
                        THEN 'Kostnadsfaktura via bestnr — reverser'

                    WHEN COALESCE(mam.matching_invoice_line_count, 0) = 0
                     AND COALESCE(
                             mcm.is_cost_open_via_order_number,
                             0
                         ) = 1
                        THEN 'Kostnadsfaktura via bestnr — følg opp'

                    WHEN COALESCE(mam.matching_invoice_line_count, 0) = 0
                     AND COALESCE(mdci.is_cost_archived_directly, 0) = 1
                        THEN 'Kostnadsfaktura — reverser'

                    WHEN COALESCE(mam.matching_invoice_line_count, 0) = 0
                     AND COALESCE(mdci.is_cost_open_directly, 0) = 1
                        THEN 'Kostnadsfaktura — under behandling'

                    WHEN COALESCE(mam.is_cost_invoice_via_po, 0) = 1
                     AND COALESCE(mam.is_cost_archived_via_po, 0) = 1
                        THEN 'Kostnadsfaktura — reverser'

                    WHEN COALESCE(mam.is_cost_invoice_via_po, 0) = 1
                     AND COALESCE(mam.is_goods_open_via_po, 0) = 1
                        THEN 'Kostnadsfaktura — under behandling'

                    WHEN COALESCE(mam.is_cost_invoice_via_po, 0) = 0
                     AND COALESCE(mam.is_goods_invalidated_via_po, 0) = 1
                     AND COALESCE(mam.is_goods_open_via_po, 0) = 0
                        THEN 'Varefaktura — OK, makulert'

                    WHEN COALESCE(mam.is_cost_invoice_via_po, 0) = 0
                     AND COALESCE(mam.is_goods_open_via_po, 0) = 1
                        THEN 'Varefaktura — under behandling'

                    WHEN COALESCE(mam.is_cost_invoice_via_po, 0) = 0
                     AND COALESCE(mam.is_goods_archived_via_po, 0) = 1
                        THEN 'Spesielle caser - Finance'

                    ELSE 'Varefaktura — OK'
                END COLLATE Danish_Norwegian_CI_AS AS deviation_scenario

            FROM SupplierOrderLines AS sol

            LEFT JOIN SupplierOrders AS so
                ON so.supplier_order_number COLLATE Danish_Norwegian_CI_AS
                 = sol.supplier_order_number COLLATE Danish_Norwegian_CI_AS

            LEFT JOIN MediusArticleMatches AS mam
                ON mam.po_number COLLATE Danish_Norwegian_CI_AS
                 = sol.po_number COLLATE Danish_Norwegian_CI_AS
               AND mam.supplier_id COLLATE Danish_Norwegian_CI_AS
                 = sol.supplier_id_text COLLATE Danish_Norwegian_CI_AS
               AND mam.article_code COLLATE Danish_Norwegian_CI_AS
                 = sol.article_number COLLATE Danish_Norwegian_CI_AS

            LEFT JOIN MediusDirectCostInvoices AS mdci
                ON mdci.po_number COLLATE Danish_Norwegian_CI_AS
                 = sol.po_number COLLATE Danish_Norwegian_CI_AS
               AND mdci.supplier_id COLLATE Danish_Norwegian_CI_AS
                 = sol.supplier_id_text COLLATE Danish_Norwegian_CI_AS

            LEFT JOIN MediusConnectionMatches AS mcm
                ON mcm.po_number COLLATE Danish_Norwegian_CI_AS
                 = sol.po_number COLLATE Danish_Norwegian_CI_AS
               AND mcm.supplier_id COLLATE Danish_Norwegian_CI_AS
                 = sol.supplier_id_text COLLATE Danish_Norwegian_CI_AS

            LEFT JOIN PreferredTicket AS pt
                ON pt.po_number COLLATE Danish_Norwegian_CI_AS
                 = sol.po_number COLLATE Danish_Norwegian_CI_AS
        )

        SELECT
            supplier_order_number,
            article_number,
            lot_number,
            order_date,
            days_waiting,
            department_number,
            case_owner,
            deviation_scenario
        FROM Combined
        ORDER BY
            days_waiting DESC,
            supplier_order_number,
            article_number;
      `);
    return result.recordset;
  });
}

// Employee directory, used to look up an email address for a resolved
// purchaser full name (case_owner from fetchAvvikRows).
async function fetchIntilityUsers() {
  return withPool(async (pool) => {
    const result = await pool.request().query(`
      SELECT user_full_name, email
      FROM [dwh].[dbo].[intility_users]
    `);
    return result.recordset;
  });
}

// Department directory, used to look up a readable name for
// fetchAvvikRows's department_number.
async function fetchDepartments() {
  return withPool(async (pool) => {
    const result = await pool.request().query(`
      SELECT department_number, department_name
      FROM [dwh].[dbo].[departments]
    `);
    return result.recordset;
  });
}

module.exports = { fetchAvvikRows, fetchIntilityUsers, fetchDepartments };
