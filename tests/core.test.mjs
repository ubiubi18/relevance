import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
  DEFAULT_SETTINGS,
  settingsFor,
  updateSettings,
  updateView,
  viewWeight,
  emptyState,
  parseState,
  updatePersonal as updatePersonalCore,
  updateReach,
  rankPosts as rankPostsCore,
  feedSignal,
  preferenceFreshness,
  feedbackToPoint,
  pointToFeedback,
} from '../core.mjs';

const NOW = Date.UTC(2026, 8, 29);
const DAY_MS = 86400000;
const updatePersonal = (state, id, reaction, feed, topic, now = NOW) =>
  updatePersonalCore(state, id, reaction, feed, topic, now);
const rankPosts = (posts, state = emptyState(), catalog = posts, now = NOW) =>
  rankPostsCore(posts, state, catalog, now);

const choice = (reaction, feed, reach = null, personal = true) => ({
  reaction, feed, reach, personal, ...(personal ? { updatedAt: NOW } : {}),
});

test('new state and reach-only choices have no ranking effect', () => {
  assert.equal(STORAGE_KEY, 'relevance.v1');
  const posts = [
    { id: 'a', topic: 'science', baseScore: 10, title: 'A' },
    { id: 'b', topic: 'science', baseScore: 8, title: 'B' },
  ];
  const initial = emptyState();
  assert.deepEqual(initial, { version: 1, choices: {} });
  assert.deepEqual(rankPosts(posts, initial).map(({ score, adjustment, topicPreference }) =>
    [score, adjustment, topicPreference]), [[10, 0, 0], [8, 0, 0]]);

  const reached = updateReach(initial, 'a', 'yes');
  assert.deepEqual(reached.choices.a, choice(0, 0, 'yes', false));
  assert.deepEqual(rankPosts(posts, reached).map(({ score }) => score), [10, 8]);
});

test('dislike with more raises a topic, while like with less lowers it', () => {
  const posts = [
    { id: 'a', topic: 'science', baseScore: 10 },
    { id: 'b', topic: 'science', baseScore: 8 },
    { id: 'c', topic: 'sports', baseScore: 15 },
  ];
  const more = rankPosts(posts, updatePersonal(emptyState(), 'a', -2, 2));
  assert.deepEqual(more.map(({ id }) => id), ['a', 'b', 'c']);
  assert.deepEqual(more.map(({ score }) => score), [50, 48, 15]);
  assert.equal(more[1].topicPreference, 2);

  const less = rankPosts(posts, updatePersonal(emptyState(), 'a', 2, -2));
  assert.deepEqual(less.map(({ id }) => id), ['c', 'a', 'b']);
  assert.deepEqual(less.map(({ score }) => score), [15, -30, -32]);
  assert.equal(less[1].topicPreference, -2);
});

test('reaction and reach are independent of the feed ranking axis', () => {
  const posts = [{ id: 'a', topic: 'science', baseScore: 10 }];
  const disliked = updateReach(updatePersonal(emptyState(), 'a', -2, 1), 'a', 'yes');
  const liked = updateReach(updatePersonal(emptyState(), 'a', 2, 1), 'a', 'no');
  assert.deepEqual(rankPosts(posts, disliked), rankPosts(posts, liked));
  assert.equal(rankPosts(posts, disliked)[0].score, 30);
});

test('neutral personal answers count in the mean; reach-only answers do not', () => {
  const catalog = [
    { id: 'a', topic: 'science', baseScore: 0 },
    { id: 'b', topic: 'science', baseScore: 0 },
    { id: 'c', topic: 'science', baseScore: 0 },
  ];
  let state = updatePersonal(emptyState(), 'a', 0, 2);
  state = updatePersonal(state, 'b', 0, 0);
  state = updateReach(state, 'c', 'no');
  const ranked = rankPosts([{ id: 'target', topic: 'science', baseScore: 7 }], state, catalog);
  assert.deepEqual(ranked[0], {
    id: 'target', topic: 'science', baseScore: 7,
    adjustment: 20, score: 27, topicPreference: 1,
  });
});

