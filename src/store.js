'use strict';

const { SEED_AVVIK } = require('./mockData');

// In-memory only: this mockup has no real database wired up yet. State resets
// on restart. See README for what a persistent version would need.
let avvikList = SEED_AVVIK.map((a) => ({ ...a, comments: (a.comments || []).map((c) => ({ ...c })) }));
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
  recordNotification,
  listNotifications,
  addComment,
  _reset,
};
