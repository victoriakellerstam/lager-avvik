'use strict';

// "Forslag til faktura som må kobles til ordrelinjen": for an avvik whose
// order line has no (or an incomplete) invoice match yet, look for an
// unconnected medius_invoice_lines candidate that's likely the missing
// invoice - matched loosely by article+supplier, then graded strong/weak by
// whether its visma_purchase_order also agrees with the order line's own
// Visma order number (the first segment of supplier_order_line.reference_id,
// already extracted as po_number by dwhQueries.js's fetchAvvikRows). See
// avvikSync.js for how this is wired into the sync, and dashboard.js's
// renderInvoiceSuggestions for how it's displayed.

function normalizeKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Join key from medius_order_lines (purchase_order, article_code) back to an
// avvik's own (supplier_order_number/orderId, article_number) - see Steg 1 in
// the task's mapping: these two pairs represent the same order line.
function buildOrderLineKey(purchaseOrder, articleCode) {
  return [purchaseOrder, articleCode].map(normalizeKey).join(':');
}

// Loose match key between an unconnected medius_invoice_lines candidate and
// an avvik's order line: same article, same supplier. Deliberately ignores
// the PO/Visma-order reference entirely - that's what decides strong vs.
// weak in buildInvoiceSuggestion below, not whether a candidate qualifies at
// all.
function buildInvoiceLineCandidateKey(articleCode, supplierId) {
  return [articleCode, supplierId].map(normalizeKey).join(':');
}

// Whether an invoice line's own visma_purchase_order agrees with the order
// line's extracted Visma order number (supplier_order_line.reference_id's
// first segment, before the first "-"). Null/missing on either side can
// never agree - a candidate with nothing to compare is always a weak match,
// not a false positive.
function matchesVismaOrder(invoiceVismaPurchaseOrder, extractedVismaOrder) {
  if (!invoiceVismaPurchaseOrder || !extractedVismaOrder) return false;
  return normalizeKey(invoiceVismaPurchaseOrder) === normalizeKey(extractedVismaOrder);
}

// Ready-to-render suggestion for one candidate invoice line against one
// avvik's order line. orderLine may be null (no medius_order_lines row found
// for this order+article) - the "ordrelinje" card is then omitted, but the
// suggestion itself still stands on the supplier-order-line + invoice-line
// data alone.
function buildInvoiceSuggestion({ orderLine, orderId, articleNumber, poNumber, referenceId, invoiceLine }) {
  const strong = matchesVismaOrder(invoiceLine.visma_purchase_order, poNumber);
  const quantityMatches =
    orderLine && invoiceLine.quantity != null && orderLine.quantity != null && Number(invoiceLine.quantity) === Number(orderLine.quantity);
  const amountMatches =
    orderLine && invoiceLine.amount != null && orderLine.amount != null && Number(invoiceLine.amount) === Number(orderLine.amount);

  const reasons = [
    { ok: true, text: `Fakturalinjen har samme artikkelkode (${articleNumber}) som ordrelinjen.` },
    {
      ok: true,
      text: `Fakturalinjen har samme leverandør${invoiceLine.supplier_name ? ` (${invoiceLine.supplier_name})` : ''}${
        invoiceLine.supplier_id ? `, ID ${invoiceLine.supplier_id}` : ''
      } som ordrelinjen.`,
    },
    {
      ok: true,
      text: `Fakturalinjen er ikke koblet til noen ordrelinje (koblingsstatus: ${invoiceLine.connection_status || 'ukjent'}).`,
    },
    strong
      ? {
          ok: true,
          text: `Fakturalinjens Visma-ordre (${invoiceLine.visma_purchase_order}) matcher Visma-ordren fra leverandørordrelinjens reference_id (${poNumber}).`,
        }
      : {
          ok: false,
          text: `Fakturalinjens Visma-ordre (${invoiceLine.visma_purchase_order || '—'}) matcher IKKE Visma-ordren fra leverandørordrelinjens reference_id (${poNumber || '—'}) – dette kan bety at fakturaen tilhører en annen ordre, eller at ordrereferansen er feil. Manuell sjekk anbefales.`,
        },
  ];
  if (quantityMatches && amountMatches) {
    reasons.push({
      ok: true,
      text: `Fakturert antall (${invoiceLine.quantity}) og beløp (${invoiceLine.amount}) samsvarer med ordrelinjen.`,
    });
  }

  return {
    strength: strong ? 'strong' : 'weak',
    orderId,
    articleNumber,
    poNumber,
    referenceId,
    orderLine: orderLine
      ? {
          purchaseOrder: orderLine.purchase_order,
          articleCode: orderLine.article_code,
          articleName: orderLine.article_name,
          supplierName: orderLine.supplier_name,
          quantity: orderLine.quantity,
          unitPrice: orderLine.unit_price,
          amount: orderLine.amount,
          connectedQuantity: orderLine.connected_quantity,
          receivedNotConnectedQuantity: orderLine.received_not_connected_quantity,
        }
      : null,
    invoiceLine: {
      invoiceNumber: invoiceLine.invoice_number,
      vismaPurchaseOrder: invoiceLine.visma_purchase_order,
      articleCode: invoiceLine.article_code,
      articleName: invoiceLine.article_name,
      quantity: invoiceLine.quantity,
      unitPrice: invoiceLine.unit_price,
      amount: invoiceLine.amount,
      connectionStatus: invoiceLine.connection_status,
      documentId: invoiceLine.document_id,
      quantityNotConnected: invoiceLine.quantity_not_connected_to_purchase_order_line,
      amountNotConnected: invoiceLine.amount_not_connected_to_purchase_order_line,
    },
    reasons,
  };
}

const SUGGESTION_STRENGTH_RANK = { strong: 0, weak: 1 };

// Strongest suggestions first; a stable, deterministic tiebreak
// (invoice_number) within the same strength so repeated syncs don't reorder
// candidates that didn't actually change. Capped to the 5 most relevant per
// the task's limit.
function rankInvoiceSuggestions(suggestions, limit = 5) {
  return [...suggestions]
    .sort((a, b) => {
      const rankDiff = SUGGESTION_STRENGTH_RANK[a.strength] - SUGGESTION_STRENGTH_RANK[b.strength];
      if (rankDiff !== 0) return rankDiff;
      const aKey = String(a.invoiceLine.invoiceNumber ?? '');
      const bKey = String(b.invoiceLine.invoiceNumber ?? '');
      return aKey > bKey ? 1 : aKey < bKey ? -1 : 0;
    })
    .slice(0, limit);
}

module.exports = {
  buildOrderLineKey,
  buildInvoiceLineCandidateKey,
  matchesVismaOrder,
  buildInvoiceSuggestion,
  rankInvoiceSuggestions,
};
