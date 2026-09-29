import { STORAGE_KEY, emptyState, parseState, updatePersonal, updateReach, rankPosts, feedbackToPoint, pointToFeedback, snapFeedback, settingsFor, updateSettings, updateView, feedSignal } from './core.mjs';
import { posts as examplePosts, artwork } from './data.mjs';
import { createDwellTimer } from './dwell.mjs';

const $ = (id) => document.getElementById(id);
function reactionLabel(value) {
  if (value === 0) return 'I feel neutral';
  const feeling = value > 0 ? 'like' : 'dislike';
  return Math.abs(value) < 0.65 ? `I slightly ${feeling} it` : Math.abs(value) < 1.5 ? `I ${feeling} it` : `I really ${feeling} it`;
}
function feedLabel(value) {
  if (value === 0) return 'Keep the mix';
  const direction = value > 0 ? 'more' : 'less';
  return Math.abs(value) < 0.65 ? `A little ${direction}` : Math.abs(value) < 1.5 ? `${value > 0 ? 'More' : 'Less'} like this` : `Much ${direction} like this`;
}
const reachLabels = { yes: 'Yes', no: 'No', none: 'No vote' };
let state = emptyState();
let posts = [];
let catalog = { posts: [], topics: [], fetchedAt: null, warnings: [] };
let source = 'bluesky';
let topicFilter = '';
let searchQuery = '';
let currentId = null;
let visibleCount = 6;
let discoveryCursor = null;
let discoveryQuery = '';
let discoveryBusy = false;
let refreshBusy = false;
let draft = { reaction: 0, feed: 0 };
let undoState = null;
let undoPostId = null;
let undoResetsViews = false;
let history = [];
let seen = new Set();
let pointerId = null;
let pointerStart = null;
let pointerOffset = { x: 0, y: 0 };
let pointerPress = null;
let lastThumbTap = null;
let magneticCorner = null;
const heldKeys = new Set();
let savedPulse = null;

try {
  const stored = localStorage.getItem(STORAGE_KEY);
  state = parseState(stored);
  // Persist legacy timestamps once so reopening never restarts their fade.
  if (stored && JSON.stringify(state) !== stored) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
catch { storageWarning(); }

const dwellTimer = createDwellTimer({ capSeconds: settingsFor(state).dwellCap, onRecord: ({ id, seconds }) => {
  const post = posts.find(post => post.id === id);
  if (!post) return;
  state = updateView(state, id, seconds, post.topic);
  persist();
  renderView();
  if (feedSignal(state, id) !== 0) renderRecommendations();
} });

function tickDwell() {
  const content = $('post-content').getBoundingClientRect();
  const visibleHeight = Math.max(0, Math.min(content.bottom, innerHeight) - Math.max(content.top, 0));
  const visibleWidth = Math.max(0, Math.min(content.right, innerWidth) - Math.max(content.left, 0));
  const active = Boolean(currentId) && document.visibilityState === 'visible' && document.hasFocus() && content.height > 0 &&
    visibleHeight >= Math.min(content.height, innerHeight) / 2 && visibleWidth >= Math.min(content.width, innerWidth) / 2;
  dwellTimer.update({ id: currentId, active, now: performance.now(), previousSeconds: state.views?.[currentId]?.seconds || 0 });
}

function stopDwell() { dwellTimer.stop(performance.now()); }

function renderView() {
  const settings = settingsFor(state);
  const seconds = Math.min(state.views?.[currentId]?.seconds || 0, settings.dwellCap);
  $('view-time').textContent = `${seconds.toFixed(1)} / ${settings.dwellCap}s`;
  $('view-meter').max = settings.dwellCap;
  $('view-meter').value = seconds;
  $('view-status').textContent = seconds >= settings.dwellCap ? 'Capped' : '';
}

function renderSettings() {
  const settings = settingsFor(state);
  $('feeling-select').value = settings.feeling;
  $('dwell-cap').value = settings.dwellCap;
  $('max-weight').value = settings.maxWeight;
  $('decay-days').value = settings.decayDays;
  dwellTimer.setCap(settings.dwellCap, performance.now());
}

function storageWarning() {
  $('storage-status').textContent = 'Changes are kept only while this page is open.';
  $('storage-error').textContent = 'Browser storage is unavailable. Your choices still work, but may not survive a refresh.';
  $('storage-error').hidden = false;
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    $('storage-status').textContent = 'Saved on this device. Just for you.';
    $('storage-error').hidden = true;
    return true;
  } catch { storageWarning(); return false; }
}

