import { RoomClient, newToken, newId } from './net.js';
import { Scene } from './scene.js';
import { randomLook, sanitizeLook, drawPreview, drawIconCentered, setSceneTheme, EMOTES, EMOTE_NAMES, SHIRTS, HAIR_STYLES, HAIR_COLORS, SKINS, ACCESSORIES } from './sprites.js';
import { DECK, computeStats, label } from './stats.js';
import { play, isMuted, setMuted } from './audio.js';
import { roomSlug, parseRoomHash } from './room-name.js';

const $ = (sel) => document.querySelector(sel);
const STALE_MS = 130_000; // no heartbeat for this long: the seat goes to sleep
const OFFLINE_MAX_MS = 20 * 60_000; // asleep this long without coming back: the seat is freed
const HEARTBEAT_MS = 20_000;
const HOST_GRACE_MS = 5_000; // let a refreshing host come back before someone else takes over
const MAX_CHAT = 100; // messages kept on screen; nothing is stored anywhere
const MAX_CHAT_LENGTH = 200;
const MAX_PEERS = 40; // more seats than any team has: beyond this it is someone flooding the room
const EVENT_BURST = 8; // events one person may send in EVENT_WINDOW_MS before the rest are dropped
const EVENT_WINDOW_MS = 4_000;
const MAX_SEQ_JUMP = 1_000; // room updates come one at a time; a huge jump is a forged state

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

// Storage keys never contain the room secret: the github.io origin is shared with other pages.
async function storeKeyFor(token) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`store:${token}`)));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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
  eventLog: new Map(), // sender id -> recent event times, for the flood limit
  skey: null, // storage key for this room
};

function parseHash() {
  return parseRoomHash(location.hash);
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
  $('#room-name').oninput = () => setLobbyMode('create');
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
    // with motion off the preview is a still portrait
    if (motionOn()) drawPreview(canvas, state.me.look, t, $('#spectator').checked ? 'spectator' : pose, (t - start) % 2200);
    else drawPreview(canvas, state.me.look, 0, $('#spectator').checked ? 'spectator' : 'idle', 0);
    lobbyRaf = requestAnimationFrame(tick);
  };
  lobbyRaf = requestAnimationFrame(tick);
}

function setLobbyMode(mode) {
  const join = mode === 'join';
  const invite = parseHash();
  $('#join-info').hidden = !join;
  $('#join-info').textContent = invite?.slug ? `You are joining room "${invite.slug}".` : 'You have been invited to a planning room.';
  $('#room-name-field').hidden = join;
  $('#create-instead').hidden = !join;
  $('#enter-btn').textContent = join || roomSlug($('#room-name').value) ? 'Join room' : 'Create room';
  $('#lobby-error').hidden = true;
}

async function onEnter(e) {
  e.preventDefault();
  // a double click or an auto-rejoin racing a click must not open the room twice
  if (state.entering || state.rc) return;
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
  state.entering = true;
  btn.disabled = true;
  err.hidden = true;
  const invite = parseHash();
  const idle = btn.textContent;
  btn.textContent = 'Connecting...';
  try {
    play('pick');
    // a typed room name is the room: the same name puts everyone at the same table
    const typed = invite ? '' : $('#room-name').value.trim().replace(/\s+/g, ' ').slice(0, 40);
    const slug = invite ? invite.slug : roomSlug(typed);
    state.token = invite ? invite.token : slug ? `room:${slug}` : newToken();
    state.roomLabel = typed || slug || 'Planning room';
    state.skey = await storeKeyFor(state.token);
    const rc = new RoomClient({ token: state.token, myId: state.me.id });
    await rc.init();
    await rc.connect();
    if (!invite) history.replaceState(null, '', slug ? `#room=${slug}` : `#r=${state.token}`);
    // only a private room is new for sure; a named one may already have people in it
    const creating = !invite && !slug;
    await enterRoom(rc, creating ? { creating: true, roomName: typed || 'Planning room' } : { creating: false });
  } catch (ex) {
    console.error('Failed to connect to the planning room', { error: ex });
    err.textContent = 'Could not reach the relay. Check your connection and try again.';
    err.hidden = false;
  } finally {
    state.entering = false;
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

  const joinedKey = `sop.joined.${state.skey}`;
  state.me.joinedAt = store.get('sessionStorage', joinedKey) || Date.now();
  store.set('sessionStorage', joinedKey, state.me.joinedAt);

  const saved = store.get('sessionStorage', `sop.vote.${state.skey}`);
  if (saved) {
    state.myVote = saved.vote;
    state.myRound = saved.round;
    state.myPick = saved.pick || 0;
  }

  $('#lobby').hidden = true;
  $('#room').hidden = false;

  if (!state.scene) {
    state.scene = new Scene($('#stage'), { onSeatClick: throwAt });
    state.scene.setMotion(motionMode());
    buildHand();
    buildEmotes();
    wireRoomControls();
  }

  rc.addEventListener('presence', (e) => onPresence(e.detail));
  rc.addEventListener('presence-gone', (e) => onPresenceGone(e.detail.id, e.detail.left));
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
    state.room = { v: 1, seq: 1, name: roomName, hostId: state.me.id, round: 1, revealed: false, timerEnd: null, autoReveal: false, createdAt: Date.now() };
    rc.publishRoom(state.room);
    state.ready = true;
  } else {
    // retained room state and seats arrive right after subscribing
    setTimeout(() => {
      state.ready = true;
      checkHost();
      resolveNameClash();
      render();
    }, 1800);
  }

  publishPresence();
  play('join');
  render();

  state.heartbeat?.stop();
  state.heartbeat = everyMs(HEARTBEAT_MS, () => {
    publishPresence();
    // anyone can wipe a retained message on a public relay; the host keeps putting the room back
    if (amHost() && state.room) state.rc.publishRoom(state.room);
    prunePeers();
  });
  state.ticker?.stop();
  state.ticker = everyMs(1000, tickSecond);
}

