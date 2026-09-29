// Public, unauthenticated Bluesky discovery. The feed catalog is a sample, not
// a directory of every topic or post on the network.
const API = 'https://public.api.bsky.app/xrpc/';
const MAX_PAGES = 6;
const PAGE_SIZE = 100;
const REQUEST_SPACING_MS = 350;
const MAX_RETRY_AFTER_MS = 30_000;
const DID = 'did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]+(?:%3A[a-z0-9._~-]+)*)';
const FEED_URI = new RegExp(`^at://(${DID})/app\\.bsky\\.feed\\.generator/([A-Za-z0-9._~:-]{1,512})$`, 'i');
const POST_URI = new RegExp(`^at://(${DID})/app\\.bsky\\.feed\\.post/([A-Za-z0-9._~:-]{1,512})$`, 'i');
const TREND_LINK = new RegExp(`^/profile/(${DID})/feed/([A-Za-z0-9._~:-]{1,512})$`, 'i');
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const SEED_TOPICS = [
  { id: 'at://did:plc:jfhpnnst6flqway4eaeqzj2a/app.bsky.feed.generator/for-science', name: 'Science' },
  { id: 'at://did:plc:y7crv2yh74s7qhmtx3mvbgv5/app.bsky.feed.generator/art-new', name: 'Art' },
  { id: 'at://did:plc:5rw2on4i56btlcajojaxwcat/app.bsky.feed.generator/aaao6g552b33o', name: 'Gardening' },
  { id: 'at://did:plc:ffkgesg3jsv2j7aagkzrtcvt/app.bsky.feed.generator/aaagllxbcbsje', name: 'Birds' },
  { id: 'at://did:plc:geoqe3qls5mwezckxxsewys2/app.bsky.feed.generator/aaabrbjcg4hmk', name: 'Books' },
  { id: 'at://did:plc:4jrld6fwpnwqehtce56qshzv/app.bsky.feed.generator/game-dev', name: 'Game development' },
  { id: 'at://did:plc:jcoy7v3a2t4rcfdh6i4kza25/app.bsky.feed.generator/astro', name: 'Astronomy' },
  { id: 'at://did:plc:2hwwem55ce6djnk6bn62cstr/app.bsky.feed.generator/aaaotdzmoni2q', name: 'Film' },
  { id: 'at://did:plc:6brknehpd7ecbvd56ko6mhlm/app.bsky.feed.generator/aaaby3zazwhrq', name: 'History' },
  { id: 'at://did:plc:geoqe3qls5mwezckxxsewys2/app.bsky.feed.generator/aaai43yetqshu', name: 'Cooking' },
  { id: 'at://did:plc:lptjvw6ut224kwrj7ub3sqbe/app.bsky.feed.generator/aaaotfjzjplna', name: 'Urbanism' },
  { id: 'at://did:plc:66lbtw2porscqpmair6mir37/app.bsky.feed.generator/aaabkznpn5x2g', name: 'Environment' },
  { id: 'at://did:plc:ffkgesg3jsv2j7aagkzrtcvt/app.bsky.feed.generator/aaacjerk7gwek', name: 'Marine life' },
  { id: 'at://did:plc:abv47bjgzjgoh3yrygwoi36x/app.bsky.feed.generator/aaai4f7awwzkc', name: 'Writing' },
  { id: 'at://did:plc:hsqwcidfez66lwm3gxhfv5in/app.bsky.feed.generator/aaaf2pqeodmpy', name: 'Fungi' },
  { id: 'at://did:plc:yw3qqfa7hrhmwbc6wyrq5u7f/app.bsky.feed.generator/aaabqfmu2zuck', name: 'Economics' },
  { id: 'at://did:plc:gwk23pspkzx7ifoxvqvuab5q/app.bsky.feed.generator/aaakgoc6mcrr2', name: 'Ecology' },
  { id: 'at://did:plc:gkvpokm7ec5j5yxls6xk4e3z/app.bsky.feed.generator/formula-one', name: 'Formula 1' },
  { id: 'at://did:plc:nkahctfdi6bxk72umytfwghw/app.bsky.feed.generator/aaad2q353alqm', name: 'Fountain pens' },
  { id: 'at://did:plc:ffkgesg3jsv2j7aagkzrtcvt/app.bsky.feed.generator/aaaiq5xkfj2ec', name: 'Reptiles and amphibians' },
  { id: 'at://did:plc:4jb3re5tvklsvhuc3lkerj5q/app.bsky.feed.generator/aaak6p5s2f3cu', name: 'Academic research' },
  { id: 'at://did:plc:nmm26ltnxjx4oskwzdue4xvq/app.bsky.feed.generator/aaacoviie4ygo', name: 'Food' },
];