function choice() { return state.choices[currentId] || { reaction: 0, feed: 0, reach: null, personal: false }; }
function currentPost() { return posts.find((post) => post.id === currentId); }
function filteredPosts() {
  const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return posts.filter(post => {
    if (topicFilter && post.topic !== topicFilter) return false;
    const text = [post.title, post.body, post.author, post.handle ? `@${post.handle}` : ''].join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
  });
}
function ranked() { return rankPosts(filteredPosts().filter(post => post.id !== currentId), state, posts); }
function formatNumber(value) { return Number.isInteger(value) ? String(value) : value.toFixed(1); }
function topicName(post) { return post.topicName || post.topic; }
function excerpt(post) { return post.title || post.body?.slice(0, 130) || 'Open this Bluesky post'; }
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function publicUrl(value, hostname) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === hostname && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}
function imageElement(value, alt = '') {
  const url = publicUrl(value, 'cdn.bsky.app');
  if (!url) return null;
  const image = node('img');
  image.src = url; image.alt = alt; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', () => { image.hidden = true; });
  return image;
}

function notify(message, previous) {
  undoState = previous;
  undoPostId = null;
  undoResetsViews = false;
  $('undo-response').hidden = true;
  $('toast-message').textContent = message;
  $('undo-action').hidden = !previous;
  $('toast').hidden = false;
}

function resetDraft() {
  magneticCorner = null;
  lastThumbTap = null;
  const saved = choice();
  draft = { reaction: saved.reaction, feed: saved.feed };
  renderPreview();
}

function renderPreview() {
  const reaction = reactionLabel(draft.reaction);
  const feed = feedLabel(draft.feed);
  const extent = ($('feedback-pad').clientWidth - $('feedback-thumb').offsetWidth - 8) / 2;
  const point = feedbackToPoint(draft);
  $('feedback-thumb').style.left = `calc(50% + ${point.x * extent}px)`;
  $('feedback-thumb').style.top = `calc(50% - ${point.y * extent}px)`;
  $('reaction-meter').style.width = `${Math.abs(draft.reaction) * 50}%`;
  $('feed-meter').style.width = `${Math.abs(draft.feed) * 50}%`;
  $('feedback-pad').classList.toggle('active', draft.feed !== 0 || draft.reaction !== 0);
  $('feedback-pad').classList.toggle('snapped', Math.abs(draft.reaction) === 2 && Math.abs(draft.feed) === 2);
  $('reaction-preview').textContent = (draft.reaction > 0 ? 'Like' : draft.reaction < 0 ? 'Dislike' : 'Neutral') + (Math.abs(draft.reaction) === 2 ? ' 100%' : '');
  $('feed-preview').textContent = (draft.feed > 0 ? 'More' : draft.feed < 0 ? 'Less' : 'Same mix') + (Math.abs(draft.feed) === 2 ? ' 100%' : '');
  $('reaction-symbol').textContent = draft.reaction > 0 ? '↑' : draft.reaction < 0 ? '↓' : '○';
  $('feed-symbol').textContent = draft.feed > 0 ? '→' : draft.feed < 0 ? '←' : '↔';
  $('reaction-range').value = draft.reaction;
  $('feed-range').value = draft.feed;
  $('reaction-range').setAttribute('aria-valuetext', `${reaction}, ${Math.round(Math.abs(draft.reaction) * 50)} percent strength`);
  $('feed-range').setAttribute('aria-valuetext', `${feed}, ${Math.round(Math.abs(draft.feed) * 50)} percent strength`);
  $('reaction-output').textContent = reaction;
  $('feed-output').textContent = feed;
  $('feedback-pad').setAttribute('aria-label', `Two-dimensional feedback: ${reaction}; ${feed}`);
  $('preview-label').textContent = pointerId !== null || heldKeys.size ? 'Release to set' : '';
}

function renderReach() {
  const reach = choice().reach || 'none';
  document.querySelector(`input[name="reach"][value="${reach}"]`).checked = true;
  $('reach-saved').textContent = `Wider reach · ${reachLabels[reach]}`;
  $('feedback-pad').classList.toggle('reach-yes', reach === 'yes');
  $('feedback-pad').title = choice().personal ? 'Double-click or double-tap for wider reach' : 'Slide and release to save';
}