test('updates preserve independent answers without mutating earlier states', () => {
  const initial = emptyState();
  const reached = updateReach(initial, 'a', 'no');
  const personal = updatePersonal(reached, 'a', -1, 2);
  const changedReach = updateReach(personal, 'a', 'yes');

  assert.deepEqual(initial.choices, {});
  assert.deepEqual(reached.choices.a, choice(0, 0, 'no', false));
  assert.deepEqual(personal.choices.a, choice(-1, 2, 'no', true));
  assert.deepEqual(changedReach.choices.a, choice(-1, 2, 'yes', true));
  assert.notEqual(changedReach.choices, personal.choices);
  assert.notEqual(changedReach.choices.a, personal.choices.a);
});

test('fractional feedback survives storage and contributes its exact feed value to ranking', () => {
  const initial = emptyState();
  const first = updateReach(updatePersonal(initial, 'a', 0.5, 0.75), 'a', 'yes');
  const state = updatePersonal(first, 'b', -1.25, -0.25);
  const restored = parseState(JSON.stringify(state));
  assert.deepEqual(restored, state);
  assert.deepEqual(restored.choices.a, choice(0.5, 0.75, 'yes'));
  assert.deepEqual(initial.choices, {});
  assert.deepEqual(first.choices.a, choice(0.5, 0.75, 'yes'));

  const catalog = [
    { id: 'a', topic: 'science', baseScore: 0 },
    { id: 'b', topic: 'science', baseScore: 0 },
  ];
  const posts = [{ id: 'target', topic: 'science', baseScore: 10 }];
  assert.deepEqual(rankPosts(posts, restored, catalog)[0], {
    id: 'target', topic: 'science', baseScore: 10,
    adjustment: 5, score: 15, topicPreference: 0.25,
  });
  assert.deepEqual(posts, [{ id: 'target', topic: 'science', baseScore: 10 }]);
});

test('stored state is normalized and malformed or unsafe records are discarded', () => {
  assert.deepEqual(parseState('{'), emptyState());
  assert.deepEqual(parseState(JSON.stringify({ version: 2, choices: {} })), emptyState());
  assert.deepEqual(parseState(JSON.stringify({ version: 1, choices: [] })), emptyState());
  const raw = JSON.stringify({
    version: 1,
    choices: {
      good: { ...choice(1, -1, 'yes'), extra: 'discard me' },
      missingPersonal: { reaction: 0, feed: 0, reach: null },
      badRating: choice(0, 3),
      badReach: choice(0, 0, 'maybe'),
      constructor: choice(0, 2),
      prototype: choice(0, 2),
    },
  }).replace('"choices":{', '"choices":{"__proto__":{"reaction":0,"feed":2,"reach":null,"personal":true},');
  assert.deepEqual(parseState(raw, NOW), { version: 1, choices: { good: choice(1, -1, 'yes') } });
  assert.deepEqual(parseState('{"version":1,"choices":{"old":{"reaction":2,"feed":-1,"reach":"no","personal":true}}}', NOW), {
    version: 1, choices: { old: choice(2, -1, 'no') },
  });
  assert.deepEqual(parseState('{"version":1,"choices":{"bad":{"reaction":1e309,"feed":0,"reach":null,"personal":true}}}'), emptyState());
});

test('update inputs reject unsafe ids and invalid values', () => {
  for (const id of ['__proto__', 'constructor', 'prototype', '']) {
    assert.throws(() => updatePersonal(emptyState(), id, 0, 0), TypeError);
    assert.throws(() => updateReach(emptyState(), id, 'yes'), TypeError);
  }
  for (const invalid of [NaN, Infinity, -Infinity, -2.01, 2.01]) {
    assert.throws(() => updatePersonal(emptyState(), 'a', invalid, 0), RangeError);
    assert.throws(() => updatePersonal(emptyState(), 'a', 0, invalid), RangeError);
  }
  assert.throws(() => updateReach(emptyState(), 'a', 'maybe'), TypeError);
});

