import { RoomClient, newToken, newId } from './net.js';
import { Scene } from './scene.js';
import { randomLook, sanitizeLook, drawPreview, drawIcon, EMOTES, SHIRTS, HAIR_STYLES, HAIR_COLORS, SKINS, ACCESSORIES } from './sprites.js';
import { DECK, computeStats, label } from './stats.js';
import { play, isMuted, setMuted } from './audio.js';

const $ = (sel) => document.querySelector(sel);
const STALE_MS = 130_000; // presence older than this is a ghost
const HEARTBEAT_MS = 20_000;
const HOST_GRACE_MS = 5_000; // let a refreshing host come back before someone else takes over
const MAX_HISTORY = 30;

// ---------- storage (never trusted to exist) ----------

const store = {
  get(area, key, fallback = null) {
    try {
      const v = window[area].getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(area, key, value) {
    try {
      window[area].setItem(key, JSON.stringify(value));
    } catch {
      /* private mode or blocked storage */
    }
  },
};

// ---------- identity ----------

// A duplicated tab copies sessionStorage, so ask other tabs whether our id is taken.
async function resolveMyId() {
  let id = store.get('sessionStorage', 'sop.id');
  if (!id) id = newId();
  if ('BroadcastChannel' in window) {
    const bc = new BroadcastChannel('sop-id');
    const taken = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 150);
      bc.onmessage = (e) => {
        if (e.data?.type === 'taken' && e.data.id === id) {
          clearTimeout(t);
          resolve(true);
        }
      };
      bc.postMessage({ type: 'who', id });
    });
    if (taken) id = newId();
    bc.onmessage = (e) => {
      if (e.data?.type === 'who' && e.data.id === state.me.id) bc.postMessage({ type: 'taken', id: state.me.id });
    };
  }
  store.set('sessionStorage', 'sop.id', id);
  return id;
}

const state = {
  me: { id: null, name: '', look: null, spectator: false, joinedAt: 0 },
  token: null,
  rc: null,
  room: null,
  peers: new Map(),
  myVote: null,
  myRound: null,
  myPick: 0,
  ready: false,
  hostMissingSince: 0,
  scene: null,
  lastThrow: 0,
  recentlyGone: new Map(),
};

function parseHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const r = h.get('r');
  return r && /^[A-Za-z0-9_-]{12,32}$/.test(r) ? { token: r } : null;
}

// ============================================================
// LOBBY
// ============================================================

const LOOK_PARTS = [
  { key: 'hair', label: 'Hair', n: HAIR_STYLES.length },
  { key: 'hairColor', label: 'Color', n: HAIR_COLORS.length },
  { key: 'skin', label: 'Skin', n: SKINS.length },
  { key: 'shirt', label: 'Top', n: SHIRTS.length },
  { key: 'acc', label: 'Extra', n: ACCESSORIES.length },
];

let lobbyRaf = 0;

function initLobby() {
  const invite = parseHash();
  // the tab's own copy wins, so two tabs on one machine keep their own seat on reload
  state.me.name = store.get('sessionStorage', 'sop.name') ?? store.get('localStorage', 'sop.name', '');
  state.me.look = sanitizeLook(store.get('sessionStorage', 'sop.look') || store.get('localStorage', 'sop.look') || randomLook());
  state.me.spectator = !!store.get('localStorage', 'sop.spectator', false);

  $('#name').value = state.me.name;
  $('#spectator').checked = state.me.spectator;
  $('#room-name').value = '';
  setLobbyMode(invite ? 'join' : 'create');

  const controls = $('#look-controls');
  controls.innerHTML = '';
  for (const part of LOOK_PARTS) {
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'btn';
    prev.textContent = '<';
    prev.setAttribute('aria-label', `Previous ${part.label}`);
    const name = document.createElement('span');
    name.textContent = part.label;
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn';
    next.textContent = '>';
    next.setAttribute('aria-label', `Next ${part.label}`);
    const step = (d) => {
      state.me.look[part.key] = (state.me.look[part.key] + d + part.n) % part.n;
      store.set('localStorage', 'sop.look', state.me.look);
      play('pick');
    };
    prev.onclick = () => step(-1);
    next.onclick = () => step(1);
    controls.append(prev, name, next);
  }
  $('#reroll').onclick = () => {
    state.me.look = randomLook();
    store.set('localStorage', 'sop.look', state.me.look);
    play('pick');
  };
  $('#create-instead').onclick = () => {
    history.replaceState(null, '', location.pathname);
    setLobbyMode('create');
  };
  $('#lobby-form').onsubmit = onEnter;

  const canvas = $('#avatar');
  const poses = ['think', 'scribble', 'voted', 'reveal'];
  const start = performance.now();
  cancelAnimationFrame(lobbyRaf);
  const tick = (t) => {
    const pose = poses[Math.floor((t - start) / 2200) % poses.length];
    drawPreview(canvas, state.me.look, t, $('#spectator').checked ? 'spectator' : pose, (t - start) % 2200);
    lobbyRaf = requestAnimationFrame(tick);
  };
  lobbyRaf = requestAnimationFrame(tick);
}