// Background tabs get their timers throttled to once a minute; a worker's timers keep their pace.
function everyMs(ms, fn) {
  try {
    const src = `setInterval(() => postMessage(0), ${ms});`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = fn;
    return { stop: () => w.terminate() };
  } catch {
    const id = setInterval(fn, ms);
    return { stop: () => clearInterval(id) };
  }
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
  if (state.room && list.some((p) => p.id === state.room.hostId && !p.offline)) return state.room.hostId;
  if (!state.ready) return state.room?.hostId ?? null;
  // a sleeping seat cannot run the room
  const sorted = list.filter((p) => !p.offline).sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
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
      updateRoom({ v: 1, name: state.roomLabel || 'Planning room', hostId: state.me.id, round: 1, revealed: false, timerEnd: null, autoReveal: false, createdAt: Date.now() });
    }
    return;
  }
  const hostHere = list.some((p) => p.id === state.room.hostId && !p.offline);
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
    v: 3,
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
    v: Number.isInteger(d.v) ? d.v : 1,
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
  if (Date.now() - p.ts > OFFLINE_MAX_MS) return;
  const known = state.peers.has(p.id);
  if (!known && state.peers.size >= MAX_PEERS) return;
  const prev = state.peers.get(p.id);
  // someone back from another browser or device takes over their own sleeping seat
  for (const [id, q] of state.peers) {
    if (id !== p.id && q.offline && q.name.toLowerCase() === p.name.toLowerCase()) removePeer(id, { quiet: true });
  }
  state.peers.set(p.id, { ...p, seenAt: Date.now() });
  resolveNameClash();
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

// The relays dropped this person's connection. That also happens to a tab the
// browser froze in the background, so keep the seat (asleep) until they come
// back, say goodbye, or stay away too long.
// Two awake seats with one name confuse everyone: whoever sat down later becomes "Name 2".
function resolveNameClash() {
  if (!state.ready) return;
  const mine = state.me.name.toLowerCase();
  const earlier = (p) => p.joinedAt < state.me.joinedAt || (p.joinedAt === state.me.joinedAt && p.id < state.me.id);
  const clash = [...state.peers.values()].some((p) => !p.offline && p.name.toLowerCase() === mine && earlier(p));
  if (!clash) return;
  const taken = new Set([...state.peers.values()].map((p) => p.name.toLowerCase()));
  const base = state.me.name.replace(/ \d+$/, '') || state.me.name;
  let next = base;
  for (let n = 2; taken.has(next.toLowerCase()) || next.toLowerCase() === mine; n++) next = `${base.slice(0, 19 - String(n).length)} ${n}`;
  state.me.name = next;
  store.set('sessionStorage', 'sop.name', next);
  toast(`Someone here is already called ${base}. You are ${next} for now.`);
  publishPresence();
}

function onPresenceGone(id, left) {
  const p = state.peers.get(id);
  if (!p) return;
  if (left) return removePeer(id);
  if (p.offline) return;
  p.offline = true;
  p.offlineSince = Date.now();
  render();
}

