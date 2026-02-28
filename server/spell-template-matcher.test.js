import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSpellTemplate, matchSpellTemplateFromCatalog } from './spell-template-matcher.js';

test('matches exact alias', () => {
  const match = matchSpellTemplate('fireball');
  assert.equal(match?.key, 'fireball');
  assert.equal(match?.alias, 'fireball');
  assert.equal(typeof match?.expansion, 'string');
  assert.ok(match.expansion.length > 0);
});

test('matches alias phrase inside longer prompt', () => {
  const match = matchSpellTemplate('cast fireball now');
  assert.equal(match?.key, 'fireball');
  assert.equal(match?.alias, 'fireball');
});

test('matches aliases case-insensitively', () => {
  const match = matchSpellTemplate('RING OF ICE');
  assert.equal(match?.key, 'frost');
  assert.equal(match?.alias, 'ring of ice');
});

test('returns null when prompt has no matching alias', () => {
  const match = matchSpellTemplate('summon asteroid swarm');
  assert.equal(match, null);
});

test('resolves overlapping aliases with longest alias first then template order', () => {
  const catalog = {
    version: 'test-v1',
    templates: [
      {
        key: 'short',
        aliases: ['orb'],
        expansion: 'short match',
      },
      {
        key: 'long',
        aliases: ['fire orb'],
        expansion: 'long match',
      },
      {
        key: 'same-length-first',
        aliases: ['storm bolt'],
        expansion: 'first same-length',
      },
      {
        key: 'same-length-second',
        aliases: ['void bolt'],
        expansion: 'second same-length',
      },
    ],
  };

  const longest = matchSpellTemplateFromCatalog('cast fire orb now', catalog);
  assert.equal(longest?.key, 'long');
  assert.equal(longest?.alias, 'fire orb');

  const sameLength = matchSpellTemplateFromCatalog('queue storm bolt and void bolt', catalog);
  assert.equal(sameLength?.key, 'same-length-first');
  assert.equal(sameLength?.alias, 'storm bolt');
});