function setLobbyMode(mode) {
  const join = mode === 'join';
  $('#join-info').hidden = !join;
  $('#room-name-field').hidden = join;
  $('#create-instead').hidden = !join;
  $('#enter-btn').textContent = join ? 'Join room' : 'Create room';
  $('#lobby-error').hidden = true;
}

async function onEnter(e) {
  e.preventDefault();
  const name = $('#name').value.trim().replace(/\s+/g, ' ').slice(0, 20);
  if (!name) return $('#name').focus();
  state.me.name = name;
  state.me.spectator = $('#spectator').checked;
  store.set('localStorage', 'sop.name', name);
  store.set('sessionStorage', 'sop.name', name);
  store.set('localStorage', 'sop.look', state.me.look);
  store.set('sessionStorage', 'sop.look', state.me.look);
  store.set('localStorage', 'sop.spectator', state.me.spectator);

  const btn = $('#enter-btn');
  const err = $('#lobby-error');
  btn.disabled = true;
  err.hidden = true;
  const invite = parseHash();
  const idle = btn.textContent;
  btn.textContent = 'Connecting...';
  try {
    play('pick');
    state.token = invite ? invite.token : newToken();
    const rc = new RoomClient({ token: state.token, myId: state.me.id });
    await rc.init();
    await rc.connect();
    if (!invite) history.replaceState(null, '', `#r=${state.token}`);
    await enterRoom(rc, invite ? { creating: false } : { creating: true, roomName: $('#room-name').value.trim().slice(0, 40) || 'Planning room' });
  } catch (ex) {
    console.error('Failed to connect to the planning room', { token: state.token, error: ex });
    err.textContent = 'Could not reach the relay. Check your connection and try again.';
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = idle;
  }
}

// ============================================================
// ROOM
// ============================================================

async function enterRoom(rc, { creating, roomName }) {
  cancelAnimationFrame(lobbyRaf);
  state.rc = rc;
  state.peers.clear();
  state.room = null;
  state.ready = false;

  const joinedKey = `sop.joined.${state.token}`;
  state.me.joinedAt = store.get('sessionStorage', joinedKey) || Date.now();
  store.set('sessionStorage', joinedKey, state.me.joinedAt);

  const saved = store.get('sessionStorage', `sop.vote.${state.token}`);
  if (saved) {
    state.myVote = saved.vote;
    state.myRound = saved.round;
    state.myPick = saved.pick || 0;
  }

  $('#lobby').hidden = true;
  $('#room').hidden = false;

  if (!state.scene) {
    state.scene = new Scene($('#stage'), { onSeatClick: throwAt });
    buildHand();
    buildEmotes();
    wireRoomControls();
  }

  rc.addEventListener('presence', (e) => onPresence(e.detail));
  rc.addEventListener('presence-gone', (e) => onPresenceGone(e.detail.id));
  rc.addEventListener('room', (e) => onRoom(e.detail));
  rc.addEventListener('event', (e) => onEvent(e.detail));
  rc.addEventListener('status', (e) => {
    $('#conn').className = `conn ${e.detail}`;
    $('#conn').title = e.detail === 'online' ? `Connected to ${rc.online.size} relay${rc.online.size === 1 ? '' : 's'}` : 'Reconnecting...';
  });
  // a relay that (re)connects gets our seat, and the room if we run it
  rc.addEventListener('broker-online', (e) => {
    publishPresence(e.detail);
    if (amHost() && state.room) rc.publishRoom(state.room, e.detail);
  });
  $('#conn').className = 'conn online';

  if (creating) {
    state.room = { v: 1, seq: 1, name: roomName, hostId: state.me.id, round: 1, revealed: false, topic: '', timerEnd: null, autoReveal: false, history: [], createdAt: Date.now() };
    rc.publishRoom(state.room);
    state.ready = true;
  } else {
    // retained room state and seats arrive right after subscribing
    setTimeout(() => {
      state.ready = true;
      checkHost();
      render();
    }, 1800);
  }

  publishPresence();
  play('join');
  render();

  clearInterval(state.heartbeat);
  state.heartbeat = setInterval(() => {
    publishPresence();
    prunePeers();
  }, HEARTBEAT_MS);
  clearInterval(state.ticker);
  state.ticker = setInterval(tickSecond, 1000);
}