function removePeer(id, { quiet = false } = {}) {
  const p = state.peers.get(id);
  if (!p) return;
  state.peers.delete(id);
  state.recentlyGone.set(id, Date.now());
  if (!quiet) setTimeout(() => {
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
    if (!p.offline && now - p.seenAt > STALE_MS) {
      p.offline = true;
      p.offlineSince = now;
      changed = true;
    } else if (p.offline && now - p.offlineSince > OFFLINE_MAX_MS) {
      removePeer(id);
    }
  }
  if (changed) render();
}

const smallInt = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// Room state comes from whoever holds the key: keep only known fields, in known shapes and sizes.
function sanitizeRoom(d) {
  if (!d || typeof d.hostId !== 'string' || !smallInt(d.round, 1e6) || !smallInt(d.seq, 1e9)) return null;
  return {
    v: 1,
    name: str(d.name, 40) || 'Planning room',
    hostId: d.hostId.slice(0, 16),
    round: d.round,
    revealed: !!d.revealed,
    timerEnd: Number.isFinite(d.timerEnd) ? d.timerEnd : null,
    autoReveal: !!d.autoReveal,
    createdAt: Number.isFinite(d.createdAt) ? d.createdAt : 0,
    seq: d.seq,
  };
}

function onRoom(raw) {
  const next = sanitizeRoom(raw);
  if (!next) return;
  const prev = state.room;
  // ignore anything older than what we already hold (our own echo included), or implausibly far ahead
  if (prev && (next.seq < prev.seq || next.seq > prev.seq + MAX_SEQ_JUMP)) return;
  // two people opening an empty named room at once both set it up: everyone keeps the same one
  if (prev && next.seq === prev.seq && next.hostId !== prev.hostId && next.hostId > prev.hostId) return;
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
  // one person spamming throws or emotes should not drown the room
  const now = Date.now();
  const recent = (state.eventLog.get(e.from) || []).filter((t) => now - t < EVENT_WINDOW_MS);
  if (recent.length >= EVENT_BURST) return;
  state.eventLog.set(e.from, [...recent, now]);
  if (e.type === 'kick') {
    // only the host clears a sleeping seat, and never ours: we are clearly here
    if (typeof e.id === 'string' && e.id !== state.me.id && e.from === state.room?.hostId) removePeer(e.id);
    return;
  }
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
  } else if (e.type === 'chat') {
    const text = cleanChat(e.text);
    if (!text) return;
    addChat(state.peers.get(e.from), text);
    state.scene.emote(e.from, 'talk');
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
  const voters = allPlayers().filter((p) => !p.spectator && !p.offline);
  // no timer here: a host tab in the background gets its timers throttled, messages still arrive
  if (voters.length && voters.every((p) => p.voted)) reveal();
}

// ---------- actions ----------

function saveVote() {
  store.set('sessionStorage', `sop.vote.${state.skey}`, { vote: state.myVote, round: state.myRound, pick: state.myPick });
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
  if (!amHost() || !state.room.revealed) return;
  const room = state.room;
  state.myVote = null;
  state.myRound = room.round + 1;
  saveVote();
  updateRoom({ ...room, round: room.round + 1, revealed: false, timerEnd: null });
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

function removeSeat(id) {
  if (!amHost()) return;
  removePeer(id);
  state.rc.sendEvent({ type: 'kick', from: state.me.id, id });
}

// Observers watch without a card; switching back gives them a hand again.
function toggleRole() {
  state.me.spectator = !state.me.spectator;
  store.set('localStorage', 'sop.spectator', state.me.spectator);
  if (state.me.spectator) {
    state.myVote = null;
    saveVote();
  }
  play('pick');
  toast(state.me.spectator ? 'You are watching this one' : 'You are voting again');
  publishPresence();
  maybeAutoReveal();
  render();
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

// ---------- chat: encrypted like everything else, kept only on screen ----------

// one line of plain text: no control or direction-changing characters, bounded length
function cleanChat(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHAT_LENGTH);
}

function sendChat(raw) {
  const text = cleanChat(raw);
  if (!text || !state.rc) return;
  addChat({ ...state.me, isMe: true }, text);
  state.scene.emote(state.me.id, 'talk');
  state.rc.sendEvent({ type: 'chat', from: state.me.id, text });
}

function addChat(who, text) {
  if (!who) return;
  const log = $('#chat-log');
  log.querySelector('.chat-empty')?.remove();
  // stay at the bottom only if the reader already was there
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const li = el('li', `chat-msg${who.isMe ? ' is-me' : ''}`);
  const dot = el('span', 'p-dot');
  dot.style.background = SHIRTS[who.look?.shirt ?? 0];
  const time = new Date();
  li.append(
    dot,
    el('span', 'chat-name', who.isMe ? 'You' : who.name),
    el('span', 'chat-time', `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`),
    el('span', 'chat-text', text),
  );
  log.append(li);
  while (log.children.length > MAX_CHAT) log.firstElementChild.remove();
  if (atBottom || who.isMe) log.scrollTop = log.scrollHeight;
}

function sendEmote(icon) {
  state.scene.emote(state.me.id, icon);
  play('emote');
  state.rc.sendEvent({ type: 'emote', from: state.me.id, icon });
}

async function leaveRoom() {
  try {
    sessionStorage.removeItem(`sop.joined.${state.skey}`);
    sessionStorage.removeItem(`sop.vote.${state.skey}`);
  } catch {
    /* ignore */
  }
  state.heartbeat?.stop();
  state.ticker?.stop();
  try {
    await state.rc?.leave();
  } catch (e) {
    console.error('Failed to leave the room cleanly', { error: e });
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
      c.width = 9;
      c.height = 9;
      drawIconCentered(c.getContext('2d'), 'coffee', 0, 0, 9, 9);
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
    b.setAttribute('aria-label', `React: ${EMOTE_NAMES[icon]}`);
    b.title = EMOTE_NAMES[icon];
    // 9 x 9 like the inside of a speech bubble: an odd size centres the 7-pixel icons exactly
    const c = document.createElement('canvas');
    c.width = 9;
    c.height = 9;
    drawIconCentered(c.getContext('2d'), icon, 0, 0, 9, 9);
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
  $('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    sendChat($('#chat-input').value);
    $('#chat-input').value = '';
  };
  document.querySelectorAll('[data-timer]').forEach((b) => (b.onclick = () => setTimer(Number(b.dataset.timer))));
  $('#auto-reveal').onchange = (e) => {
    if (amHost()) {
      updateRoom({ ...state.room, autoReveal: e.target.checked });
      maybeAutoReveal();
    }
  };
  document.addEventListener('visibilitychange', () => {
    publishPresence();
    render();
  });
  window.addEventListener('pagehide', () => state.rc?.leaveNow());
  // a frozen tab coming back: show we are here again straight away
  window.addEventListener('focus', () => publishPresence());
  // back/forward cache restores a page whose relay sockets are already closed
  window.addEventListener('pageshow', (e) => e.persisted && location.reload());
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const map = { 1: '1', 2: '2', 3: '3', 5: '5', 8: '8', '?': '?', c: 'coffee' };
    if (map[e.key]) pickCard(map[e.key]);
  });
}

// ---------- settings: everything that is a preference lives behind the gear ----------

const root = document.documentElement;
// 'on' (full), 'minimal' or 'off'
const motionMode = () => (['minimal', 'off'].includes(root.dataset.motion) ? root.dataset.motion : 'on');
const motionOn = () => motionMode() !== 'off';

// raw strings, not JSON: js/boot.js reads them before the modules load
function saveRaw(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* blocked storage: the choice still holds for this visit */
  }
}

