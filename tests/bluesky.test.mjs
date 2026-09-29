import test from 'node:test';
import assert from 'node:assert/strict';
import { SEED_TOPICS, normalizeFeedItem, assembleCatalog, fetchTopicPosts } from '../bluesky.mjs';

// These invented records exercise the parser only. The shipped cache is fetched
// separately from the public API and is never inferred from these fixtures.
const topic = SEED_TOPICS[0];
const did = 'did:plc:5522ztebtekoor5efelihqhb';
const uri = `at://${did}/app.bsky.feed.post/3mwnelwh65j2z`;
const fetchedAt = '2026-09-29T10:00:00.000Z';

function fixture() {
  return {
    post: {
      uri,
      author: {
        did,
        handle: 'research.bsky.social',
        displayName: 'Research Lab',
        avatar: `https://cdn.bsky.app/img/avatar/plain/${did}/abc`,
        labels: [],
      },
      record: {
        $type: 'app.bsky.feed.post',
        text: '<img src=x onerror=alert(1)> & real text',
        createdAt: '2026-09-29T09:00:00.000Z',
      },
      embed: {
        $type: 'app.bsky.embed.images#view',
        images: [{ thumb: `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/abc`, alt: '<b>literal alt</b>' }],
      },
      labels: [],
    },
  };
}

test('normalization keeps original content and verifiable provenance', () => {
  const post = normalizeFeedItem(fixture(), topic, fetchedAt);
  assert.equal(post.id, uri);
  assert.equal(post.topic, topic.id);
  assert.equal(post.topicName, 'Science');
  assert.equal(post.body, '<img src=x onerror=alert(1)> & real text');
  assert.equal(post.title, '');
  assert.equal(post.createdAt, '2026-09-29T09:00:00.000Z');
  assert.equal(post.sourceUrl, `https://bsky.app/profile/${did}/post/3mwnelwh65j2z`);
  assert.equal(post.images[0].alt, '<b>literal alt</b>');
  assert.equal(post.baseScore, 70);
  assert.equal(post.fetchedAt, fetchedAt);
  assert.equal(post.source, 'bluesky');
});

test('normalization rejects off-domain media and unavailable embeds', () => {
  const item = fixture();
  item.post.author.avatar = 'https://cdn.bsky.app.evil.example/img/avatar/a';
  item.post.embed.images[0].thumb = 'https://cdn.bsky.app.evil.example/img/feed/a';
  item.post.embed.images[0].fullsize = 'http://cdn.bsky.app/img/feed/a';
  const post = normalizeFeedItem(item, topic, fetchedAt);
  assert.equal(post.avatar, null);
  assert.deepEqual(post.images, []);

  item.post.embed = { $type: 'app.bsky.embed.record#view', record: { $type: 'app.bsky.embed.record#viewBlocked' } };
  assert.equal(normalizeFeedItem(item, topic, fetchedAt), null);
});

test('normalization excludes labeled posts and authors, replies, and overlong text', () => {
  const item = fixture();
  item.post.labels = [{ val: 'porn' }];
  assert.equal(normalizeFeedItem(item, topic, fetchedAt), null);
  item.post.labels = [{ val: 'porn', neg: true }];
  assert.ok(normalizeFeedItem(item, topic, fetchedAt));
  item.post.author.labels = [{ val: 'spam' }];
  assert.equal(normalizeFeedItem(item, topic, fetchedAt), null);
  item.post.author.labels = [];
  item.post.record.labels = { values: [{ val: 'sexual' }] };
  assert.equal(normalizeFeedItem(item, topic, fetchedAt), null);
  delete item.post.record.labels;
  item.post.record.reply = { parent: {}, root: {} };
  assert.equal(normalizeFeedItem(item, topic, fetchedAt), null);
  delete item.post.record.reply;
  item.post.record.text = 'a'.repeat(301);
  assert.equal(normalizeFeedItem(item, topic, fetchedAt), null);
});

test('feed and post identities must be valid AT URIs', async () => {
  const item = fixture();
  item.post.uri = 'https://attacker.example/post/1';
  assert.equal(normalizeFeedItem(item, topic, fetchedAt), null);
  item.post.uri = uri;
  assert.equal(normalizeFeedItem(item, { id: 'https://attacker.example/feed', name: 'Bad' }, fetchedAt), null);
  await assert.rejects(fetchTopicPosts({ id: 'at://did:plc:5522ztebtekoor5efelihqhb/app.bsky.feed.generator/../evil', name: 'Bad' }), TypeError);
});

test('catalog deduplicates by post URI and interleaves topics', () => {
  const second = SEED_TOPICS[1];
  const make = (id, sourceTopic) => ({ id, topic: sourceTopic.id });
  const catalog = assembleCatalog([
    { topic, posts: [make('a', topic), make('b', topic), make('c', topic)] },
    { topic: second, posts: [make('x', second), make('a', second), make('y', second)] },
  ], fetchedAt);
  assert.deepEqual(catalog.posts.map(({ id }) => id), ['a', 'x', 'b', 'c', 'y']);
  assert.deepEqual(catalog.topics.map(({ count }) => count), [3, 2]);
  assert.equal(catalog.coverage, 'sample');
});

test('old pinned source posts do not precede recent topic posts', () => {
  const posts = [
    { id: 'welcome', topic: topic.id, createdAt: '2023-01-01T00:00:00Z' },
    { id: 'recent', topic: topic.id, createdAt: '2026-09-29T00:00:00Z' },
  ];
  assert.deepEqual(assembleCatalog([{ topic, posts }]).posts.map(post => post.id), ['recent', 'welcome']);
  assert.equal(posts[0].id, 'welcome');
});