function allPlayers() {
  const me = {
    ...state.me,
    isMe: true,
    voted: !state.me.spectator && !!state.myVote && state.room != null && state.myRound === state.room.round,
    vote: state.room?.revealed && state.myRound === state.room.round ? state.myVote : null,
    pick: state.myPick,
    away: document.hidden,
  };
  const list = [me];
  for (const p of state.peers.values()) {
    const sameRound = state.room && p.round === state.room.round;
    list.push({ ...p, voted: sameRound && p.voted && !p.spectator, vote: sameRound && state.room.revealed ? p.vote : null, isMe: false });
  }
  const hostId = effectiveHostId(list);
  list.forEach((p) => (p.isHost = p.id === hostId));
  return list.sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
}

function effectiveHostId(list = allPlayers()) {
  if (state.room && list.some((p) => p.id === state.room.hostId)) return state.room.hostId;
  if (!state.ready) return state.room?.hostId ?? null;
  const sorted = [...list].sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
  return sorted[0]?.id ?? null;
}

function amHost() {
  return state.room != null && state.room.hostId === state.me.id;
}

function checkHost() {
  if (!state.ready) return;
  const list = allPlayers();
  if (!state.room) {
    // empty room with no state at all (relay forgot it): start fresh
    if (effectiveHostId(list) === state.me.id) {
      updateRoom({ v: 1, name: 'Planning room', hostId: state.me.id, round: 1, revealed: false, topic: '', timerEnd: null, autoReveal: false, history: [], createdAt: Date.now() });
    }
    return;
  }
  const hostHere = list.some((p) => p.id === state.room.hostId);
  if (hostHere) {
    state.hostMissingSince = 0;
    return;
  }
  if (!state.hostMissingSince) state.hostMissingSince = Date.now();
  if (Date.now() - state.hostMissingSince < HOST_GRACE_MS) return;
  if (effectiveHostId(list) === state.me.id) {
    updateRoom({ ...state.room, hostId: state.me.id });
    toast('The host left. You are the host now.');
  }
}

function updateRoom(next) {
  // seq orders updates across host hand-overs without trusting anyone's clock
  state.room = { ...next, seq: (state.room?.seq || 0) + 1 };
  state.rc.publishRoom(state.room);
  render();
}

function publishPresence(only) {
  if (!state.rc) return;
  const room = state.room;
  const myRoundActive = room && state.myRound === room.round;
  state.rc.publishPresence({
    id: state.me.id,
    name: state.me.name,
    look: state.me.look,
    spectator: state.me.spectator,
    joinedAt: state.me.joinedAt,
    ts: Date.now(),
    round: room?.round ?? 0,
    voted: !!(myRoundActive && state.myVote && !state.me.spectator),
    // the value only leaves this browser once the host has revealed the round
    vote: myRoundActive && room.revealed && !state.me.spectator ? state.myVote : null,
    pick: state.myPick,
    away: document.hidden,
  }, only);
}

function sanitizePresence(d) {
  if (!d || typeof d.id !== 'string' || typeof d.name !== 'string') return null;
  return {
    id: d.id.slice(0, 16),
    name: d.name.trim().slice(0, 20) || 'Anonymous',
    look: sanitizeLook(d.look),
    spectator: !!d.spectator,
    joinedAt: Number.isFinite(d.joinedAt) ? d.joinedAt : Date.now(),
    ts: Number.isFinite(d.ts) ? d.ts : 0,
    round: Number.isInteger(d.round) ? d.round : 0,
    voted: !!d.voted,
    vote: DECK.includes(d.vote) ? d.vote : null,
    pick: Number.isInteger(d.pick) ? d.pick : 0,
    away: !!d.away,
  };
}

