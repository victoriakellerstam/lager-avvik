'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

test.beforeEach(() => {
  store._reset();
});

test('addComment appends a comment with its author to the right avvik', () => {
  const [first] = store.listAvvik();
  const before = first.comments.length;

  const comment = store.addComment(first.id, 'Ole', 'Ser bra ut na');

  assert.equal(comment.author, 'Ole');
  assert.equal(comment.text, 'Ser bra ut na');
  assert.ok(comment.createdAt);
  assert.equal(store.getAvvik(first.id).comments.length, before + 1);
});

test('comments on one avvik do not leak onto another', () => {
  const [first, second] = store.listAvvik();
  store.addComment(first.id, 'Ole', 'Kommentar pa forste avvik');

  assert.equal(store.getAvvik(second.id).comments.some((c) => c.text === 'Kommentar pa forste avvik'), false);
});

test('addComment returns null for an unknown avvik id', () => {
  assert.equal(store.addComment(999999, 'Ole', 'test'), null);
});

test('seeded comments already carry an author, so who-commented is visible without adding anything', () => {
  const withComments = store.listAvvik().find((a) => a.comments.length > 0);
  assert.ok(withComments, 'expected at least one seeded avvik to have a comment');
  assert.ok(withComments.comments[0].author);
});