test('feedback maps continuously between independent square ratings and the circular point', () => {
  assert.deepEqual(feedbackToPoint({ reaction: 0, feed: 0 }), { x: 0, y: 0 });
  assert.deepEqual(pointToFeedback(0, 0), { reaction: 0, feed: 0 });
  assert.deepEqual(feedbackToPoint({ reaction: 2, feed: 0 }), { x: 0, y: 1 });
  assert.deepEqual(feedbackToPoint({ reaction: 0, feed: 2 }), { x: 1, y: 0 });
  assert.deepEqual(feedbackToPoint({ reaction: 0, feed: -2 }), { x: -1, y: 0 });
  assert.deepEqual(pointToFeedback(0.25, 0), { reaction: 0, feed: 0.5 });

  const corner = feedbackToPoint({ reaction: -2, feed: 2 });
  assert.ok(Math.abs(corner.x - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(corner.y + Math.SQRT1_2) < 1e-12);
  const restoredCorner = pointToFeedback(corner.x, corner.y);
  assert.ok(Math.abs(restoredCorner.reaction + 2) < 1e-12);
  assert.ok(Math.abs(restoredCorner.feed - 2) < 1e-12);

  const fractional = { reaction: 0.37, feed: -1.42 };
  const { x, y } = feedbackToPoint(fractional);
  const restored = pointToFeedback(x, y);
  assert.ok(Math.abs(restored.reaction - fractional.reaction) < 1e-12);
  assert.ok(Math.abs(restored.feed - fractional.feed) < 1e-12);
  const nearby = pointToFeedback(0.251, 0);
  assert.ok(nearby.feed > 0.5 && nearby.feed < 0.51);
});

test('pointer positions outside the circle clamp radially and mapping rejects invalid numbers', () => {
  assert.deepEqual(pointToFeedback(-3, 4), { reaction: 2, feed: -1.5 });
  assert.deepEqual(pointToFeedback(4, 0), { reaction: 0, feed: 2 });
  assert.deepEqual(pointToFeedback(Number.MAX_VALUE, Number.MAX_VALUE), { reaction: 2, feed: 2 });
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.throws(() => pointToFeedback(invalid, 0), TypeError);
    assert.throws(() => pointToFeedback(0, invalid), TypeError);
    assert.throws(() => feedbackToPoint({ reaction: invalid, feed: 0 }), RangeError);
    assert.throws(() => feedbackToPoint({ reaction: 0, feed: invalid }), RangeError);
  }
  assert.throws(() => feedbackToPoint({ reaction: 2.01, feed: 0 }), RangeError);
});

test('equal scores retain the original post order', () => {
  const posts = [
    { id: 'b', topic: 'one', baseScore: 10 },
    { id: 'a', topic: 'two', baseScore: 10 },
    { id: 'c', topic: 'three', baseScore: 9 },
  ];
  assert.deepEqual(rankPosts(posts, emptyState()).map(({ id }) => id), ['b', 'a', 'c']);
  assert.deepEqual(posts.map(({ id }) => id), ['b', 'a', 'c']);
});

test('explicit topic preference survives a refreshed catalogue without its original post', () => {
  const selected = updatePersonal(emptyState(), 'old-post', -0.4, 1.5, 'science-feed');
  const restored = parseState(JSON.stringify(updateReach(selected, 'old-post', 'no')));
  const candidates = [
    { id: 'art-new', topic: 'art-feed', baseScore: 70 },
    { id: 'science-new', topic: 'science-feed', baseScore: 70 },
  ];
  assert.deepEqual(rankPosts(candidates, restored).map(post => [post.id, post.score]), [['science-new', 100], ['art-new', 70]]);
  assert.equal(restored.choices['old-post'].topic, 'science-feed');
  assert.equal(updatePersonal(restored, 'old-post', 1, -1).choices['old-post'].topic, 'science-feed');
  assert.throws(() => updatePersonal(emptyState(), 'post', 0, 0, {}), TypeError);
  assert.deepEqual(parseState(JSON.stringify({ version: 1, choices: { bad: { reaction: 0, feed: 1, reach: null, personal: true, topic: {} } } })), emptyState());
});

test('view time is separate from choices and cannot rank without explicit feed intent', () => {
  const initial = emptyState();
  const viewed = updateView(initial, 'a', 10, 'science');
  const posts = [{ id: 'target', topic: 'science', baseScore: 70 }];
  assert.deepEqual(initial, emptyState());
  assert.deepEqual(viewed.choices, {});
  assert.equal(viewWeight(viewed, 'a'), 2);
  assert.equal(rankPosts(posts, viewed)[0].score, 70);
  assert.equal(rankPosts(posts, updatePersonal(viewed, 'a', 2, 0, 'science'))[0].score, 70);
  assert.equal(rankPosts(posts, updateReach(viewed, 'a', 'yes'))[0].score, 70);
});