function onPresence(raw) {
  const p = sanitizePresence(raw);
  if (!p || p.id === state.me.id) return;
  if (Date.now() - p.ts > STALE_MS) return;
  const known = state.peers.has(p.id);
  const prev = state.peers.get(p.id);
  state.peers.set(p.id, { ...p, seenAt: Date.now() });
  const back = state.recentlyGone.get(p.id);
  state.recentlyGone.delete(p.id);
  // a reload looks like leave + join; keep that quiet
  if (!known && state.ready && !(back && Date.now() - back < 15_000)) {
    play('join');
    toast(`${p.name} pulled up a chair`);
  } else if (prev && p.pick !== prev.pick && p.voted && !state.room?.revealed) {
    play('scribble');
  }
  maybeAutoReveal();
  render();
}

function onPresenceGone(id) {
  const p = state.peers.get(id);
  if (!p) return;
  state.peers.delete(id);
  state.recentlyGone.set(id, Date.now());
  setTimeout(() => {
    if (state.peers.has(id)) return;
    play('leave');
    toast(`${p.name} left the table`);
  }, 4000);
  render();
}

function prunePeers() {
  const now = Date.now();
  let changed = false;
  for (const [id, p] of state.peers) {
    if (now - p.seenAt > STALE_MS) {
      state.peers.delete(id);
      changed = true;
    }
  }
  if (changed) render();
}

function sanitizeRoom(d) {
  if (!d || typeof d.hostId !== 'string' || !Number.isInteger(d.round)) return null;
  return {
    v: 1,
    name: typeof d.name === 'string' ? d.name.slice(0, 40) : 'Planning room',
    hostId: d.hostId,
    round: d.round,
    revealed: !!d.revealed,
    topic: typeof d.topic === 'string' ? d.topic.slice(0, 120) : '',
    timerEnd: Number.isFinite(d.timerEnd) ? d.timerEnd : null,
    autoReveal: !!d.autoReveal,
    history: Array.isArray(d.history) ? d.history.slice(-MAX_HISTORY).filter((h) => h && typeof h === 'object') : [],
    createdAt: d.createdAt,
    seq: Number.isInteger(d.seq) ? d.seq : 0,
  };
}

function onRoom(raw) {
  const next = sanitizeRoom(raw);
  if (!next) return;
  const prev = state.room;
  // ignore anything older than what we already hold (our own echo included)
  if (prev && next.seq < prev.seq) return;
  state.room = next;

  if (prev && next.round !== prev.round) {
    play('round');
    state.myVote = null;
    state.myRound = next.round;
    saveVote();
  }
  if (prev && next.revealed && !prev.revealed) play('reveal');
  if (prev && prev.hostId !== next.hostId) {
    const host = allPlayers().find((p) => p.id === next.hostId);
    if (next.hostId === state.me.id) toast('You are the host now');
    else if (host) toast(`${host.name} is the host now`);
  }
  if (!prev || prev.revealed !== next.revealed || prev.round !== next.round) publishPresence();
  render();
}

function onEvent(e) {
  if (!e || typeof e.from !== 'string' || e.from === state.me.id || !state.peers.has(e.from)) return;
  if (e.type === 'throw' && typeof e.to === 'string') {
    state.scene.throwBall(e.from, e.to);
    play('throw');
    if (e.to === state.me.id) {
      setTimeout(() => {
        play('hit');
        toast(`${state.peers.get(e.from)?.name || 'Someone'} hit you with a paper ball`);
      }, 700);
    }
  } else if (e.type === 'emote' && EMOTES.includes(e.icon)) {
    state.scene.emote(e.from, e.icon);
    play('emote');
  }
}

function tickSecond() {
  checkHost();
  const room = state.room;
  if (!room || room.revealed || !room.timerEnd) return;
  const left = Math.ceil((room.timerEnd - Date.now()) / 1000);
  if (left > 0 && left <= 5) play('tick');
  if (left <= 0 && amHost()) reveal();
  renderStatus();
}

