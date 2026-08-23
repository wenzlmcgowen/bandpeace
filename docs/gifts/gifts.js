const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const STORE_KEY = 'bandpeace:gifts:v3';
const LEGACY_KEYS = ['bandpeace:gifts:v2', 'bandpeace:gifts:v1'];
const state = loadState();
let projects = [];

function loadState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)); } catch {}
  for (const key of LEGACY_KEYS) {
    if (saved) break;
    try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
  }
  return normalizeState(saved || {});
}
function normalizeState(raw) {
  return {
    follows: raw.follows || {},
    comments: raw.comments || {},
    gifts: raw.gifts || {},
    likedComments: raw.likedComments || {},
    views: raw.views || {},
  };
}
function saveState() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function avatar(handle, initials) {
  return `<span class="avatar" aria-label="Demo profile @${esc(handle)}">${esc(initials || String(handle).slice(0,2).toUpperCase())}</span>`;
}
function mergedDonors(project) { return [...project.donors, ...(state.gifts[project.id] || [])]; }
function sortedDonors(project) { return mergedDonors(project).sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0)); }
function baseComments(project) { return project.comments.map((comment, index) => normalizeComment(comment, `${project.id}-seed-${index}`)); }
function localComments(project) { return (state.comments[project.id] || []).map((comment, index) => normalizeComment(comment, `${project.id}-local-${index}`)); }
function mergedComments(project) {
  const byId = new Map(baseComments(project).map(comment => [comment.id, comment]));
  for (const comment of localComments(project)) {
    if (byId.has(comment.id)) {
      const existing = byId.get(comment.id);
      existing.replies = mergeReplies(existing.replies, comment.replies);
      existing.likes = Math.max(existing.likes, comment.likes);
    } else {
      byId.set(comment.id, comment);
    }
  }
  return [...byId.values()].sort(commentRank);
}
function mergeReplies(base, extra) {
  const byId = new Map(base.map(reply => [reply.id, reply]));
  for (const reply of extra) byId.set(reply.id, reply);
  return [...byId.values()];
}
function totalRaised(project) { return project.raised + (state.gifts[project.id] || []).reduce((sum, gift) => sum + Number(gift.amount || 0), 0); }
function normalizeComment(comment, fallbackId) {
  return {
    id: comment.id || fallbackId,
    name: comment.name || comment.handle || 'Friend',
    handle: String(comment.handle || comment.name || 'friend').replace(/^@/, ''),
    text: comment.text || '',
    likes: Number(comment.likes || 0),
    replies: (comment.replies || []).map((reply, index) => normalizeReply(reply, `${fallbackId}-reply-${index}`)),
    avatar: comment.avatar,
  };
}
function normalizeReply(reply, fallbackId) {
  return {
    id: reply.id || fallbackId,
    name: reply.name || reply.handle || 'Friend',
    handle: String(reply.handle || reply.name || 'friend').replace(/^@/, ''),
    text: reply.text || '',
    likes: Number(reply.likes || 0),
    avatar: reply.avatar,
  };
}
function commentRank(a, b) {
  const scoreA = displayedLikes(a) + a.replies.reduce((sum, reply) => sum + displayedLikes(reply), 0) * 0.25;
  const scoreB = displayedLikes(b) + b.replies.reduce((sum, reply) => sum + displayedLikes(reply), 0) * 0.25;
  return scoreB - scoreA;
}
function displayedLikes(item) { return item.likes + (state.likedComments[item.id] ? 1 : 0); }
function activeView(projectId) { return state.views[projectId] || 'money'; }

async function init() {
  const res = await fetch('data.json');
  if (!res.ok) throw new Error('Could not load Gifts data');
  projects = (await res.json()).projects;
  render();
  wireSubmitDialog();
}

function render() {
  document.querySelector('#project-list').innerHTML = projects.map(renderProject).join('');
  wireProjectActions();
  renderStats();
}

function renderStats() {
  const raised = projects.reduce((sum, p) => sum + totalRaised(p), 0);
  const donors = projects.reduce((sum, p) => sum + mergedDonors(p).length, 0);
  const follows = Object.values(state.follows).filter(Boolean).length;
  document.querySelector('#stat-projects').textContent = projects.length;
  document.querySelector('#stat-raised').textContent = money.format(raised);
  document.querySelector('#stat-donors').textContent = donors;
  document.querySelector('#stat-follows').textContent = follows;
}

