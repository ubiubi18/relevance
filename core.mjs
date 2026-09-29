export const STORAGE_KEY = 'relevance.v1';
export const DEFAULT_SETTINGS = Object.freeze({ dwellCap: 10, maxWeight: 2, feeling: 'both', decayDays: 14 });

const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const DAY_MS = 86400000;
const MAX_TIMESTAMP = 8640000000000000;

export function emptyState() {
  return { version: 1, choices: {} };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && !UNSAFE_IDS.has(id);
}

function idKey(id) {
  const key = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
  if (!isSafeId(key)) throw new TypeError('Post id must be a safe, nonempty string or integer');
  return key;
}

function isRating(value) {
  return Number.isFinite(value) && value >= -2 && value <= 2;
}

function isReach(value) {
  return value === 'yes' || value === 'no' || value === null;
}

function isTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP;
}

function isChoice(value) {
  return isPlainObject(value) &&
    isRating(value.reaction) &&
    isRating(value.feed) &&
    isReach(value.reach) &&
    typeof value.personal === 'boolean' &&
    (value.updatedAt === undefined || isTimestamp(value.updatedAt)) &&
    (value.topic === undefined || (typeof value.topic === 'string' && value.topic.length > 0 && value.topic.length <= 2048));
}

function copyChoice(choice) {
  return {
    reaction: choice.reaction,
    feed: choice.feed,
    reach: choice.reach,
    personal: choice.personal,
    ...(choice.updatedAt === undefined ? {} : { updatedAt: choice.updatedAt }),
    ...(choice.topic === undefined ? {} : { topic: choice.topic }),
  };
}

export function settingsFor(state) {
  const saved = state.settings || {};
  return {
    dwellCap: Number.isInteger(saved.dwellCap) && saved.dwellCap >= 1 && saved.dwellCap <= 60 ? saved.dwellCap : DEFAULT_SETTINGS.dwellCap,
    maxWeight: Number.isFinite(saved.maxWeight) && saved.maxWeight >= 1 && saved.maxWeight <= 5 ? saved.maxWeight : DEFAULT_SETTINGS.maxWeight,
    feeling: ['both', 'like', 'dislike', 'neutral'].includes(saved.feeling) ? saved.feeling : DEFAULT_SETTINGS.feeling,
    decayDays: Number.isInteger(saved.decayDays) && saved.decayDays >= 1 && saved.decayDays <= 365 ? saved.decayDays : DEFAULT_SETTINGS.decayDays,
  };
}

function extraState(state) {
  const extra = {};
  if (isPlainObject(state.views)) {
    extra.views = {};
    for (const [id, view] of Object.entries(state.views)) {
      if (isSafeId(id) && isPlainObject(view) && Number.isFinite(view.seconds) && view.seconds >= 0 && view.seconds <= 60 && typeof view.topic === 'string' && view.topic.length > 0 && view.topic.length <= 2048) {
        extra.views[id] = { seconds: view.seconds, topic: view.topic };
      }
    }
  }
  if (isPlainObject(state.settings)) extra.settings = settingsFor(state);
  return extra;
}

export function parseState(raw, now = Date.now()) {
  if (!isTimestamp(now)) throw new RangeError('Invalid preference timestamp');
  if (typeof raw !== 'string') return emptyState();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.choices)) {
    return emptyState();
  }

  const choices = {};
  for (const [id, choice] of Object.entries(parsed.choices)) {
    if (isSafeId(id) && isChoice(choice)) {
      const copied = copyChoice(choice);
      if (copied.personal && copied.updatedAt === undefined) copied.updatedAt = now;
      choices[id] = copied;
    }
  }
  return { version: 1, choices, ...extraState(parsed) };
}

function copyState(state) {
  if (!isPlainObject(state) || state.version !== 1 || !isPlainObject(state.choices)) {
    throw new TypeError('Invalid state');
  }

  const choices = {};
  for (const [id, choice] of Object.entries(state.choices)) {
    if (!isSafeId(id) || !isChoice(choice)) throw new TypeError('Invalid state choice');
    choices[id] = copyChoice(choice);
  }
  return { version: 1, choices, ...extraState(state) };
}

export function updateView(state, id, seconds, topic) {
  const key = idKey(id);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new RangeError('View time must be between 0 and 60 seconds');
  if (typeof topic !== 'string' || !topic.length || topic.length > 2048) throw new TypeError('Invalid topic');
  const next = copyState(state);
  next.views = { ...next.views, [key]: { seconds: Math.max(next.views?.[key]?.seconds || 0, seconds), topic } };
  return next;
}

export function updateSettings(state, changes) {
  const next = copyState(state);
  const requested = { ...settingsFor(state), ...changes };
  const normalized = settingsFor({ settings: requested });
  if (Object.keys(requested).some(key => requested[key] !== normalized[key])) throw new TypeError('Invalid mix setting');
  next.settings = normalized;
  return next;
}

export function viewWeight(state, id) {
  const settings = settingsFor(state);
  const fraction = Math.min(state.views?.[id]?.seconds || 0, settings.dwellCap) / settings.dwellCap;
  return 1 + fraction * (settings.maxWeight - 1);
}

