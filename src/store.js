'use strict';

const { SEED_AVVIK } = require('./mockData');

// In-memory only: this app has no persistent database wired up yet. State
// resets on restart, and the real avvik feed comes from the dwh startup sync
// in index.js (see avvikSync.js) - SEED_AVVIK is fixture data for tests only
// (via _reset()), not loaded here, so production never mixes mock rows into
// the real feed.
let avvikList = [];
let notifications = [];
let nextNotificationId = 1;

// Same >21-days/three-week threshold fetchAvvikRows itself requires before an
// order line counts as an avvik at all (see dwhQueries.js) - reused in
// mergeFromDwh below so a single sync where a row goes missing isn't trusted
// as a genuine resolution on its own; it has to stay missing for this same
// three weeks first.
const MISSING_TO_RESOLVED_DAYS = 21;
const MISSING_TO_RESOLVED_MS = MISSING_TO_RESOLVED_DAYS * 24 * 60 * 60 * 1000;

function listAvvik() {
  return avvikList;
}

function getAvvik(id) {
  return avvikList.find((a) => a.id === id) || null;
}

function resolveAvvik(id) {
  const avvik = getAvvik(id);
  if (!avvik) return null;
  avvik.resolved = true;
  avvik.resolvedAt = new Date().toISOString();
  return avvik;
}

// Undo for an avvik resolved by mistake - moves it back to the open list.
function reopenAvvik(id) {
  const avvik = getAvvik(id);
  if (!avvik) return null;
  avvik.resolved = false;
  avvik.resolvedAt = null;
  return avvik;
}

// Manual correction for an avvik whose dwh-resolved case_owner came back as
// "Sakseier ikke funnet" / "Manuell ordre – sakseier mangler" (see
// dashboard.js's NO_OWNER_NAMES). Sets purchaserManuallySet so a later
// mergeFromDwh doesn't overwrite this correction with dwh's answer again -
// once someone's identified the real owner, that sticks. department (looked
// up by index.js via avvikSync.resolveDepartmentForPurchaser) only replaces
// the existing value when a real one was found - a name with no employee
// match shouldn't blank out a department_number-based value that's still
// perfectly valid.
function setManualPurchaser(id, name, email, department) {
  const avvik = getAvvik(id);
  if (!avvik) return null;
  avvik.purchaserName = name;
  avvik.purchaserEmail = email || null;
  avvik.purchaserManuallySet = true;
  if (department) avvik.department = department;
  return avvik;
}

function recordNotification(avvik, preview, now) {
  avvik.lastNotifiedAt = now.toISOString();
  const entry = {
    id: nextNotificationId++,
    avvikId: avvik.id,
    sentAt: now.toISOString(),
    to: preview.to,
    subject: preview.subject,
    body: preview.body,
    simulated: true,
  };
  notifications.unshift(entry);
  return entry;
}

function listNotifications() {
  return notifications;
}

// Comments are scoped to their avvik, so each avvik's own comment list gets
// its own id sequence - callers only ever see comments for one avvik at a time.
function addComment(id, author, text) {
  const avvik = getAvvik(id);
  if (!avvik) return null;
  const comment = {
    id: avvik.comments.length + 1,
    author,
    text,
    createdAt: new Date().toISOString(),
  };
  avvik.comments.push(comment);
  return comment;
}