function renderRecommendations(message) {
  const recommendations = ranked();
  $('recommendations').replaceChildren();
  for (const [index, post] of recommendations.slice(0, visibleCount).entries()) {
    const item = document.createElement('li');
    item.className = 'recommendation';
    item.dataset.postId = post.id;
    item.dataset.score = String(post.score);
    const button = document.createElement('button');
    const adjustment = `${post.adjustment >= 0 ? '+' : '−'}${formatNumber(Math.abs(post.adjustment))}`;
    const content = node('span', 'recommendation-content');
    content.append(node('span', 'recommendation-topic', `${String(index + 1).padStart(2, '0')}  ${topicName(post)}`), node('span', 'recommendation-title', excerpt(post)));
    const score = node('span', 'score-line');
    score.append(node('span', 'score-value', `${formatNumber(post.score)} pts`), node('span', '', `${post.baseScore} base`), node('span', `score-adjustment ${post.adjustment < 0 ? 'negative' : ''}`, `${adjustment} preference`));
    content.append(score);
    button.append(content);
    const art = node('span', 'recommendation-art');
    if (post.source === 'bluesky') {
      const image = imageElement(post.images?.[0]?.url || post.avatar, '');
      if (image) art.append(image);
      else art.append(node('span', 'thumbnail-initials', post.initials));
    } else art.innerHTML = artwork(post.art);
    button.append(art);
    button.setAttribute('aria-label', `View ${excerpt(post)} ${topicName(post)}. Score ${formatNumber(post.score)}: ${post.baseScore} base ${adjustment} preference.`);
    button.addEventListener('click', () => showPost(post.id));
    item.append(button);
    $('recommendations').append(item);
  }
  $('more-posts').hidden = recommendations.length <= visibleCount;
  const hasPreference = Object.values(state.choices).some((saved) => saved.personal && saved.feed !== 0);
  $('rank-status').textContent = message || (hasPreference ? 'Your mix reflects your saved feed preferences.' : 'The starting mix. Make it yours.');
}