function applyTheme() {
  const light = root.dataset.theme === 'light';
  setSceneTheme(light);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f6efe2' : '#16132a');
  // icons are painted with the palette, so repaint them
  paintGears();
  if (state.scene) buildEmotes();
}

const SETTINGS = [
  {
    inRoom: true,
    icon: () => (state.me.spectator ? 'card' : 'eye'),
    label: () => (state.me.spectator ? 'Switch to voter' : 'Switch to observer'),
    value: () => '',
    toggle: () => toggleRole(),
  },
  {
    icon: () => (root.dataset.theme === 'light' ? 'sun' : 'moon'),
    label: () => 'Theme',
    value: () => (root.dataset.theme === 'light' ? 'Light' : 'Dark'),
    toggle: () => {
      root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
      saveRaw('sop.theme', root.dataset.theme);
      applyTheme();
    },
  },
  {
    icon: () => 'font',
    label: () => 'Font',
    value: () => (root.dataset.font === 'normal' ? 'Normal' : 'Pixel'),
    toggle: () => {
      if (root.dataset.font === 'normal') delete root.dataset.font;
      else root.dataset.font = 'normal';
      saveRaw('sop.font', root.dataset.font || 'pixel');
      state.scene?.layout(); // name plates measure their text
    },
  },
  {
    icon: () => (isMuted() ? 'muted' : 'speaker'),
    label: () => 'Sound',
    value: () => (isMuted() ? 'Off' : 'On'),
    toggle: () => setMuted(!isMuted()),
  },
  {
    icon: () => (motionOn() ? 'wave' : 'pause'),
    label: () => 'Motion',
    value: () => ({ on: 'Full', minimal: 'Minimal', off: 'Off' })[motionMode()],
    // cycles Full -> Minimal -> Off
    toggle: () => {
      root.dataset.motion = { on: 'minimal', minimal: 'off', off: 'on' }[motionMode()];
      saveRaw('sop.motion', root.dataset.motion);
      state.scene?.setMotion(motionMode());
    },
  },
];