// Reconciles a fresh batch of dwh-derived avvik (see src/avvikSync.js) into
// the existing in-memory list, keyed by each row's synthetic `id`. This is
// the only place dwh data ever touches the store, and it deliberately never
// deletes anything:
//   - id in both: overwrite the dwh-derived fields, but never touch
//     `resolved`/`resolvedAt`/`lastNotifiedAt`/`comments` - those are owned
//     entirely by the warehouse team, not dwh. Same for purchaserName/
//     purchaserEmail once purchaserManuallySet is true (see
//     setManualPurchaser) - a human's correction outranks dwh's answer.
//   - id only in the fresh batch: inserted as a brand-new avvik.
//   - id only in the existing list (missing from the fresh batch): the
//     underlying order line no longer has order_status = 3030 - one of the
//     filters fetchAvvikRows' source query applies (see dwhQueries.js) - but
//     a single sync where it goes missing isn't trusted as a genuine
//     resolution on its own, since a status can blip for reasons unrelated
//     to actually being fixed. If it was still open, it's stamped with
//     `missingFromLastSyncAt` on the *first* sync where it goes missing (so
//     the field reads as "missing since", not "last checked and still
//     missing"); only once it has stayed missing for MISSING_TO_RESOLVED_DAYS
//     (the same three-week/21-day threshold fetchAvvikRows itself requires
//     before an order line counts as an avvik at all) does this app trust
//     the disappearance and auto-resolve it - same `resolved`/`resolvedAt` a
//     manual "Marker løst" sets. If it was already resolved, it's left
//     alone entirely - expected to age out over time. Reappearing before
//     the three weeks are up clears `missingFromLastSyncAt` and it's never
//     auto-resolved; reappearing after auto-resolution just clears the flag
//     again without auto-reopening it - a human uses "Gjenåpne" for that,
//     same as any other resolved avvik.
function mergeFromDwh(freshAvvikRows, now = new Date()) {
  const freshById = new Map(freshAvvikRows.map((a) => [a.id, a]));
  const nowIso = now.toISOString();
  let updated = 0;
  let markedMissing = 0;

  for (const existing of avvikList) {
    const fresh = freshById.get(existing.id);
    if (fresh) {
      existing.orderId = fresh.orderId;
      existing.articleNumber = fresh.articleNumber;
      existing.poNumber = fresh.poNumber;
      existing.lotNumber = fresh.lotNumber;
      existing.invoiceNumber = fresh.invoiceNumber;
      existing.mediusLink = fresh.mediusLink;
      existing.ticketUrl = fresh.ticketUrl;
      existing.totalQuantity = fresh.totalQuantity;
      existing.resoldQuantity = fresh.resoldQuantity;
      existing.writtenOffQuantity = fresh.writtenOffQuantity;
      existing.resoldStatus = fresh.resoldStatus;
      existing.writtenOffStatus = fresh.writtenOffStatus;
      existing.invoiceDeviations = fresh.invoiceDeviations;
      existing.invoiceSuggestions = fresh.invoiceSuggestions;
      existing.supplierName = fresh.supplierName;
      if (!existing.purchaserManuallySet) {
        existing.purchaserName = fresh.purchaserName;
        existing.purchaserEmail = fresh.purchaserEmail;
        existing.department = fresh.department;
      }
      existing.discrepancyType = fresh.discrepancyType;
      existing.createdAt = fresh.createdAt;
      existing.daysWaiting = fresh.daysWaiting;
      existing.missingFromLastSyncAt = null;
      updated += 1;
      freshById.delete(existing.id); // consumed; anything left over is new
    } else if (!existing.resolved) {
      if (!existing.missingFromLastSyncAt) {
        existing.missingFromLastSyncAt = nowIso;
      } else if (now.getTime() - new Date(existing.missingFromLastSyncAt).getTime() >= MISSING_TO_RESOLVED_MS) {
        existing.resolved = true;
        existing.resolvedAt = nowIso;
      }
      markedMissing += 1;
    }
  }

  let inserted = 0;
  for (const fresh of freshById.values()) {
    avvikList.push({
      ...fresh,
      resolved: false,
      resolvedAt: null,
      lastNotifiedAt: null,
      comments: [],
      missingFromLastSyncAt: null,
      purchaserManuallySet: false,
    });
    inserted += 1;
  }

  return { updated, inserted, markedMissing };
}

// Test-only helper to reset state between test files.
function _reset() {
  avvikList = SEED_AVVIK.map((a) => ({ ...a, comments: (a.comments || []).map((c) => ({ ...c })) }));
  notifications = [];
  nextNotificationId = 1;
}

module.exports = {
  listAvvik,
  getAvvik,
  resolveAvvik,
  reopenAvvik,
  setManualPurchaser,
  recordNotification,
  listNotifications,
  addComment,
  mergeFromDwh,
  _reset,
};
