'use strict';

const { SEED_AVVIK } = require('./mockData');
const persistence = require('./persistence');

// Local state (comments, resolved/archived avvik, notification log) is durable
// via persistence.js, but everything else here is still in memory only: the
// real avvik feed comes from the dwh sync in index.js (see avvikSync.js), and
// SEED_AVVIK is fixture data for tests only (via _reset()), not loaded here, so
// production never mixes mock rows into the real feed.
let avvikList = [];
let notifications = [];
let nextNotificationId = 1;

// Off until initPersistence() runs, so tests (which call _reset()) never touch
// the developer's real data/state.json.
let persistenceEnabled = false;

function listAvvik() {
  return avvikList;
}

function getAvvik(id) {
  return avvikList.find((a) => a.id === id) || null;
}

// Called once at startup, before the first dwh sync, so the comments/resolved
// flags of the previous run are already in place by the time that sync merges
// into the list. A missing or unusable file is not an error - it just means
// there is no previous local state to restore (see persistence.loadState).
function initPersistence() {
  const loaded = persistence.loadState();
  persistenceEnabled = true;
  if (loaded) {
    // Defensive normalization: a row written by an older build, or hand-edited
    // state.json, may be missing fields this one reads unconditionally
    // (addComment pushes onto `comments`, dashboard reads `resolved`).
    avvikList = loaded.avvikList.map((a) => ({
      ...a,
      comments: Array.isArray(a.comments) ? a.comments : [],
      resolved: Boolean(a.resolved),
      resolvedAt: a.resolvedAt || null,
      lastNotifiedAt: a.lastNotifiedAt || null,
      purchaserManuallySet: Boolean(a.purchaserManuallySet),
      missingFromLastSyncAt: a.missingFromLastSyncAt || null,
      resolvedSource: a.resolvedSource || (a.resolved ? 'manual' : null),
    }));
    notifications = loaded.notifications;
    nextNotificationId = notifications.reduce((max, n) => Math.max(max, n.id || 0), 0) + 1;
    console.log(`restored local state from ${persistence.stateFilePath()}: ${avvikList.length} avvik, ${notifications.length} notifications`);
  }
}

function persist() {
  if (!persistenceEnabled) return;
  persistence.saveState({ avvikList, notifications, nextNotificationId });
}

// Why each avvik counts as resolved, which decides what a later sync is allowed
// to undo (see mergeFromDwh):
//   'manual' - a person clicked "Marker løst". Their decision outranks dwh:
//     if the order line is still 3030 on the next sync, it stays resolved.
//   'auto'   - the order line simply stopped coming back from dwh (it stopped
//     being 3030, so it no longer counts as an avvik at all). This one is
//     reversible: if the line starts showing up again, it reopens.
function resolveAvvik(id, source = 'manual') {
  const avvik = getAvvik(id);
  if (!avvik) return null;
  avvik.resolved = true;
  avvik.resolvedSource = source;
  avvik.resolvedAt = avvik.resolvedAt || new Date().toISOString();
  avvik.missingFromLastSyncAt = null;
  persist();
  return avvik;
}

// Undo for an avvik resolved by mistake - moves it back to the open list.
function reopenAvvik(id) {
  const avvik = getAvvik(id);
  if (!avvik) return null;
  avvik.resolved = false;
  avvik.resolvedSource = null;
  avvik.resolvedAt = null;
  persist();
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
  persist();
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
  persist();
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
  persist();
  return comment;
}