function renderPost() {
  const post = currentPost();
  $('current-heading').textContent = searchQuery ? 'Search results' : 'In your feed';
  $('empty-feed').textContent = searchQuery ? 'No matching posts. Try another term or topic.' : 'No posts loaded yet. Fetch posts or choose another topic.';
  $('current-post').hidden = !post;
  $('empty-feed').hidden = Boolean(post);
  $('source-label').textContent = source === 'bluesky' ? 'Public Bluesky posts' : 'Fictional examples';
  renderSettings();
  renderView();
  if (!post) {
    $('post-counter').textContent = '0 posts';
    $('previous-post').disabled = true;
    $('next-post').disabled = true;
    renderRecommendations();
    return;
  }
  $('post-avatar').textContent = post.initials;
  const avatar = imageElement(post.avatar, '');
  if (avatar) $('post-avatar').replaceChildren(avatar);
  $('post-author').textContent = post.author;
  $('post-handle').textContent = post.handle ? `@${post.handle}` : '';
  $('post-topic').textContent = post.caption || topicName(post);
  $('post-time').textContent = post.createdAt ? new Date(post.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : post.time;
  $('post-art').replaceChildren();
  $('post-art').classList.toggle('real-media', post.source === 'bluesky');
  if (post.source === 'bluesky') {
    for (const media of post.images || []) {
      const image = imageElement(media.url, media.alt);
      if (image) $('post-art').append(image);
    }
  } else $('post-art').innerHTML = artwork(post.art);
  $('post-art').hidden = !$('post-art').childElementCount;
  $('post-title').textContent = post.title;
  $('post-title').hidden = !post.title;
  $('post-body').textContent = post.body || 'Open the original post to view its content.';
  $('post-body').classList.toggle('real-post-text', post.source === 'bluesky');
  const originalUrl = publicUrl(post.sourceUrl, 'bsky.app');
  $('original-post').hidden = !originalUrl;
  if (originalUrl) $('original-post').href = originalUrl;
  else $('original-post').removeAttribute('href');
  $('post-note').hidden = !post.note;
  $('post-note').textContent = post.note || '';
  $('post-counter').textContent = `${filteredPosts().length.toLocaleString()} posts`;
  $('previous-post').disabled = history.length === 0;
  $('next-post').disabled = !ranked().some((candidate) => !seen.has(candidate.id));
  renderReach();
  resetDraft();
  $('undo-response').hidden = !undoState || undoPostId !== currentId;
  renderRecommendations();
  tickDwell();
}

function showPost(id, fromHistory = false) {
  if (id === currentId) return;
  stopDwell();
  if (!fromHistory) history.push(currentId);
  currentId = id;
  seen.add(id);
  renderPost();
  $('current-post').focus({ preventScroll: true });
  $('current-heading').scrollIntoView({ behavior: 'instant', block: 'start' });
}

function savePersonal() {
  const previous = state;
  state = updatePersonal(state, currentId, draft.reaction, draft.feed, currentPost().topic);
  const stored = persist();
  renderReach();
  renderView();
  renderRecommendations();
  undoState = previous;
  undoPostId = currentId;
  undoResetsViews = false;
  $('undo-response').hidden = false;
  $('toast').hidden = true;
  showSaved(stored);
}

function showSaved(stored, message = '✓ Saved') {
  $('preview-label').textContent = stored ? message : 'Set for this session';
  savedPulse?.cancel();
  if (stored && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    savedPulse = $('feedback-pad').animate([
      { boxShadow: 'inset 0 3px 8px #4b365320, 0 0 0 0px #8f79b360' },
      { boxShadow: 'inset 0 3px 8px #4b365320, 0 0 0 7px #8f79b300' }
    ], { duration: 550, easing: 'ease-out' });
  }
}

function cancelDraft() {
  heldKeys.clear();
  if (pointerId !== null) cancelPointer({ pointerId });
  resetDraft();
}

function updatePointer(event) {
  if (Math.hypot(event.clientX - pointerPress.x, event.clientY - pointerPress.y) > 4) pointerPress.moved = true;
  if (pointerPress.onThumb && !pointerPress.moved) return;
  const bounds = $('feedback-pad').getBoundingClientRect();
  const extent = ($('feedback-pad').clientWidth - $('feedback-thumb').offsetWidth - 8) / 2;
  const raw = pointToFeedback(
    (event.clientX - pointerOffset.x - bounds.left - bounds.width / 2) / extent,
    (bounds.top + bounds.height / 2 - event.clientY + pointerOffset.y) / extent
  );
  draft = snapFeedback(raw, magneticCorner);
  magneticCorner = Math.abs(draft.reaction) === 2 && Math.abs(draft.feed) === 2 ? draft : null;
  renderPreview();
}

$('feedback-pad').addEventListener('pointerdown', (event) => {
  if (!event.isPrimary || event.button !== 0 || pointerId !== null) return;
  event.preventDefault();
  pointerId = event.pointerId;
  pointerStart = { ...draft };
  const thumb = $('feedback-thumb').getBoundingClientRect();
  const offsetX = event.clientX - thumb.left - thumb.width / 2;
  const offsetY = event.clientY - thumb.top - thumb.height / 2;
  const onThumb = Math.hypot(offsetX, offsetY) <= thumb.width / 2;
  pointerOffset = onThumb ? { x: offsetX, y: offsetY } : { x: 0, y: 0 };
  pointerPress = { x: event.clientX, y: event.clientY, at: performance.now(), onThumb, moved: false, hadPersonal: choice().personal, postId: currentId };
  magneticCorner = null;
  $('feedback-pad').focus({ preventScroll: true });
  $('feedback-pad').setPointerCapture(pointerId);
  $('feedback-pad').classList.add('dragging');
  updatePointer(event);
  renderPreview();
});
$('feedback-pad').addEventListener('pointermove', (event) => { if (event.pointerId === pointerId) updatePointer(event); });
$('feedback-pad').addEventListener('pointerup', (event) => {
  if (event.pointerId !== pointerId) return;
  updatePointer(event);
  const press = pointerPress;
  const tap = press.onThumb && !press.moved && performance.now() - press.at <= 350;
  pointerId = null;
  pointerStart = null;
  pointerPress = null;
  $('feedback-pad').classList.remove('dragging');
  if (tap && press.hadPersonal) {
    renderPreview();
    const now = performance.now();
    if (lastThumbTap && lastThumbTap.postId === currentId && now - lastThumbTap.at <= 400 &&
      Math.hypot(event.clientX - lastThumbTap.x, event.clientY - lastThumbTap.y) <= 16) {
      lastThumbTap = null;
      saveReach('yes', true);
    } else lastThumbTap = { at: now, x: event.clientX, y: event.clientY, postId: currentId };
    return;
  }
  lastThumbTap = null;
  savePersonal();
});
function cancelPointer(event) {
  if (event.pointerId !== pointerId) return;
  if (pointerStart) draft = pointerStart;
  pointerId = null;
  pointerStart = null;
  pointerPress = null;
  magneticCorner = null;
  lastThumbTap = null;
  $('feedback-pad').classList.remove('dragging');
  renderPreview();
}
$('feedback-pad').addEventListener('pointercancel', cancelPointer);
$('feedback-pad').addEventListener('lostpointercapture', cancelPointer);
$('feedback-pad').addEventListener('keydown', (event) => {
  lastThumbTap = null;
  const deltas = { ArrowUp: ['reaction', 0.1], ArrowDown: ['reaction', -0.1], ArrowRight: ['feed', 0.1], ArrowLeft: ['feed', -0.1] };
  if (deltas[event.key]) {
    event.preventDefault();
    heldKeys.add(event.key);
    const [axis, delta] = deltas[event.key];
    draft[axis] = Math.max(-2, Math.min(2, Number((draft[axis] + delta * (event.shiftKey ? 5 : 1)).toFixed(4))));
    renderPreview();
  } else if (event.key === 'Home') {
    event.preventDefault(); heldKeys.add(event.key); draft = { reaction: 0, feed: 0 }; renderPreview();
  } else if (event.key === 'Escape') {
    event.preventDefault(); cancelDraft();
  } else if (event.key === 'Enter' && !event.repeat && pointerId === null && !heldKeys.size && choice().personal) {
    event.preventDefault(); saveReach('yes', true);
  }
});
function finishKey(event) {
  if (!heldKeys.delete(event.key)) return;
  if (heldKeys.size === 0) savePersonal();
}
$('feedback-pad').addEventListener('keyup', finishKey);
$('feedback-pad').addEventListener('blur', () => { if (heldKeys.size) cancelDraft(); });
window.addEventListener('blur', () => { lastThumbTap = null; if (pointerId !== null || heldKeys.size) cancelDraft(); });
for (const axis of ['reaction', 'feed']) {
  const range = $(`${axis}-range`);
  range.addEventListener('input', (event) => { draft[axis] = Number(event.target.value); renderPreview(); });
  range.addEventListener('change', () => { if (heldKeys.size === 0) savePersonal(); });
  range.addEventListener('keydown', (event) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) heldKeys.add(event.key);
    else if (event.key === 'Escape') { event.preventDefault(); cancelDraft(); }
  });
  range.addEventListener('keyup', finishKey);
  range.addEventListener('blur', () => { if (heldKeys.size) cancelDraft(); });
}
function saveReach(reach, shortcut = false) {
  if (choice().reach === reach) return;
  const previous = state;
  state = updateReach(state, currentId, reach);
  const stored = persist();
  renderReach();
  if (shortcut) {
    undoState = previous;
    undoPostId = currentId;
    undoResetsViews = false;
    $('undo-response').hidden = false;
    $('toast').hidden = true;
    showSaved(stored, '✓ Wider reach');
  } else notify(`Wider reach: ${reachLabels[reach || 'none']}. Your feed is unchanged.`, previous);
}
document.querySelectorAll('input[name="reach"]').forEach((input) => input.addEventListener('change', () => saveReach(input.value === 'none' ? null : input.value)));
function undoLatest() {
  if (!undoState) return;
  stopDwell();
  state = undoResetsViews ? undoState : { ...undoState, ...(state.views ? { views: state.views } : {}) };
  undoState = null;
  persist();
  renderPost();
  notify('Undone. Your previous choices are restored.', null);
  $('feedback-pad').focus({ preventScroll: true });
}
$('undo-action').addEventListener('click', undoLatest);
$('undo-response').addEventListener('click', undoLatest);
$('dismiss-toast').addEventListener('click', () => { $('toast').hidden = true; });
$('next-post').addEventListener('click', () => { const next = ranked().find((post) => !seen.has(post.id)); if (next) showPost(next.id); });
$('previous-post').addEventListener('click', () => { const previous = history.pop(); if (previous) showPost(previous, true); });
$('reset-demo').addEventListener('click', () => {
  stopDwell();
  const previous = state;
  state = emptyState();
  currentId = filteredPosts()[0]?.id || null;
  history = [];
  seen = new Set([currentId]);
  persist();
  renderPost();
  notify('Demo reset. All choices cleared.', previous);
  undoResetsViews = true;
});
new ResizeObserver(renderPreview).observe($('feedback-pad'));