function freshnessForChoice(choice, decayDays, now) {
  if (!choice?.personal) return 0;
  // Untimestamped in-memory choices remain fresh; parseState timestamps legacy storage.
  if (choice.updatedAt === undefined) return 1;
  return Math.max(0, 1 - Math.max(0, now - choice.updatedAt) / (decayDays * DAY_MS));
}

export function preferenceFreshness(state, id, now = Date.now()) {
  if (!isTimestamp(now)) throw new RangeError('Invalid preference timestamp');
  return freshnessForChoice(state.choices[idKey(id)], settingsFor(state).decayDays, now);
}

export function feedSignal(state, id, choice = state.choices[id], now = Date.now()) {
  if (!choice?.personal || choice.feed === 0) return 0;
  const { feeling } = settingsFor(state);
  const matches = feeling === 'both' || (feeling === 'like' && choice.reaction > 0) || (feeling === 'dislike' && choice.reaction < 0) || (feeling === 'neutral' && choice.reaction === 0);
  // An explicit Less answer always applies, regardless of the favored feeling.
  if (choice.feed > 0 && !matches) return 0;
  const freshness = freshnessForChoice(choice, settingsFor(state).decayDays, now);
  return freshness === 0 ? 0 : choice.feed * viewWeight(state, id) * freshness;
}

export function updatePersonal(state, id, reaction, feed, topic, now = Date.now()) {
  const key = idKey(id);
  if (!isRating(reaction) || !isRating(feed)) {
    throw new RangeError('Personal ratings must be finite numbers from -2 to 2');
  }
  if (topic !== undefined && (typeof topic !== 'string' || !topic.length || topic.length > 2048)) throw new TypeError('Invalid topic');
  if (!isTimestamp(now)) throw new RangeError('Invalid preference timestamp');
  const next = copyState(state);
  next.choices[key] = {
    reaction,
    feed,
    reach: next.choices[key]?.reach ?? null,
    personal: true,
    updatedAt: now,
    ...((topic ?? next.choices[key]?.topic) === undefined ? {} : { topic: topic ?? next.choices[key].topic }),
  };
  return next;
}

export function feedbackToPoint({ reaction, feed }) {
  if (!isRating(reaction) || !isRating(feed)) {
    throw new RangeError('Personal ratings must be finite numbers from -2 to 2');
  }
  const x = feed / 2;
  const y = reaction / 2;
  const radius = Math.hypot(x, y);
  if (radius === 0) return { x: 0, y: 0 };
  const scale = Math.max(Math.abs(x), Math.abs(y)) / radius;
  return { x: x * scale, y: y * scale };
}

export function pointToFeedback(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError('Point coordinates must be finite numbers');
  }
  const max = Math.max(Math.abs(x), Math.abs(y));
  if (max === 0) return { reaction: 0, feed: 0 };
  const radius = Math.min(Math.hypot(x, y), 1);
  return { reaction: 2 * (y / max) * radius, feed: 2 * (x / max) * radius };
}

export function updateReach(state, id, reach) {
  const key = idKey(id);
  if (!isReach(reach)) throw new TypeError('Reach must be yes, no, or null');
  const next = copyState(state);
  const previous = next.choices[key];
  next.choices[key] = {
    reaction: previous?.reaction ?? 0,
    feed: previous?.feed ?? 0,
    reach,
    personal: previous?.personal ?? false,
    ...(previous?.updatedAt === undefined ? {} : { updatedAt: previous.updatedAt }),
    ...(previous?.topic === undefined ? {} : { topic: previous.topic }),
  };
  return next;
}

export function rankPosts(posts, state = emptyState(), catalog = posts, now = Date.now()) {
  if (!Array.isArray(posts) || !Array.isArray(catalog)) {
    throw new TypeError('Posts and catalog must be arrays');
  }
  const validated = copyState(state);
  const { choices } = validated;
  const topicById = new Map();
  for (const post of catalog) {
    if (post && (typeof post.id === 'string' || typeof post.id === 'number')) {
      try {
        topicById.set(idKey(post.id), post.topic);
      } catch {
        // Unsafe ids cannot have saved choices.
      }
    }
  }

  const topicTotals = new Map();
  for (const [id, choice] of Object.entries(choices)) {
    if (!choice.personal) continue;
    const topic = choice.topic ?? topicById.get(id);
    if (topic === undefined) continue;
    const previous = topicTotals.get(topic) ?? { sum: 0, count: 0 };
    topicTotals.set(topic, { sum: previous.sum + feedSignal(validated, id, choice, now), count: previous.count + 1 });
  }

  return posts.map((post, index) => {
    if (!post || !Number.isFinite(post.baseScore)) {
      throw new TypeError('Each post must have a finite baseScore');
    }
    const total = topicTotals.get(post.topic);
    const topicPreference = total ? total.sum / total.count : 0;
    const adjustment = 20 * topicPreference;
    return { post: { ...post, adjustment, score: post.baseScore + adjustment, topicPreference }, index };
  }).sort((left, right) => right.post.score - left.post.score || left.index - right.index)
    .map(({ post }) => post);
}