let activeRequests = 0;
const requestWaiters = [];
let paceQueue = Promise.resolve();
let nextRequestAt = 0;

async function acquireRequestSlot() {
  if (activeRequests < 2) {
    activeRequests += 1;
    return;
  }
  await new Promise((resolve) => requestWaiters.push(resolve));
}

function releaseRequestSlot() {
  const next = requestWaiters.shift();
  if (next) next();
  else activeRequests -= 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function paceRequest() {
  const turn = paceQueue.then(async () => {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait) await sleep(wait);
    nextRequestAt = Date.now() + REQUEST_SPACING_MS;
  });
  paceQueue = turn.catch(() => {});
  await turn;
}

function retryAfterMs(value) {
  if (typeof value !== 'string') return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function requestJson(method, params) {
  const url = new URL(method, API);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  await acquireRequestSlot();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await paceRequest();
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 429) {
        const wait = retryAfterMs(response.headers.get('retry-after'));
        if (attempt === 0 && wait !== null && wait <= MAX_RETRY_AFTER_MS) {
          await sleep(wait);
          continue;
        }
        throw new Error('Bluesky rate limit reached');
      }
      if (!response.ok) throw new Error(`Bluesky returned HTTP ${response.status}`);
      return response.json();
    }
  } finally {
    releaseRequestSlot();
  }
}

function positiveInteger(value, max, name) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

function parseFeedUri(id) {
  const match = typeof id === 'string' && FEED_URI.exec(id);
  return match && !['.', '..'].includes(match[2]) ? { did: match[1], rkey: match[2] } : null;
}

function parsePostUri(id) {
  const match = typeof id === 'string' && POST_URI.exec(id);
  return match && !['.', '..'].includes(match[2]) ? { did: match[1], rkey: match[2] } : null;
}

function safeCdnUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'cdn.bsky.app' &&
      !url.username && !url.password && !url.port && !url.hash && url.pathname.startsWith('/img/')
      ? value : null;
  } catch {
    return null;
  }
}

function isLabeled(value) {
  return Array.isArray(value?.labels) && value.labels.some((label) => !label || label.neg !== true);
}

function hasSelfLabels(record) {
  return Array.isArray(record?.labels?.values) && record.labels.values.length > 0;
}