function maybeAutoReveal() {
  const room = state.room;
  if (!room || room.revealed || !room.autoReveal || !amHost()) return;
  const voters = allPlayers().filter((p) => !p.spectator);
  // no timer here: a host tab in the background gets its timers throttled, messages still arrive
  if (voters.length && voters.every((p) => p.voted)) reveal();
}

// ---------- actions ----------

function saveVote() {
  store.set('sessionStorage', `sop.vote.${state.token}`, { vote: state.myVote, round: state.myRound, pick: state.myPick });
}

function pickCard(value) {
  const room = state.room;
  if (!room || room.revealed || state.me.spectator) return;
  if (state.myVote === value && state.myRound === room.round) {
    state.myVote = null; // tap again to take the card back
  } else {
    state.myVote = value;
    play('scribble');
  }
  state.myRound = room.round;
  state.myPick += 1;
  saveVote();
  publishPresence();
  maybeAutoReveal();
  render();
}

function reveal() {
  if (!amHost() || state.room.revealed) return;
  updateRoom({ ...state.room, revealed: true, timerEnd: null });
  play('reveal');
  publishPresence();
}

function nextRound() {
  if (!amHost()) return;
  const room = state.room;
  const history = [...room.history];
  if (room.revealed) {
    const votes = allPlayers().filter((p) => p.vote != null);
    const s = computeStats(votes);
    history.push({
      round: room.round,
      topic: room.topic,
      average: s.average,
      suggested: s.suggested,
      consensus: s.consensus,
      votes: votes.map((v) => [v.name, v.vote]),
      at: Date.now(),
    });
  }
  state.myVote = null;
  state.myRound = room.round + 1;
  saveVote();
  updateRoom({ ...room, round: room.round + 1, revealed: false, topic: '', timerEnd: null, history: history.slice(-MAX_HISTORY) });
  $('#story-input').value = '';
  play('round');
  publishPresence();
}

function setTimer(sec) {
  if (!amHost() || state.room.revealed) return;
  updateRoom({ ...state.room, timerEnd: sec ? Date.now() + sec * 1000 : null });
}

function makeHost(id) {
  if (!amHost()) return;
  updateRoom({ ...state.room, hostId: id });
  toast(`${state.peers.get(id)?.name || 'They'} is the host now`);
}

function throwAt(id) {
  if (id === state.me.id || !state.peers.has(id)) return;
  const now = Date.now();
  if (now - state.lastThrow < 600) return;
  state.lastThrow = now;
  state.scene.throwBall(state.me.id, id);
  play('throw');
  state.rc.sendEvent({ type: 'throw', from: state.me.id, to: id });
}

function sendEmote(icon) {
  state.scene.emote(state.me.id, icon);
  play('emote');
  state.rc.sendEvent({ type: 'emote', from: state.me.id, icon });
}

async function leaveRoom() {
  try {
    sessionStorage.removeItem(`sop.joined.${state.token}`);
    sessionStorage.removeItem(`sop.vote.${state.token}`);
  } catch {
    /* ignore */
  }
  clearInterval(state.heartbeat);
  clearInterval(state.ticker);
  try {
    await state.rc?.leave();
  } catch (e) {
    console.error('Failed to leave the room cleanly', { token: state.token, error: e });
  }
  history.replaceState(null, '', location.pathname);
  location.reload();
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    window.prompt('Copy this:', text);
  }
}

function historyText() {
  const lines = (state.room?.history || []).map((h) => {
    const votes = (h.votes || []).map(([n, v]) => `${n} ${label(v)}`).join(', ');
    return `Round ${h.round}${h.topic ? ` - ${h.topic}` : ''}: avg ${h.average ?? '-'}, suggested ${h.suggested ?? '-'}${h.consensus ? ' (consensus)' : ''} [${votes}]`;
  });
  return `${state.room?.name || 'Planning'} - ${new Date().toISOString().slice(0, 10)}\n${lines.join('\n') || 'No rounds yet'}`;
}

// ---------- wiring ----------