function iconCanvas(name) {
  const c = document.createElement('canvas');
  c.width = 9;
  c.height = 9;
  c.className = 'px-icon';
  drawIconCentered(c.getContext('2d'), name, 0, 0, 9, 9);
  return c;
}

function paintGears() {
  document.querySelectorAll('.settings-btn').forEach((b) => b.replaceChildren(iconCanvas('gear')));
}

function renderSettingsMenu() {
  const menu = $('#settings-menu');
  menu.replaceChildren();
  for (const item of SETTINGS) {
    if (item.inRoom && !state.rc) continue;
    const b = el('button', 'menu-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(iconCanvas(item.icon()), el('span', 'menu-label', item.label()), el('span', 'menu-value', item.value()));
    b.onclick = () => {
      item.toggle();
      play('pick');
      renderSettingsMenu();
      menu.querySelectorAll('.menu-item')[[...SETTINGS].filter((x) => !x.inRoom || state.rc).indexOf(item)]?.focus();
    };
    menu.append(b);
  }
}

let menuAnchor = null;

function openSettings(anchor) {
  const menu = $('#settings-menu');
  menuAnchor = anchor;
  renderSettingsMenu();
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 10)}px`;
  menu.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`;
  anchor.setAttribute('aria-expanded', 'true');
  menu.querySelector('.menu-item')?.focus();
}

function closeSettings({ refocus = false } = {}) {
  const menu = $('#settings-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  menuAnchor?.setAttribute('aria-expanded', 'false');
  if (refocus) menuAnchor?.focus();
  menuAnchor = null;
}

function wireSettings() {
  applyTheme();
  document.querySelectorAll('.settings-btn').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      if (menuAnchor === b) closeSettings();
      else openSettings(b);
    };
  });
  document.addEventListener('click', (e) => {
    // a clicked menu item is redrawn (and so detached) by the time this runs: that is not an outside click
    if (e.target.isConnected && !e.target.closest('#settings-menu')) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings({ refocus: true });
  });
  window.addEventListener('resize', () => closeSettings());
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
  const voters = players.filter((p) => !p.spectator && !p.offline);
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
  document.title = `${room?.name || 'Planning'} · Pixel Poker`;
  $('#round-no').textContent = room?.round ?? '-';
  renderStatus();

  // host bar
  $('#host-bar').hidden = !host;
  $('#host-actions').hidden = !host;
  if (host) {
    // one step at a time: show the votes, then move on
    $('#reveal').hidden = room.revealed;
    $('#next').hidden = !room.revealed;
  }
  if (host) {
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
    } else st.textContent = p.offline ? 'asleep' : p.away ? 'away' : 'thinking';
    li.append(st);
    if (host && !p.isMe) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-small';
      // a sleeping seat cannot take the room over, but the host can clear it
      b.textContent = p.offline ? 'Remove' : 'Make host';
      b.onclick = () => (p.offline ? removeSeat(p.id) : makeHost(p.id));
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
  if (s.unsure) box.append(el('div', 'res-note', `${s.unsure} not sure. Maybe it needs more detail.`));
}

// ============================================================

// for poking at a room from the console; only with ?debug in the address
if (new URLSearchParams(location.search).has('debug')) window.sopDebug = () => ({ rc: state.rc, me: state.me, room: state.room, peers: [...state.peers.values()], myVote: state.myVote, myRound: state.myRound, ready: state.ready });

(async function boot() {
  state.me.id = await resolveMyId();
  wireSettings();
  initLobby();
  // a reload of a tab that was already seated goes straight back to its chair
  const invite = parseHash();
  if (invite && state.me.name && store.get('sessionStorage', `sop.joined.${await storeKeyFor(invite.token)}`)) $('#lobby-form').requestSubmit();
  window.addEventListener('hashchange', () => {
    if (!state.rc) setLobbyMode(parseHash() ? 'join' : 'create');
  });
})();
