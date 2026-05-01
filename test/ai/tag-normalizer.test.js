const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRecommendationTags,
  toCanonicalTag
} = require('../../src/modules/ai/tag-normalizer');

test('tag normalizer maps aliases to canonical recommendation keys', () => {
  assert.equal(toCanonicalTag('relaxing visual novel'), 'relaxing_visual_novel');
  assert.equal(toCanonicalTag('short interactive story'), 'short_interactive_story');
  assert.equal(toCanonicalTag('ShortInteractiveStory'), 'short_interactive_story');
  assert.equal(toCanonicalTag('Visual Novel'), 'visual_novel');
  assert.equal(toCanonicalTag('visual_novel'), 'visual_novel');
  assert.equal(toCanonicalTag('single_player'), 'singleplayer');
  assert.equal(toCanonicalTag('low'), 'low_difficulty');
  assert.equal(toCanonicalTag('role-playing'), 'rpg');
});

test('tag normalizer removes duplicates invalid values and applies maxCount', () => {
  const normalized = normalizeRecommendationTags({
    rawTags: [
      'Visual Novel',
      'visual_novel',
      'unknown',
      '',
      'n/a',
      null,
      'single player',
      'low difficulty',
      'This is a very long sentence that should not become a UI tag for the client'
    ],
    maxCount: 2
  });

  assert.deepEqual(normalized.canonicalTags, ['visual_novel', 'singleplayer']);
  assert.deepEqual(normalized.displayTags, ['Visual Novel', 'Singleplayer']);
  assert.ok(!normalized.rawTags.includes('unknown'));
  assert.ok(!normalized.rawTags.includes('n/a'));
});

test('tag normalizer returns readable English display labels', () => {
  const normalized = normalizeRecommendationTags({
    rawTags: ['relaxing_visual_novel', 'short_session', 'rpg', 'coop']
  });

  assert.deepEqual(normalized.displayTags, [
    'Relaxing Visual Novel',
    'Short Session',
    'RPG',
    'Co-op'
  ]);
});