function buildHand() {
  const hand = $('#hand');
  hand.innerHTML = '';
  for (const v of DECK) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'card';
    b.dataset.value = v;
    if (v === 'coffee') {
      const c = document.createElement('canvas');
      c.width = 8;
      c.height = 8;
      drawIcon(c.getContext('2d'), 'coffee', 0, 0);
      b.append(c);
      b.setAttribute('aria-label', 'Coffee break');
      b.title = 'I need a break';
    } else {
      b.textContent = label(v);
      if (label(v).length >= 3) b.classList.add('card-small');
      b.setAttribute('aria-label', v === '?' ? 'Not sure' : `${label(v)} points`);
    }
    b.onclick = () => pickCard(v);
    hand.append(b);
  }
}

function buildEmotes() {
  const box = $('#emotes');
  box.innerHTML = '';
  for (const icon of EMOTES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn emote-btn';
    b.setAttribute('aria-label', `React: ${icon}`);
    b.title = icon;
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 8;
    drawIcon(c.getContext('2d'), icon, icon === 'coffee' ? 0 : 0.5, icon === 'coffee' ? 0 : 0.5);
    b.append(c);
    b.onclick = () => sendEmote(icon);
    box.append(b);
  }
}

function wireRoomControls() {
  $('#invite').onclick = () => copyText(location.href, 'Invite link copied. Paste it in the team chat.');
  $('#leave').onclick = leaveRoom;
  $('#reveal').onclick = reveal;
  $('#next').onclick = nextRound;
  $('#copy-history').onclick = () => copyText(historyText(), 'Summary copied');
  $('#mute').onclick = () => {
    setMuted(!isMuted());
    renderMute();
  };
  renderMute();
  document.querySelectorAll('[data-timer]').forEach((b) => (b.onclick = () => setTimer(Number(b.dataset.timer))));
  $('#auto-reveal').onchange = (e) => {
    if (amHost()) {
      updateRoom({ ...state.room, autoReveal: e.target.checked });
      maybeAutoReveal();
    }
  };
  let storyTimer = 0;
  const commitStory = (value) => {
    clearTimeout(storyTimer);
    const topic = value.trim().slice(0, 120);
    if (amHost() && topic !== state.room.topic) updateRoom({ ...state.room, topic });
  };
  $('#story-input').oninput = (e) => {
    // read the value now: a re-render may rewrite the field before the timer fires
    const value = e.target.value;
    clearTimeout(storyTimer);
    storyTimer = setTimeout(() => commitStory(value), 350);
  };
  $('#story-input').onblur = (e) => commitStory(e.target.value);
  $('#story-input').onkeydown = (e) => {
    if (e.key === 'Enter') e.target.blur();
  };
  document.addEventListener('visibilitychange', () => {
    publishPresence();
    render();
  });
  window.addEventListener('pagehide', () => state.rc?.leave());
  // back/forward cache restores a page whose relay sockets are already closed
  window.addEventListener('pageshow', (e) => e.persisted && location.reload());
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const map = { 0: '0', 1: '1', 2: '2', 3: '3', 5: '5', 8: '8', '?': '?', c: 'coffee' };
    if (map[e.key]) pickCard(map[e.key]);
  });
}

function renderMute() {
  const b = $('#mute');
  b.innerHTML = '';
  const c = document.createElement('canvas');
  c.width = 9;
  c.height = 7;
  c.style.cssText = 'width:27px;height:21px;image-rendering:pixelated';
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#bdc5d0';
  ctx.fillRect(0, 2, 2, 3);
  ctx.fillRect(2, 1, 1, 5);
  ctx.fillRect(3, 0, 1, 7);
  if (isMuted()) {
    ctx.fillStyle = '#ff552a';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(5 + i, 1.5 + i, 1, 1);
      ctx.fillRect(8 - i, 1.5 + i, 1, 1);
    }
  } else {
    ctx.fillStyle = '#00d0bf';
    ctx.fillRect(5, 2, 1, 3);
    ctx.fillRect(7, 1, 1, 5);
  }
  b.append(c);
  b.title = isMuted() ? 'Sound off' : 'Sound on';
}

// ============================================================
// RENDER
// ============================================================

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 2700);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
}