function renderProject(project) {
  const raised = totalRaised(project);
  const pct = Math.min(100, Math.round((raised / project.goal) * 100));
  return `<article class="project-card glass" id="${esc(project.id)}">
    <div>
      <p class="kicker">${esc(project.artist)}</p>
      <h3 class="display-h">${esc(project.title)}</h3>
      <div class="project-meta"><span class="pill">${esc(project.location)}</span><span class="pill">${esc(project.category)}</span><span class="pill">${pct}% funded</span></div>
      <p class="project-summary">${esc(project.summary)}</p>
      <ul class="impact-list">${project.impact.map(item => `<li>${esc(item)}</li>`).join('')}</ul>
      <div class="progress-wrap" aria-label="${esc(project.title)} funding progress">
        <div class="progress-label"><span>${money.format(raised)} raised</span><span>${money.format(project.goal)} goal</span></div>
        <div class="progress"><span style="width:${pct}%"></span></div>
      </div>
      <form class="donor-form" data-gift-form="${esc(project.id)}">
        <div class="inline-form">
          <input name="name" required placeholder="Your name">
          <input name="handle" required placeholder="Public handle">
          <input name="amount" required type="number" min="1" step="1" placeholder="Amount">
          <input name="note" placeholder="Co-sign">
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Back this</button></div>
      </form>
      <p class="demo-line small-demo">Demo only: gifts stay in this browser. Real payout rails come next.</p>
      <p class="demo-line small-demo">No cash today? Co-sign it or signal boost — both help the drop move.</p>
    </div>
    <aside class="feed-panel">
      ${renderViewTabs(project)}
      ${renderActivePanel(project)}
    </aside>
  </article>`;
}

function renderViewTabs(project) {
  const view = activeView(project.id);
  const tabs = [
    ['money', 'Backers'],
    ['crew', 'Co-signs'],
    ['proof', 'Receipts'],
  ];
  return `<div class="view-tabs" role="tablist" aria-label="${esc(project.title)} views">
    ${tabs.map(([id, label]) => `<button type="button" role="tab" class="view-tab ${view === id ? 'is-active' : ''}" data-view="${id}" data-project-view="${esc(project.id)}" aria-selected="${view === id}">${label}</button>`).join('')}
  </div>`;
}

function renderActivePanel(project) {
  const view = activeView(project.id);
  if (view === 'crew') return renderCrewPanel(project);
  if (view === 'proof') return renderProofPanel(project);
  return renderMoneyPanel(project);
}

function renderMoneyPanel(project) {
  const donors = sortedDonors(project);
  return `<section class="view-panel">
    <div class="panel-title"><span>Backers</span><span>${donors.length}</span></div>
    <p class="thread-note">Recent backers show who pulled up. Amounts stay off the wall by default.</p>
    <div class="donor-list">${donors.map(renderDonor).join('')}</div>
  </section>`;
}
function renderCrewPanel(project) {
  const comments = mergedComments(project);
  const commentCount = comments.reduce((sum, comment) => sum + 1 + comment.replies.length, 0);
  return `<section class="view-panel">
    <div class="panel-title"><span>Co-signs</span><span>${commentCount}</span></div>
    <p class="thread-note">Co-signs, plugs, offers, and signal boosts count here too.</p>
    <div class="comment-list">${comments.map(comment => renderCommentThread(project.id, comment)).join('')}</div>
    <form class="comment-form" data-comment-form="${esc(project.id)}">
      <input name="handle" required placeholder="Your public handle">
      <textarea name="text" required placeholder="Co-sign, offer help, drop a contact, or signal boost."></textarea>
      <div class="form-actions"><button class="btn btn-ghost" type="submit">Co-sign</button></div>
    </form>
  </section>`;
}
function renderProofPanel(project) {
  return `<section class="view-panel proof-panel">
    <div class="panel-title"><span>Receipts</span><span>demo</span></div>
    <div class="proof-card"><strong>Need</strong><p>${esc(project.need)}</p></div>
    <div class="proof-card"><strong>What backing unlocks</strong><ul>${project.impact.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>
    <div class="proof-card"><strong>Receipts path</strong><p>${esc(project.proof)}</p></div>
    <div class="proof-card"><strong>Updates</strong><ul>${(project.updates || []).map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>
  </section>`;
}

function renderDonor(donor) {
  const handle = String(donor.handle || 'demo_friend').replace(/^@/, '');
  const following = Boolean(state.follows[handle]);
  return `<div class="person-row">
    ${avatar(handle, donor.avatar)}
    <div class="person-main"><span>${esc(donor.name)}</span><div class="handle">@${esc(handle)} · backed this</div><p class="note">${esc(donor.note || 'Backed quietly.')}</p></div>
    <button class="follow-btn ${following ? 'is-following' : ''}" type="button" data-follow="${esc(handle)}">${following ? 'Co-signed' : 'Co-sign'}</button>
  </div>`;
}

function renderCommentThread(projectId, comment) {
  return `<article class="comment-thread" data-comment-id="${esc(comment.id)}">
    ${renderCommentBody(comment, 'comment')}
    <div class="reply-list">${comment.replies.map(reply => renderCommentBody(reply, 'reply')).join('')}</div>
    <form class="reply-form" data-reply-form="${esc(projectId)}" data-parent-id="${esc(comment.id)}">
      <input name="handle" required placeholder="Reply as @handle">
      <input name="text" required placeholder="Reply to @${esc(comment.handle)}">
      <button type="submit">Reply</button>
    </form>
  </article>`;
}