// Reconciles a fresh batch of dwh-derived avvik (see src/avvikSync.js) into
// the existing list, keyed by each row's synthetic `id`. This is the only place
// dwh data ever touches the store, and it deliberately never deletes anything:
//   - id in both: overwrite the dwh-derived fields, but never touch
//     `resolved`/`resolvedAt`/`lastNotifiedAt`/`comments` - those are owned
//     entirely by the warehouse team, not dwh. Same for purchaserName/
//     purchaserEmail once purchaserManuallySet is true (see
//     setManualPurchaser) - a human's correction outranks dwh's answer.
//   - id only in the fresh batch: inserted as a brand-new avvik.
//   - id only in the existing list: the order line is no longer in dwh's result
//     set, i.e. it no longer has order_status = 3030 (one of the filters
//     fetchAvvikRows' source query applies - see dwhQueries.js). That is the
//     real-world flow the archive is built around: a line sits at 3030 ("mottat")
//     until it gets matched against a supplier invoice line, at which point it
//     leaves 3030 and stops being an avvik. So a row going missing is the
//     normal, expected way a case closes, and it is archived right away rather
//     than after a delay - `resolvedAt` is stamped from
//     `missingFromLastSyncAt` (set on the *first* sync where it went missing, so
//     it reads as "first seen gone", not "last checked and still gone"), which
//     is the closest available answer to "when was this resolved" given dwh has
//     no status-history table.
//
//     Reversibility is decided by `resolvedSource`:
//     - 'auto' (archived this way) reopens if the line comes back. The user
//       described the flow as one-directional (Standard -> 3030 -> matched ->
//       leaves 3030), but a line reappearing means dwh disagrees that it's
//       closed, and showing a genuinely-open avvik in the archive would be
//       worse than reopening one.
//     - 'manual' is left resolved regardless - a person said so.
//   Note that a resolved row is never dropped from avvikList, so the archive
//   keeps growing and its rows stay renderable: dwh no longer returns them, so
//   their dwh-derived fields are only available from the persisted state.
function mergeFromDwh(freshAvvikRows, now = new Date()) {
  const freshById = new Map(freshAvvikRows.map((a) => [a.id, a]));
  const nowIso = now.toISOString();
  let updated = 0;
  let archived = 0;
  let reopened = 0;

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
      existing.projectNumber = fresh.projectNumber;
      if (!existing.purchaserManuallySet) {
        existing.purchaserName = fresh.purchaserName;
        existing.purchaserEmail = fresh.purchaserEmail;
        existing.department = fresh.department;
      }
      existing.discrepancyType = fresh.discrepancyType;
      existing.createdAt = fresh.createdAt;
      existing.daysWaiting = fresh.daysWaiting;
      existing.missingFromLastSyncAt = null;
      // A row that was auto-archived and is now back from dwh is open again -
      // but only if the archive was dwh's doing, never a person's own decision.
      if (existing.resolved && existing.resolvedSource === 'auto') {
        existing.resolved = false;
        existing.resolvedSource = null;
        existing.resolvedAt = null;
        reopened += 1;
      }
      updated += 1;
      freshById.delete(existing.id); // consumed; anything left over is new
    } else if (!existing.resolved) {
      existing.missingFromLastSyncAt = existing.missingFromLastSyncAt || nowIso;
      existing.resolved = true;
      existing.resolvedSource = 'auto';
      existing.resolvedAt = existing.missingFromLastSyncAt;
      archived += 1;
    }
  }

  let inserted = 0;
  for (const fresh of freshById.values()) {
    avvikList.push({
      ...fresh,
      resolved: false,
      resolvedAt: null,
      resolvedSource: null,
      lastNotifiedAt: null,
      comments: [],
      missingFromLastSyncAt: null,
      purchaserManuallySet: false,
    });
    inserted += 1;
  }

  persist();
  return { updated, inserted, archived, reopened };
}

// Test-only helper to reset state between test files. Doesn't persist, so a
// test run can never overwrite a developer's real state.json.
function _reset() {
  avvikList = SEED_AVVIK.map((a) => ({ ...a, comments: (a.comments || []).map((c) => ({ ...c })) }));
  notifications = [];
  nextNotificationId = 1;
  persistenceEnabled = false;
}

// Test-only: point the store at a throwaway state file and turn persistence on,
// so a test can cover the real load/save round trip.
function _enablePersistenceAt(filePath) {
  process.env.LAGER_AVVIK_STATE_FILE = filePath;
  persistenceEnabled = true;
}

module.exports = {
  listAvvik,
  getAvvik,
  initPersistence,
  resolveAvvik,
  reopenAvvik,
  setManualPurchaser,
  recordNotification,
  listNotifications,
  addComment,
  mergeFromDwh,
  _reset,
  _enablePersistenceAt,
};