function renderStatus() {
  const room = state.room;
  const players = allPlayers();
  const voters = players.filter((p) => !p.spectator);
  const voted = voters.filter((p) => p.voted).length;
  const host = players.find((p) => p.isHost);
  const line = $('#status-line');
  line.textContent = '';
  const b = document.createElement('b');
  if (!room) {
    line.textContent = 'Finding the table...';
    return;
  }
  if (room.revealed) {
    b.textContent = 'Votes are up!';
    line.append(b, amHost() ? ' Start a new round when ready.' : ` Waiting for ${host?.name || 'the host'} to start a new round.`);
  } else {
    b.textContent = `${voted}/${voters.length}`;
    line.append(b, ' voted');
    if (room.timerEnd) {
      const left = Math.max(0, Math.ceil((room.timerEnd - Date.now()) / 1000));
      line.append(` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`);
    }
    if (!amHost() && host) line.append(` · ${host.name} reveals`);
  }
}

function render() {
  const room = state.room;
  const players = allPlayers();
  const host = amHost();

  $('#room-title').textContent = room?.name || 'Planning room';
  document.title = `${room?.name || 'Planning'} · SentryOT Poker`;
  $('#round-no').textContent = room?.round ?? '-';
  const story = $('#story-text');
  story.textContent = room?.topic || (host ? 'Type the story below so everyone knows what we are sizing' : 'Waiting for the host to name the story');
  story.classList.toggle('is-empty', !room?.topic);
  renderStatus();

  // host bar
  $('#host-bar').hidden = !host;
  $('#host-actions').hidden = !host;
  if (host) {
    $('#reveal').hidden = room.revealed;
    $('#next').classList.toggle('btn-primary', room.revealed);
  }
  if (host) {
    const input = $('#story-input');
    if (document.activeElement !== input) input.value = room.topic || '';
    $('#auto-reveal').checked = !!room.autoReveal;
    document.querySelectorAll('[data-timer]').forEach((b) => {
      b.disabled = room.revealed;
      b.classList.toggle('is-active', b.dataset.timer === '0' ? !room.timerEnd : false);
    });
  }

  // hand
  const canVote = room && !room.revealed && !state.me.spectator;
  document.querySelectorAll('#hand .card').forEach((c) => {
    c.disabled = !canVote;
    c.classList.toggle('is-selected', !!room && state.myRound === room.round && c.dataset.value === state.myVote);
  });
  $('#hand').hidden = state.me.spectator;

  // scene
  const revealedVotes = players.filter((p) => p.vote != null);
  const stats = computeStats(revealedVotes);
  const allIn = players.filter((p) => p.voted).every((p) => p.vote != null);
  state.scene.setRoom({ revealed: !!room?.revealed, consensus: !!room?.revealed && allIn && stats.consensus, timerEnd: room?.timerEnd });
  state.scene.setPlayers(players);

  renderPlayers(players, host);
  renderResults(room, stats, allIn);
  renderHistory(room);
}