function renderCommentBody(item, kind) {
  const handle = String(item.handle || 'friend').replace(/^@/, '');
  const liked = Boolean(state.likedComments[item.id]);
  return `<div class="comment-row ${kind === 'reply' ? 'is-reply' : ''}">
    ${avatar(handle, item.avatar || handle.slice(0,2).toUpperCase())}
    <div class="comment-main"><span>${esc(item.name || handle)}</span><span class="comment-inline-text"> ${esc(item.text)}</span><div class="comment-actions"><button class="like-btn ${liked ? 'is-liked' : ''}" type="button" data-like-comment="${esc(item.id)}">${liked ? '♥' : '♡'} ${displayedLikes(item)}</button><span>${kind === 'reply' ? 'reply' : 'comment'}</span></div></div>
  </div>`;
}

function wireProjectActions() {
  document.querySelectorAll('[data-project-view]').forEach(btn => btn.addEventListener('click', () => {
    state.views[btn.dataset.projectView] = btn.dataset.view;
    saveState(); render();
  }));
  document.querySelectorAll('[data-follow]').forEach(btn => btn.addEventListener('click', () => {
    const handle = btn.dataset.follow;
    state.follows[handle] = !state.follows[handle];
    saveState(); render();
    toast(state.follows[handle] ? `Co-signed @${handle} in this demo.` : `Removed co-sign for @${handle} in this demo.`);
  }));
  document.querySelectorAll('[data-like-comment]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.likeComment;
    state.likedComments[id] = !state.likedComments[id];
    saveState(); render();
    toast(state.likedComments[id] ? 'Liked. This co-sign may move up.' : 'Like removed.');
  }));
  document.querySelectorAll('[data-comment-form]').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    const projectId = form.dataset.commentForm;
    const data = Object.fromEntries(new FormData(form));
    const handle = String(data.handle || '').replace(/^@/, '').trim();
    const text = String(data.text || '').trim();
    if (!handle || !text) return;
    state.comments[projectId] ||= [];
    state.comments[projectId].push({ id: `${projectId}-local-${Date.now()}`, name: handle, handle, text, likes: 0, replies: [] });
    saveState(); render(); toast('Co-sign added in this browser.');
  }));
  document.querySelectorAll('[data-reply-form]').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    const projectId = form.dataset.replyForm;
    const parentId = form.dataset.parentId;
    const data = Object.fromEntries(new FormData(form));
    const handle = String(data.handle || '').replace(/^@/, '').trim();
    const text = String(data.text || '').trim();
    if (!handle || !text) return;
    addReply(projectId, parentId, { id: `${parentId}-reply-${Date.now()}`, name: handle, handle, text, likes: 0 });
    saveState(); render(); toast('Reply added to the thread.');
  }));
  document.querySelectorAll('[data-gift-form]').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    const projectId = form.dataset.giftForm;
    const data = Object.fromEntries(new FormData(form));
    const amount = Math.max(1, Math.round(Number(data.amount || 0)));
    const handle = String(data.handle || '').replace(/^@/, '').trim();
    if (!data.name || !handle || !amount) return;
    state.gifts[projectId] ||= [];
    state.gifts[projectId].push({ name: String(data.name).trim(), handle, amount, note: String(data.note || 'Backed quietly.').trim(), avatar: initials(data.name) });
    saveState(); render(); toast(`Simulated ${money.format(amount)} backing from @${handle}.`);
  }));
}

function addReply(projectId, parentId, reply) {
  state.comments[projectId] ||= [];
  let localParent = state.comments[projectId].find(comment => comment.id === parentId);
  if (!localParent) {
    const seedProject = projects.find(project => project.id === projectId);
    const seedParent = seedProject ? baseComments(seedProject).find(comment => comment.id === parentId) : null;
    if (!seedParent) return;
    localParent = { ...seedParent, replies: [...seedParent.replies] };
    state.comments[projectId].push(localParent);
  }
  localParent.replies ||= [];
  localParent.replies.push(reply);
}

function initials(name) {
  return String(name).split(/\s+/).filter(Boolean).slice(0,2).map(part => part[0]).join('').toUpperCase() || 'BP';
}
function wireSubmitDialog() {
  const dialog = document.querySelector('#submit-dialog');
  document.querySelector('[data-open-submit]').addEventListener('click', () => dialog.showModal());
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'preview') toast('Project intake saved as a demo preview. Real listing needs payout + moderation checks.');
  });
}
function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 2800);
}

init().catch(err => {
  console.error(err);
  document.querySelector('#project-list').innerHTML = '<p class="glass load-error">Could not load the Gifts demo yet.</p>';
});
