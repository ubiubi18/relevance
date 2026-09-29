import http from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTopics, fetchCatalog, SEED_TOPICS } from './bluesky.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const cachePath = resolve(root, 'bluesky-cache.json');
const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript' };
const staticFiles = new Set(['index.html', 'styles.css', 'app.mjs', 'core.mjs', 'data.mjs', 'dwell.mjs']);
const topicRegistry = new Map(SEED_TOPICS.map(topic => [topic.id, topic]));
const topicCache = new Map();
let catalog = { version: 1, fetchedAt: null, posts: [], topics: [], warnings: [], coverage: 'sample' };
try {
  const saved = JSON.parse(await readFile(cachePath, 'utf8'));
  if (saved.version === 1 && Array.isArray(saved.posts) && Array.isArray(saved.topics)) catalog = saved;
} catch (error) { if (error.code !== 'ENOENT') console.warn('Could not load the Bluesky snapshot. Fetch posts to rebuild it.'); }
for (const topic of catalog.topics) topicRegistry.set(topic.id, topic);
let job = { state: 'idle', completedTopics: 0, totalTopics: 0, postCount: 0 };
let lastRefresh = 0;

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 16000) throw new Error('Request too large');
  }
  return JSON.parse(text || '{}');
}

// Refresh replaces only the selected sources. Other cached topics stay available.
async function refresh(topics) {
  try {
    const batches = [];
    for (let offset = 0; offset < topics.length; offset += 30) {
      const priorCount = batches.reduce((sum, batch) => sum + batch.posts.length, 0);
      batches.push(await fetchCatalog({ topics: topics.slice(offset, offset + 30), perTopic: 220, onProgress: progress => {
        job = { ...job, ...progress, completedTopics: offset + progress.completedTopics, totalTopics: topics.length, postCount: priorCount + progress.postCount };
      } }));
    }
    const incoming = { ...batches[0], fetchedAt: new Date().toISOString(), posts: batches.flatMap(batch => batch.posts), warnings: batches.flatMap(batch => batch.warnings || []) };
    if (!incoming.posts.length) throw new Error(incoming.warnings?.[0] || 'No public posts were returned. The previous snapshot is still available.');
    const refreshed = new Set(incoming.posts.map(post => post.topic));
    const oldPosts = catalog.posts.filter(post => !refreshed.has(post.topic));
    const groups = new Map();
    const seen = new Set();
    for (const post of [...incoming.posts, ...oldPosts]) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      if (!groups.has(post.topic)) groups.set(post.topic, []);
      groups.get(post.topic).push(post);
    }
    const posts = [];
    for (const group of groups.values()) group.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    for (let index = 0; posts.length < 6000; index++) {
      let added = false;
      for (const group of groups.values()) if (group[index] && posts.length < 6000) { posts.push(group[index]); added = true; }
      if (!added) break;
    }
    const counts = new Map();
    for (const post of posts) counts.set(post.topic, (counts.get(post.topic) || 0) + 1);
    const next = {
      ...incoming, posts,
      topics: [...counts].map(([id, count]) => ({ id, name: topicRegistry.get(id)?.name || posts.find(post => post.topic === id).topicName, count }))
    };
    await writeFile(cachePath + '.tmp', JSON.stringify(next));
    await rename(cachePath + '.tmp', cachePath);
    catalog = next;
    job = { ...job, state: 'complete', postCount: posts.length, warnings: incoming.warnings || [] };
  } catch (error) {
    job = { ...job, state: 'error', error: error.message };
  }
}

const server = http.createServer(async (request, response) => {
  if (!hosts.has(request.headers.host)) { json(response, 403, { error: 'This demo is available on localhost only.' }); return; }
  try {
    const url = new URL(request.url, `http://localhost:${port}`);
    if (url.pathname === '/api/catalog' && request.method === 'GET') { json(response, 200, catalog); return; }
    if (url.pathname === '/api/refresh' && request.method === 'GET') { json(response, 200, job); return; }
    if (url.pathname === '/api/topics' && request.method === 'GET') {
      const query = (url.searchParams.get('query') || '').trim().slice(0, 100);
      const cursor = (url.searchParams.get('cursor') || '').slice(0, 1024);
      const key = JSON.stringify([query, cursor]);
      const cached = topicCache.get(key);
      if (cached && Date.now() - cached.at < 300000) { json(response, 200, cached.data); return; }
      const data = await discoverTopics({ query, cursor, limit: 50 });
      for (const topic of [...data.topics, ...(data.trends || [])]) topicRegistry.set(topic.id, topic);
      if (topicCache.size >= 50) topicCache.delete(topicCache.keys().next().value);
      topicCache.set(key, { at: Date.now(), data });
      json(response, 200, data);
      return;
    }
    if (url.pathname === '/api/refresh' && request.method === 'POST') {
      const origin = request.headers.origin;
      if (origin && ![...hosts].some(host => origin === `http://${host}`)) { json(response, 403, { error: 'Use the local demo to fetch posts.' }); return; }
      if (!request.headers['content-type']?.startsWith('application/json')) { json(response, 415, { error: 'Expected JSON.' }); return; }
      if (job.state === 'running') { json(response, 202, job); return; }
      if (Date.now() - lastRefresh < 15000) { json(response, 429, { error: 'Wait a few seconds before fetching again.' }); return; }
      let input;
      try { input = await body(request); } catch { json(response, 400, { error: 'Invalid refresh request.' }); return; }
      if (!input || typeof input !== 'object' || Array.isArray(input) || (input.topicIds !== undefined && (!Array.isArray(input.topicIds) || input.topicIds.length > 100 || input.topicIds.some(id => typeof id !== 'string' || !topicRegistry.has(id))))) {
        json(response, 400, { error: 'Choose topics from the Bluesky topic list.' }); return;
      }
      const topics = input.topicIds?.length
        ? [...new Set(input.topicIds)].map(id => topicRegistry.get(id))
        : (catalog.topics.length ? catalog.topics.map(topic => topicRegistry.get(topic.id)) : SEED_TOPICS);
      lastRefresh = Date.now();
      job = { state: 'running', completedTopics: 0, totalTopics: topics.length, postCount: 0 };
      void refresh(topics);
      json(response, 202, job);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    if (!staticFiles.has(file)) { response.writeHead(404).end('Not found'); return; }
    const data = await readFile(resolve(root, file));
    response.writeHead(200, {
      'Content-Type': `${types[extname(file)]}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.bsky.app; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch (error) {
    json(response, 502, { error: error.message || 'Bluesky is unavailable. Try again later.' });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Relevance is running at http://localhost:${port}`));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Run with PORT=4174 npm start.` : error.message); process.exitCode = 1; });