function catalogStatus() {
  const updated = catalog.fetchedAt ? new Date(catalog.fetchedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  $('catalog-status').textContent = source === 'demo' ? '9 fictional examples' : `${catalog.posts.length.toLocaleString()} public posts · ${catalog.topics.length} topics${updated ? ` · Fetched ${updated}` : ''}`;
  if (searchQuery) $('catalog-status').textContent = `${filteredPosts().length.toLocaleString()} matches · ${posts.length.toLocaleString()} loaded posts${topicFilter ? ' · In selected topic' : ''}`;
  $('catalog-provenance').textContent = source === 'demo'
    ? 'These nine example posts are fictional.'
    : `Public Bluesky snapshot${updated ? ` fetched ${updated}` : ''}. Topics follow their source feeds; this is a sample, not every post or topic on Bluesky. Posts carrying active labels are excluded from imports. Open the original for the current post and its full context.${catalog.warnings?.length ? ` ${catalog.warnings.length} source(s) returned a warning during the last fetch.` : ''}`;
  $('refresh-posts').disabled = refreshBusy || source !== 'bluesky';
}

function useSource(nextSource, nextTopic = '', keepCurrent = false) {
  stopDwell();
  if (pointerId !== null || heldKeys.size) cancelDraft();
  source = nextSource;
  posts = source === 'bluesky' ? catalog.posts : examplePosts;
  $('source-select').value = source;
  const topics = source === 'bluesky' ? catalog.topics : [...new Set(examplePosts.map(post => post.topic))].map(id => ({ id, name: id, count: examplePosts.filter(post => post.topic === id).length }));
  $('topic-select').replaceChildren(new Option('All topics', ''));
  for (const topic of topics) $('topic-select').append(new Option(`${topic.name} (${topic.count})`, topic.id));
  topicFilter = topics.some(topic => topic.id === nextTopic) ? nextTopic : '';
  $('topic-select').value = topicFilter;
  visibleCount = 6;
  const candidates = filteredPosts();
  if (!keepCurrent || !candidates.some(post => post.id === currentId)) {
    currentId = rankPosts(candidates, state, posts)[0]?.id || null;
    history = [];
    seen = new Set(currentId ? [currentId] : []);
  } else history = history.filter(id => candidates.some(post => post.id === id));
  catalogStatus();
  renderPost();
}

async function api(path, options) {
  const response = await fetch(path, options);
  let data;
  try { data = await response.json(); } catch { throw new Error('The local data server is unavailable. Restart npm start.'); }
  if (!response.ok) throw new Error(data.error || 'Could not fetch Bluesky data. Try again later.');
  return data;
}

async function loadCatalog(keepCurrent = true) {
  const next = await api('/api/catalog');
  if (!Array.isArray(next.posts) || !Array.isArray(next.topics)) throw new Error('The post snapshot is unavailable. Fetch fresh posts.');
  catalog = next;
  useSource(source, topicFilter, keepCurrent);
}

function addDiscoveredTopics(topics, trending = false) {
  for (const topic of topics) {
    if (!topic.id || !topic.name) continue;
    if ([...$('topic-results').children].some(button => button.dataset.topicId === topic.id)) continue;
    const button = node('button', `topic-result${trending ? ' trending' : ''}`);
    button.type = 'button';
    button.dataset.topicId = topic.id;
    button.append(node('span', '', topic.name), node('small', '', trending ? 'Trending · fetch posts ↗' : 'Fetch posts ↗'));
    button.title = topic.description || topic.name;
    button.setAttribute('aria-label', `Fetch public posts from ${topic.name}`);
    button.addEventListener('click', () => refreshPosts([topic.id]));
    button.disabled = refreshBusy;
    $('topic-results').append(button);
  }
}

async function discover(more = false) {
  if (discoveryBusy) return;
  discoveryBusy = true;
  $('more-topics').disabled = true;
  $('discovery-status').textContent = 'Fetching global feeds…';
  if (!more) {
    discoveryQuery = $('topic-search').value.trim();
    discoveryCursor = null;
    $('topic-results').replaceChildren();
  }
  try {
    const query = new URLSearchParams({ query: discoveryQuery });
    if (more && discoveryCursor) query.set('cursor', discoveryCursor);
    const data = await api(`/api/topics?${query}`);
    addDiscoveredTopics(data.trends || [], true);
    addDiscoveredTopics(data.topics || []);
    discoveryCursor = data.cursor || null;
    $('more-topics').hidden = !discoveryCursor;
    $('discovery-status').textContent = $('topic-results').childElementCount ? '' : 'No matching feeds. Try another topic.';
  } catch (error) {
    $('discovery-status').textContent = error.message;
  } finally {
    discoveryBusy = false;
    $('more-topics').disabled = false;
  }
}

function setFetchBusy(busy) {
  refreshBusy = busy;
  $('refresh-posts').disabled = busy || source !== 'bluesky';
  $('refresh-posts').textContent = busy ? 'Fetching…' : 'Fetch fresh posts ↻';
  for (const button of $('topic-results').children) button.disabled = busy;
}

async function refreshPosts(topicIds = []) {
  if (refreshBusy) return;
  setFetchBusy(true);
  try {
    let status = await api('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topicIds }) });
    while (status.state === 'running') {
      $('catalog-status').textContent = `Fetching ${status.completedTopics || 0}/${status.totalTopics} topics · ${(status.postCount || 0).toLocaleString()} posts`;
      await new Promise(resolve => setTimeout(resolve, 1500));
      status = await api('/api/refresh');
    }
    if (status.state !== 'complete') throw new Error(status.error || 'Fetch stopped. Your previous posts are still available.');
    const next = await api('/api/catalog');
    catalog = next;
    useSource('bluesky', topicIds.length === 1 ? topicIds[0] : topicFilter, true);
    if (status.warnings?.length) $('catalog-status').textContent += ' · Some feeds returned partial results';
    $('topic-browser').hidden = true;
    $('browse-topics').setAttribute('aria-expanded', 'false');
  } catch (error) {
    $('catalog-status').textContent = error.message;
  } finally { setFetchBusy(false); }
}

$('source-select').addEventListener('change', event => useSource(event.target.value));
$('topic-select').addEventListener('change', event => useSource(source, event.target.value));
function searchPosts() {
  searchQuery = $('post-search').value.trim();
  $('clear-search').hidden = !$('post-search').value;
  useSource(source, topicFilter);
}
$('post-search').addEventListener('input', searchPosts);
$('post-search-form').addEventListener('submit', event => { event.preventDefault(); searchPosts(); });
$('clear-search').addEventListener('click', () => {
  $('post-search').value = '';
  searchPosts();
  $('post-search').focus();
});
$('more-posts').addEventListener('click', () => { visibleCount += 12; renderRecommendations(); });
$('refresh-posts').addEventListener('click', () => refreshPosts(topicFilter ? [topicFilter] : []));
$('browse-topics').addEventListener('click', () => {
  const open = $('topic-browser').hidden;
  $('topic-browser').hidden = !open;
  $('browse-topics').setAttribute('aria-expanded', String(open));
  if (open && !$('topic-results').childElementCount) void discover();
});
$('topic-search-form').addEventListener('submit', event => { event.preventDefault(); void discover(); });
$('global-topics').addEventListener('click', () => { $('topic-search').value = ''; void discover(); });
$('more-topics').addEventListener('click', () => discover(true));
for (const [id, key] of [['feeling-select', 'feeling'], ['dwell-cap', 'dwellCap'], ['max-weight', 'maxWeight'], ['decay-days', 'decayDays']]) {
  $(id).addEventListener('change', event => {
    if (!event.target.checkValidity()) { renderSettings(); return; }
    stopDwell();
    const previous = state;
    state = updateSettings(state, { [key]: key === 'feeling' ? event.target.value : Number(event.target.value) });
    persist();
    renderSettings();
    renderView();
    renderRecommendations();
    notify('Mix updated.', previous);
    tickDwell();
  });
}
window.addEventListener('scroll', tickDwell, { passive: true });
window.addEventListener('resize', tickDwell);
function refreshAging() {
  if (document.visibilityState !== 'visible') return;
  renderView();
  renderRecommendations();
}
window.addEventListener('focus', () => { tickDwell(); refreshAging(); });
window.addEventListener('blur', stopDwell);
window.addEventListener('pagehide', stopDwell);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { tickDwell(); refreshAging(); }
  else stopDwell();
});
setInterval(tickDwell, 250);
setInterval(refreshAging, 60000);
renderPost();
loadCatalog(false).catch(error => { $('catalog-status').textContent = error.message; });