test('time weights explicit More and Less continuously and caps the contribution', () => {
  const posts = [{ id: 'target', topic: 'science', baseScore: 70 }];
  let state = updateView(updatePersonal(emptyState(), 'a', -2, 1, 'science'), 'a', 5, 'science');
  assert.equal(rankPosts(posts, state)[0].score, 100);
  state = updateView(state, 'a', 10, 'science');
  assert.equal(rankPosts(posts, state)[0].score, 110);
  state = updateView(state, 'a', 30, 'science');
  assert.equal(rankPosts(posts, state)[0].score, 110);
  assert.equal(rankPosts(posts, updatePersonal(state, 'a', 2, -1))[0].score, 30);
  assert.equal(rankPosts(posts, updatePersonal(state, 'a', -2, 2))[0].score, 150);
  assert.equal(updateView(state, 'a', 2, 'science').views.a.seconds, 30);
});

test('feeling modes select More signals while every Less signal remains effective', () => {
  const posts = [{ id: 'target', topic: 'science', baseScore: 70 }];
  for (const [feeling, reaction, expected] of [
    ['like', 2, 110], ['like', -2, 70], ['dislike', -2, 110], ['dislike', 2, 70],
    ['neutral', 0, 110], ['neutral', 2, 70], ['both', 2, 110], ['both', -2, 110], ['both', 0, 110],
  ]) {
    const state = updateSettings(updateView(updatePersonal(emptyState(), 'a', reaction, 1, 'science'), 'a', 10, 'science'), { feeling });
    assert.equal(rankPosts(posts, state)[0].score, expected, `${feeling}/${reaction}`);
    assert.equal(rankPosts(posts, updatePersonal(state, 'a', reaction, -1))[0].score, 30, `Less applies in ${feeling}`);
    assert.equal(rankPosts(posts, updateReach(state, 'a', 'yes'))[0].score, expected);
  }
});

test('view records and settings persist through independent choice updates and older state loads', () => {
  let state = updateSettings(updateView(emptyState(), 'a', 5, 'science'), { dwellCap: 20, maxWeight: 3, feeling: 'dislike' });
  state = updateReach(updatePersonal(state, 'a', -1, 1, 'science'), 'a', 'no');
  assert.deepEqual(parseState(JSON.stringify(state)), state);
  assert.equal(viewWeight(state, 'a'), 1.5);
  assert.deepEqual(settingsFor(parseState('{"version":1,"choices":{}}')), DEFAULT_SETTINGS);
  const invalid = parseState(JSON.stringify({ version: 1, choices: {}, views: { a: { seconds: -1, topic: 'science' }, constructor: { seconds: 5, topic: 'science' } }, settings: { dwellCap: -10, maxWeight: 999, feeling: 'angry' } }));
  assert.deepEqual(invalid.views, {});
  assert.deepEqual(settingsFor(invalid), settingsFor(emptyState()));
  for (const settings of [{ dwellCap: 0 }, { dwellCap: 2.5 }, { maxWeight: 6 }, { feeling: 'angry' }, { decayDays: 0 }, { decayDays: 366 }, { decayDays: 2.5 }]) assert.throws(() => updateSettings(state, settings), TypeError);
  for (const value of [NaN, Infinity, -1, 61]) assert.throws(() => updateView(state, 'a', value, 'science'), RangeError);
  assert.throws(() => updateView(state, '__proto__', 2, 'science'), TypeError);
});

test('a personal signal fades linearly to its base score at the configured deadline', () => {
  const posts = [{ id: 'target', topic: 'science', baseScore: 100 }];
  const state = updatePersonal(emptyState(), 'a', 2, 2, 'science');
  for (const [days, freshness, score] of [[0, 1, 140], [7, 0.5, 120], [14, 0, 100], [21, 0, 100]]) {
    const at = NOW + days * DAY_MS;
    assert.equal(preferenceFreshness(state, 'a', at), freshness);
    assert.equal(feedSignal(state, 'a', state.choices.a, at), 2 * freshness);
    assert.equal(rankPosts(posts, state, posts, at)[0].score, score);
  }
  assert.equal(preferenceFreshness(state, 'missing', NOW), 0);
  assert.equal(preferenceFreshness(state, 'a', NOW - DAY_MS), 1);

  const expired = updatePersonal(emptyState(), 'old', 0, 2, 'science', NOW - 14 * DAY_MS);
  const mixed = updatePersonal(expired, 'new', 0, -2, 'science');
  assert.equal(rankPosts(posts, mixed, posts, NOW)[0].topicPreference, -1);
  assert.equal(rankPosts(posts, expired, posts, NOW)[0].score, 100);
});