function hasUnavailableEmbed(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return false;
  if (typeof value.$type === 'string' && /#view(?:Blocked|NotFound|Detached|Deleted)$/.test(value.$type)) return true;
  return Object.values(value).some((child) => hasUnavailableEmbed(child, depth + 1));
}

function initialsFor(name) {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const chars = words.length > 1 ? words.slice(0, 2).map((word) => [...word][0]) : [...(words[0] || '')].slice(0, 2);
  return chars.join('').toLocaleUpperCase();
}

function imagesFrom(embed) {
  const view = embed?.$type === 'app.bsky.embed.recordWithMedia#view' ? embed.media : embed;
  if (!Array.isArray(view?.images)) return [];
  return view.images.slice(0, 4).flatMap((image) => {
    const url = safeCdnUrl(image?.thumb) || safeCdnUrl(image?.fullsize);
    return url ? [{ url, alt: typeof image.alt === 'string' ? image.alt : '' }] : [];
  });
}

// Exported so normalization can be checked against untrusted API fixtures.
export function normalizeFeedItem(item, topic, fetchedAt = new Date().toISOString()) {
  if (!parseFeedUri(topic?.id) || typeof topic.name !== 'string' || !topic.name) return null;
  const post = item?.post;
  const parsed = parsePostUri(post?.uri);
  const author = post?.author;
  const record = post?.record;
  if (!parsed || author?.did !== parsed.did || record?.$type !== 'app.bsky.feed.post') return null;
  if (record.reply || isLabeled(post) || isLabeled(author) || hasSelfLabels(record) ||
      hasUnavailableEmbed(post.embed)) return null;
  if (typeof record.text !== 'string' || Buffer.byteLength(record.text, 'utf8') > 3000 ||
      [...graphemeSegmenter.segment(record.text)].length > 300) return null;
  if (typeof record.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(record.createdAt) ||
      !Number.isFinite(Date.parse(record.createdAt))) return null;
  const images = imagesFrom(post.embed);
  if (!record.text && images.length === 0) return null;
  const handle = typeof author.handle === 'string' ? author.handle : '';
  const displayName = typeof author.displayName === 'string' && author.displayName.trim() ? author.displayName : handle;
  if (!displayName) return null;
  return {
    id: post.uri,
    topic: topic.id,
    topicName: topic.name,
    author: displayName,
    handle,
    initials: initialsFor(displayName),
    createdAt: record.createdAt,
    body: record.text,
    title: '',
    sourceUrl: `https://bsky.app/profile/${parsed.did}/post/${parsed.rkey}`,
    avatar: safeCdnUrl(author.avatar),
    images,
    baseScore: 70,
    source: 'bluesky',
    fetchedAt,
  };
}

export async function discoverTopics({ query = '', cursor = '', limit = 50 } = {}) {
  positiveInteger(limit, 100, 'limit');
  if (typeof query !== 'string' || query.length > 200) throw new TypeError('query must be a short string');
  if (typeof cursor !== 'string' || cursor.length > 2048) throw new TypeError('cursor must be a short string');
  const term = query.trim();
  const catalog = await requestJson('app.bsky.unspecced.getPopularFeedGenerators', {
    limit, cursor, query: term,
  });
  if (!Array.isArray(catalog.feeds)) throw new Error('Invalid Bluesky feed catalog response');
  const topics = catalog.feeds.flatMap((feed) => {
    const parsed = parseFeedUri(feed?.uri);
    if (!parsed || isLabeled(feed)) return [];
    return [{
      id: feed.uri,
      name: typeof feed.displayName === 'string' && feed.displayName.trim() ? feed.displayName : parsed.rkey,
      description: typeof feed.description === 'string' ? feed.description : '',
      url: `https://bsky.app/profile/${parsed.did}/feed/${parsed.rkey}`,
      kind: 'feed',
    }];
  });
  let trends = [];
  if (!term && !cursor) {
    try {
      const data = await requestJson('app.bsky.unspecced.getTrendingTopics', { limit: 25 });
      trends = (Array.isArray(data.topics) ? data.topics : []).flatMap((trend) => {
        const match = typeof trend?.link === 'string' && TREND_LINK.exec(trend.link);
        if (!match || ['.', '..'].includes(match[2])) return [];
        return [{
          id: `at://${match[1]}/app.bsky.feed.generator/${match[2]}`,
          name: typeof trend.displayName === 'string' && trend.displayName.trim() ? trend.displayName : trend.topic,
          description: typeof trend.description === 'string' ? trend.description : '',
          url: `https://bsky.app${trend.link}`,
          kind: 'trend',
        }];
      }).filter((trend) => typeof trend.name === 'string' && trend.name.trim());
    } catch {
      // The popular feed catalog remains useful when the optional trends fail.
    }
  }
  return { topics, cursor: typeof catalog.cursor === 'string' && catalog.cursor ? catalog.cursor : null, trends };
}

export async function fetchTopicPosts(topic, { limit = 180 } = {}) {
  if (!parseFeedUri(topic?.id) || typeof topic.name !== 'string' || !topic.name) {
    throw new TypeError('topic must have a valid feed AT URI and name');
  }
  positiveInteger(limit, MAX_PAGES * PAGE_SIZE, 'limit');
  const posts = [];
  const seenPosts = new Set();
  const seenCursors = new Set();
  let cursor = '';
  let warning;
  for (let page = 0; page < MAX_PAGES && posts.length < limit; page += 1) {
    if (seenCursors.has(cursor)) { warning = `${topic.name}: repeated page cursor`; break; }
    seenCursors.add(cursor);
    let data;
    try {
      data = await requestJson('app.bsky.feed.getFeed', {
        feed: topic.id,
        limit: Math.min(PAGE_SIZE, limit - posts.length),
        cursor,
      });
    } catch (error) {
      warning = `${topic.name}: ${error.message}`;
      break;
    }
    if (!Array.isArray(data.feed)) { warning = `${topic.name}: invalid feed response`; break; }
    const fetchedAt = new Date().toISOString();
    for (const item of data.feed) {
      const post = normalizeFeedItem(item, topic, fetchedAt);
      if (post && !seenPosts.has(post.id)) {
        seenPosts.add(post.id);
        posts.push(post);
        if (posts.length >= limit) break;
      }
    }
    const nextCursor = typeof data.cursor === 'string' ? data.cursor : '';
    if (!nextCursor || data.feed.length === 0) break;
    if (seenCursors.has(nextCursor)) { warning = `${topic.name}: repeated page cursor`; break; }
    cursor = nextCursor;
    if (page === MAX_PAGES - 1 && posts.length < limit) warning = `${topic.name}: six-page limit reached`;
  }
  return warning ? { posts, warning } : { posts };
}

// Preserve a broad first screen when every real post begins at the same score.
export function assembleCatalog(results, fetchedAt = new Date().toISOString()) {
  // Some feeds pin old welcome posts. Start each topic with its newest posts.
  results = results.map(result => ({ ...result, posts: [...result.posts].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) }));
  const posts = [];
  const seen = new Set();
  const counts = new Map(results.map(({ topic }) => [topic.id, 0]));
  const longest = Math.max(0, ...results.map(({ posts: topicPosts }) => topicPosts.length));
  for (let index = 0; index < longest; index += 1) {
    for (const { topic, posts: topicPosts } of results) {
      const post = topicPosts[index];
      if (post && !seen.has(post.id)) {
        seen.add(post.id);
        posts.push(post);
        counts.set(topic.id, counts.get(topic.id) + 1);
      }
    }
  }
  return {
    version: 1,
    fetchedAt,
    posts,
    topics: results.map(({ topic }) => ({ id: topic.id, name: topic.name, count: counts.get(topic.id) })),
    coverage: 'sample',
  };
}

