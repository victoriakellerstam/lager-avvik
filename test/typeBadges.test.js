'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getTypeBadgeClass, DEFAULT_BADGE_CLASS } = require('../src/typeBadges');
const { INSTRUCTIONS } = require('../src/instructions');

test('every known scenario type has a badge class', () => {
  for (const type of Object.keys(INSTRUCTIONS)) {
    assert.ok(getTypeBadgeClass(type), `expected a badge class for "${type}"`);
  }
});

test('an unknown type falls back to the default badge class', () => {
  assert.equal(getTypeBadgeClass('Noe helt ukjent'), DEFAULT_BADGE_CLASS);
});
