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
// once someone's identified the real owner, that sticks.
function setManualPurchaser(id, name, email) {
  const avvik = getAvvik(id);
  if (!avvik) return null;
  avvik.purchaserName = name;
  avvik.purchaserEmail = email || null;
  avvik.purchaserManuallySet = true;
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
// deletes anything - a row missing from a fresh fetch could mean it was
// genuinely resolved upstream, or could mean a sync hiccup, and this app has
// no undo, so disappearance is treated as suspect rather than authoritative:
//   - id in both: overwrite the dwh-derived fields, but never touch
//     `resolved`/`resolvedAt`/`lastNotifiedAt`/`comments` - those are owned
//     entirely by the warehouse team, not dwh. Same for purchaserName/
//     purchaserEmail once purchaserManuallySet is true (see
//     setManualPurchaser) - a human's correction outranks dwh's answer.
//   - id only in the fresh batch: inserted as a brand-new avvik.
//   - id only in the existing list (missing from the fresh batch): if it was
//     still open, it's left in place untouched but stamped with
//     `missingFromLastSyncAt` (only on the *first* sync where it goes
//     missing, so the field reads as "missing since", not "last checked and
//     still missing"); cleared again if it reappears. If it was already
//     resolved, it's left alone entirely - expected to age out over time.
function mergeFromDwh(freshAvvikRows, now = new Date()) {
  const freshById = new Map(freshAvvikRows.map((a) => [a.id, a]));
  const nowIso = now.toISOString();
  let updated = 0;
  let markedMissing = 0;

  for (const existing of avvikList) {
    const fresh = freshById.get(existing.id);
    if (fresh) {
      existing.orderId = fresh.orderId;
      if (!existing.purchaserManuallySet) {
        existing.purchaserName = fresh.purchaserName;
        existing.purchaserEmail = fresh.purchaserEmail;
      }
      existing.discrepancyType = fresh.discrepancyType;
      existing.createdAt = fresh.createdAt;
      existing.daysWaiting = fresh.daysWaiting;
      existing.missingFromLastSyncAt = null;
      updated += 1;
      freshById.delete(existing.id); // consumed; anything left over is new
    } else if (!existing.resolved && !existing.missingFromLastSyncAt) {
      existing.missingFromLastSyncAt = nowIso;
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