test('decay scales signed dwell signals after feeling selection', () => {
  const positive = updateView(updatePersonal(emptyState(), 'a', -2, 1, 'science'), 'a', 10, 'science');
  assert.equal(feedSignal(positive, 'a', positive.choices.a, NOW + 7 * DAY_MS), 1);
  const gated = updateSettings(positive, { feeling: 'like' });
  assert.equal(feedSignal(gated, 'a', gated.choices.a, NOW), 0);
  const negative = updatePersonal(gated, 'a', -2, -1, 'science');
  assert.equal(feedSignal(negative, 'a', negative.choices.a, NOW), -2);
  assert.equal(feedSignal(negative, 'a', negative.choices.a, NOW + 7 * DAY_MS), -1);
  assert.equal(feedSignal(negative, 'a', negative.choices.a, NOW + 14 * DAY_MS), 0);
});

test('reach, views and settings preserve age; explicit reconfirmation renews it', () => {
  const original = updatePersonal(emptyState(), 'a', 1, 2, 'science');
  const reached = updateReach(original, 'a', 'yes');
  const viewed = updateView(reached, 'a', 10, 'science');
  const configured = updateSettings(viewed, { decayDays: 28 });
  assert.equal(configured.choices.a.updatedAt, NOW);
  assert.equal(preferenceFreshness(configured, 'a', NOW + 14 * DAY_MS), 0.5);
  assert.equal(feedSignal(configured, 'a', configured.choices.a, NOW + 14 * DAY_MS), 2);
  assert.equal(preferenceFreshness(configured, 'a', NOW + 28 * DAY_MS), 0);
  const renewed = updatePersonal(configured, 'a', 1, 2, 'science', NOW + 14 * DAY_MS);
  assert.equal(renewed.choices.a.updatedAt, NOW + 14 * DAY_MS);
  assert.equal(preferenceFreshness(renewed, 'a', NOW + 14 * DAY_MS), 1);
  assert.equal(preferenceFreshness(configured, 'a', NOW + 14 * DAY_MS), 0.5);
  assert.deepEqual(original.choices.a, { ...choice(1, 2), topic: 'science' });
  assert.deepEqual(reached.choices.a, { ...choice(1, 2, 'yes'), topic: 'science' });
  assert.throws(() => updatePersonal(original, 'a', 1, 2, 'science', -1), RangeError);
});

test('legacy choices receive one stable migration time and malformed timestamps are dropped', () => {
  const legacy = JSON.stringify({ version: 1, choices: {
    personal: { reaction: 2, feed: 1, reach: null, personal: true, topic: 'science' },
    reached: { reaction: 0, feed: 0, reach: 'yes', personal: false },
  }, settings: { dwellCap: 5 } });
  const migrated = parseState(legacy, NOW);
  assert.equal(migrated.choices.personal.updatedAt, NOW);
  assert.equal(migrated.choices.reached.updatedAt, undefined);
  assert.equal(preferenceFreshness(migrated, 'personal', NOW + 7 * DAY_MS), 0.5);
  assert.deepEqual(parseState(JSON.stringify(migrated), NOW + 7 * DAY_MS), migrated);
  assert.equal(settingsFor(migrated).decayDays, 14);

  const raw = JSON.stringify({ version: 1, choices: {
    validFuture: { ...choice(1, 1), updatedAt: NOW + 7 * DAY_MS },
    badNegative: { ...choice(1, 1), updatedAt: -1 },
    badText: { ...choice(1, 1), updatedAt: 'yesterday' },
    badLarge: { ...choice(1, 1), updatedAt: 8640000000000001 },
  } });
  const parsed = parseState(raw, NOW);
  assert.deepEqual(Object.keys(parsed.choices), ['validFuture']);
  assert.equal(preferenceFreshness(parsed, 'validFuture', NOW), 1);
  assert.equal(preferenceFreshness(parsed, 'validFuture', NOW + 7 * DAY_MS), 1);
  assert.equal(preferenceFreshness(parsed, 'validFuture', NOW + 14 * DAY_MS), 0.5);

  const fixture = { version: 1, choices: { a: { reaction: 0, feed: 1, reach: null, personal: true, topic: 'science' } } };
  assert.equal(preferenceFreshness(fixture, 'a', NOW + 30 * DAY_MS), 1);
  assert.equal(rankPosts([{ id: 'target', topic: 'science', baseScore: 0 }], fixture, undefined, NOW + 30 * DAY_MS)[0].score, 20);
});