export async function fetchCatalog({ topics = SEED_TOPICS, perTopic = 180, onProgress = () => {} } = {}) {
  if (!Array.isArray(topics) || topics.length < 1 || topics.length > 30 ||
      topics.some((topic) => !parseFeedUri(topic?.id) || typeof topic.name !== 'string' || !topic.name) ||
      typeof onProgress !== 'function') {
    throw new TypeError('Provide 1 to 30 valid topics and a progress callback');
  }
  positiveInteger(perTopic, MAX_PAGES * PAGE_SIZE, 'perTopic');
  const uniqueTopics = [...new Map(topics.map((topic) => [topic.id, topic])).values()];
  const results = new Array(uniqueTopics.length);
  const warnings = [];
  const progressPosts = new Set();
  let completedTopics = 0;
  for (let index = 0; index < uniqueTopics.length; index += 2) {
    await Promise.all(uniqueTopics.slice(index, index + 2).map(async (topic, offset) => {
      const result = await fetchTopicPosts(topic, { limit: perTopic });
      results[index + offset] = { topic, posts: result.posts };
      if (result.warning) warnings.push(result.warning);
      for (const post of result.posts) progressPosts.add(post.id);
      completedTopics += 1;
      onProgress({ completedTopics, totalTopics: uniqueTopics.length, postCount: progressPosts.size, topicName: topic.name });
    }));
  }
  return { ...assembleCatalog(results), warnings };
}