function renderPlayers(players, host) {
  const ul = $('#player-list');
  ul.innerHTML = '';
  $('#table-count').textContent = `(${players.length})`;
  for (const p of players) {
    const li = document.createElement('li');
    li.classList.toggle('is-me', p.isMe);
    const dot = document.createElement('span');
    dot.className = 'p-dot';
    dot.style.background = SHIRTS[p.look.shirt];
    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = p.isMe ? `${p.name} (you)` : p.name;
    li.append(dot, name);
    if (p.isHost) {
      const crown = document.createElement('span');
      crown.className = 'p-crown';
      crown.textContent = 'HOST';
      li.append(crown);
    }
    const st = document.createElement('span');
    st.className = 'p-state';
    if (p.spectator) st.textContent = 'watching';
    else if (state.room?.revealed) {
      if (p.vote != null) {
        st.textContent = p.vote === 'coffee' ? 'coffee' : label(p.vote);
        st.classList.add('is-value');
      } else st.textContent = p.voted ? '...' : 'no vote';
    } else if (p.voted) {
      st.textContent = 'ready';
      st.classList.add('is-voted');
    } else st.textContent = p.away ? 'away' : 'thinking';
    li.append(st);
    if (host && !p.isMe) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-small';
      b.textContent = 'Make host';
      b.onclick = () => makeHost(p.id);
      li.append(b);
    }
    ul.append(li);
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderResults(room, s, allIn) {
  const box = $('#results');
  const show = !!room?.revealed;
  const key = show ? JSON.stringify([room.round, s]) : '';
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.hidden = !show;
  if (!show) return;
  box.innerHTML = '';
  box.append(el('h2', null, 'Results'));
  if (!s.total) {
    box.append(el('div', 'res-note', allIn ? 'Nobody voted this round.' : 'Collecting votes...'));
    return;
  }
  const top = el('div', 'res-top');
  const t1 = el('div', 'res-tile is-main');
  t1.append(el('span', 'k', 'Average'), el('span', 'v', s.average ?? '-'));
  const t2 = el('div', 'res-tile');
  t2.append(el('span', 'k', 'Suggested'), el('span', 'v', s.suggested != null ? label(String(s.suggested)) : '-'));
  top.append(t1, t2);
  box.append(top);

  const row = (k, v) => {
    const r = el('div', 'res-row');
    r.append(el('span', null, k), el('b', null, v));
    return r;
  };
  if (s.median != null) box.append(row('Median', label(String(s.median))));
  if (s.min != null) box.append(row('Range', s.min === s.max ? label(String(s.min)) : `${label(String(s.min))} to ${label(String(s.max))}`));
  if (s.numericCount) box.append(row('Agreement', `${s.agreement}%`));
  box.append(row('Votes', String(s.total)));

  const dist = el('div', 'dist');
  const maxCount = Math.max(...s.distribution.map((d) => d.count));
  for (const d of s.distribution) {
    const r = el('div', `dist-row${d.count === maxCount ? ' is-top' : ''}`);
    r.title = d.names.join(', ');
    const bar = el('div', 'dist-bar');
    const fill = el('i');
    fill.style.width = `${(d.count / maxCount) * 100}%`;
    bar.append(fill);
    r.append(el('span', 'dist-val', d.value === 'coffee' ? 'cof' : label(d.value)), bar, el('span', 'dist-count', `x${d.count}`));
    dist.append(r);
  }
  box.append(dist);

  if (s.consensus && allIn) box.append(el('div', 'res-note is-good', 'Consensus! Everyone agrees. Ship it.'));
  else if (s.spread) box.append(el('div', 'res-note is-warn', `Big spread: ${s.spread.low.name} (${label(s.spread.low.vote)}) and ${s.spread.high.name} (${label(s.spread.high.vote)}), tell us what you see.`));
  if (s.coffee) box.append(el('div', 'res-note', `${s.coffee} ${s.coffee === 1 ? 'person needs' : 'people need'} a coffee break.`));
  if (s.unsure) box.append(el('div', 'res-note', `${s.unsure} not sure. Maybe the story needs more detail.`));
}

function renderHistory(room) {
  const ol = $('#history');
  const items = room?.history || [];
  const key = JSON.stringify(items.map((h) => h.at));
  if (ol.dataset.key === key) return;
  ol.dataset.key = key;
  ol.innerHTML = '';
  if (!items.length) {
    ol.append(el('li', 'history-empty', 'Finished rounds show up here.'));
    return;
  }
  for (const h of [...items].reverse()) {
    const li = el('li');
    li.append(el('span', 'h-story', h.topic || `Round ${h.round}`), el('span', 'h-avg', h.average != null ? `${h.average}` : '-'));
    const votes = Array.isArray(h.votes) ? h.votes.length : 0;
    li.append(el('span', 'h-meta', `Round ${h.round} · ${votes} votes · suggested ${h.suggested != null ? label(String(h.suggested)) : '-'}${h.consensus ? ' · consensus' : ''}`));
    ol.append(li);
  }
}

// ============================================================

// handy from the devtools console when something looks off
window.sopDebug = () => ({ me: state.me, room: state.room, peers: [...state.peers.values()], myVote: state.myVote, myRound: state.myRound, ready: state.ready });

(async function boot() {
  state.me.id = await resolveMyId();
  initLobby();
  // a reload of a tab that was already seated goes straight back to its chair
  const invite = parseHash();
  if (invite && state.me.name && store.get('sessionStorage', `sop.joined.${invite.token}`)) $('#lobby-form').requestSubmit();
  window.addEventListener('hashchange', () => {
    if (!state.rc) setLobbyMode(parseHash() ? 'join' : 'create');
  });
})();
