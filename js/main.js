import { RoomClient, newToken, newId } from './net.js';
import { Scene } from './scene.js';
import { randomLook, sanitizeLook, drawPreview, drawIconCentered, setSceneTheme, EMOTES, EMOTE_NAMES, SHIRTS, HAIR_STYLES, HAIR_COLORS, SKINS, ACCESSORIES, DECALS, PETS } from './sprites.js';
import { DECKS, DECK_IDS, ALL_CARDS, deckOf, formatScale, computeStats, label } from './stats.js';
import { computeRecap } from './recap.js';
import qrcode from '../vendor/qrcode.mjs';
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
  chatUnread: 0,
  eventLog: new Map(), // sender id -> recent event times, for the flood limit
  skey: null, // storage key for this room
  rounds: new Map(), // round -> what this browser saw at its reveal, for the session recap
  firstVoter: new Map(), // round -> id of the first person seen voting
  handDeck: null,
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
  { key: 'decal', label: 'Logo', n: DECALS.length },
  { key: 'pet', label: 'Pet', n: PETS.length },
];
// the logo and pet rows name what is picked, the others name the part
const lookName = (key, look) => (key === 'decal' ? DECALS[look.decal].name : key === 'pet' ? PETS[look.pet].name : null);

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
    const showName = () => (name.textContent = lookName(part.key, state.me.look) ?? part.label);
    showName();
    name.dataset.part = part.key;
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn';
    next.textContent = '>';
    next.setAttribute('aria-label', `Next ${part.label}`);
    const step = (d) => {
      state.me.look[part.key] = (state.me.look[part.key] + d + part.n) % part.n;
      store.set('localStorage', 'sop.look', state.me.look);
      showName();
      play('pick');
    };
    prev.onclick = () => step(-1);
    next.onclick = () => step(1);
    controls.append(prev, name, next);
  }
  $('#reroll').onclick = () => {
    state.me.look = randomLook();
    store.set('localStorage', 'sop.look', state.me.look);
    for (const key of ['decal', 'pet']) {
      const row = controls.querySelector(`[data-part="${key}"]`);
      if (row) row.textContent = lookName(key, state.me.look);
    }
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
    buildHand(state.room?.deck);
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
    state.room = { v: 1, seq: 1, name: roomName, hostId: state.me.id, round: 1, deck: 'fib', revealed: false, timerEnd: null, autoReveal: false, createdAt: Date.now() };
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
      updateRoom({ v: 1, name: state.roomLabel || 'Planning room', hostId: state.me.id, round: 1, deck: 'fib', revealed: false, timerEnd: null, autoReveal: false, createdAt: Date.now() });
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
    vote: ALL_CARDS.has(d.vote) ? d.vote : null,
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
  if (prev && !prev.voted && p.voted) noteVoter(p.id, p.round);
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
    // the round number people see; a re-vote opens a new voting round under the same number
    label: smallInt(d.label, 1e6) ? d.label : d.round,
    revote: smallInt(d.revote, 1e3) ? d.revote : 0,
    deck: DECK_IDS.includes(d.deck) ? d.deck : 'fib',
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
    state.poked = false;
    saveVote();
    if (next.label === prev.label && next.revote > prev.revote) toast('Re-vote! Pick a card again.');
  }
  if (prev && next.deck !== prev.deck) toast(`New deck: ${deckOf(next.deck).name}. Pick a card again.`);
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
  if (e.type === 'poke') {
    if (e.from !== state.room?.hostId || !Array.isArray(e.ids)) return;
    const ids = e.ids.filter((id) => typeof id === 'string').slice(0, MAX_PEERS);
    state.scene.poke(ids);
    if (ids.includes(state.me.id) && !state.room.revealed && !state.myVote) {
      play('poke');
      state.poked = true;
      renderTitle();
      toast(`${state.peers.get(e.from)?.name || 'The host'} is waiting for your vote`);
    }
    return;
  }
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
    play('emote');
  } else if (e.type === 'typing') {
    state.scene.setTyping(e.from, e.on === true);
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
  if (state.myVote) noteVoter(state.me.id, room.round);
  if (state.poked) {
    state.poked = false;
    renderTitle();
  }
  saveVote();
  publishPresence();
  maybeAutoReveal();
  render();
}

// the first vote seen in a round wins the round's "fastest draw"
function noteVoter(id, round) {
  if (state.room && !state.room.revealed && round === state.room.round && !state.firstVoter.has(round)) state.firstVoter.set(round, id);
}

// Switching decks clears everyone's card: same round number, a fresh hand.
function cycleDeck() {
  if (!amHost()) return;
  const room = state.room;
  const deck = DECK_IDS[(DECK_IDS.indexOf(deckOf(room.deck).id) + 1) % DECK_IDS.length];
  state.myVote = null;
  state.myRound = room.round + 1;
  saveVote();
  updateRoom({ ...room, deck, round: room.round + 1, label: room.label ?? room.round, revealed: false, timerEnd: null });
  play('round');
  toast(`Deck: ${DECKS[deck].name}`);
  publishPresence();
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
  updateRoom({ ...room, round: room.round + 1, label: (room.label ?? room.round) + 1, revote: 0, revealed: false, timerEnd: null });
  play('round');
  publishPresence();
}

// After a big spread: same round number, everyone's card goes back to their hand.
function revote() {
  if (!amHost() || !state.room.revealed) return;
  const room = state.room;
  state.myVote = null;
  state.myRound = room.round + 1;
  saveVote();
  updateRoom({ ...room, round: room.round + 1, label: room.label ?? room.round, revote: (room.revote || 0) + 1, revealed: false, timerEnd: null });
  play('round');
  toast('Re-vote started');
  publishPresence();
}

// Who the host is still waiting for: voters who are here and have not picked a card.
function waitingFor() {
  return allPlayers().filter((p) => !p.isMe && !p.spectator && !p.offline && !p.voted);
}

function poke() {
  if (!amHost() || state.room.revealed) return;
  const ids = waitingFor().map((p) => p.id);
  if (!ids.length) return;
  state.scene.poke(ids);
  play('poke');
  state.rc.sendEvent({ type: 'poke', from: state.me.id, ids });
  toast(ids.length === 1 ? 'Poked 1 person' : `Poked ${ids.length} people`);
}

function toggleAutoReveal() {
  if (!amHost()) return;
  updateRoom({ ...state.room, autoReveal: !state.room.autoReveal });
  maybeAutoReveal();
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
  // the zero-width joiner (U+200D) stays: it glues combined emoji like the person-at-a-laptop one
  const clean = text
    .replace(/[\u0000-\u001f\u007f\u200b\u200c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // cut by characters, not UTF-16 units, so an emoji is never split in half
  return Array.from(clean).slice(0, MAX_CHAT_LENGTH).join('');
}

// ---------- emoji picker ----------

const CHAT_EMOJI = ['😀', '😂', '🤣', '😅', '😊', '😍', '😎', '🤔', '😬', '🙈', '😴', '🤯', '😱', '🥳', '🙌', '👏', '👍', '👎', '💪', '🙏', '🔥', '🎉', '🚀', '💯', '❤️', '☕', '🍕', '✅', '❌', '⏰', '👀', '🐛'];

function buildEmojiPanel() {
  const panel = $('#emoji-panel');
  panel.replaceChildren(
    ...CHAT_EMOJI.map((emoji) => {
      const b = el('button', 'emoji-opt', emoji);
      b.type = 'button';
      b.setAttribute('aria-label', `Insert ${emoji}`);
      b.onclick = () => insertEmoji(emoji);
      return b;
    }),
  );
}

// goes in where the cursor is; the panel stays open for a second pick
function insertEmoji(emoji) {
  const input = $('#chat-input');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const next = input.value.slice(0, start) + emoji + input.value.slice(end);
  if (next.length > input.maxLength) return;
  input.value = next;
  input.focus();
  input.setSelectionRange(start + emoji.length, start + emoji.length);
}

function toggleEmojiPanel(open = $('#emoji-panel').hidden) {
  $('#emoji-panel').hidden = !open;
  $('#emoji-btn').setAttribute('aria-expanded', String(open));
}

function sendChat(raw) {
  const text = cleanChat(raw);
  if (!text || !state.rc) return;
  addChat({ ...state.me, isMe: true }, text);
  state.rc.sendEvent({ type: 'chat', from: state.me.id, text });
}

// "..." over your character while your message box is focused. Re-sent every few
// seconds so latecomers see it, and it fades by itself if the "stopped" message is lost.
const TYPING_REFRESH_MS = 4000;

function setTyping(on) {
  clearInterval(state.typingTimer);
  if (on) state.typingTimer = setInterval(() => announceTyping(true), TYPING_REFRESH_MS);
  if (state.typing === on) return;
  state.typing = on;
  announceTyping(on);
}

function announceTyping(on) {
  if (!state.rc) return;
  state.scene.setTyping(state.me.id, on);
  state.rc.sendEvent({ type: 'typing', from: state.me.id, on });
}

function chatAtBottom(log = $('#chat-log')) {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
}

function addChat(who, text) {
  if (!who) return;
  const log = $('#chat-log');
  log.querySelector('.chat-empty')?.remove();
  // follow the conversation only while someone is actually watching it at the bottom
  const follow = who.isMe || (chatAtBottom(log) && !document.hidden && !state.chatUnread);
  if (!follow && !state.chatUnread) log.append(el('li', 'chat-divider', 'new'));
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
  if (follow) {
    clearChatUnread();
    log.scrollTop = log.scrollHeight;
  } else {
    state.chatUnread += 1;
    renderChatPill();
  }
}

function renderChatPill() {
  const pill = $('#chat-pill');
  const n = state.chatUnread;
  pill.hidden = !n;
  pill.querySelector('.chat-pill-text').textContent = n === 1 ? '1 new message' : `${n} new messages`;
  renderTitle();
}

function clearChatUnread() {
  if (!state.chatUnread) return;
  state.chatUnread = 0;
  renderChatPill();
  // the divider stays a moment so you can see where you left off
  setTimeout(() => {
    if (!state.chatUnread) $('#chat-log').querySelector('.chat-divider')?.remove();
  }, 2500);
}

function jumpToLatestChat() {
  const log = $('#chat-log');
  const divider = log.querySelector('.chat-divider');
  // land on the first unread line, or the very bottom if it is all on screen
  log.scrollTop = divider ? Math.min(divider.offsetTop - log.offsetTop - 8, log.scrollHeight) : log.scrollHeight;
  if (chatAtBottom(log) || !divider) {
    log.scrollTop = log.scrollHeight;
    clearChatUnread();
  }
  $('#chat-input').focus();
}

// a background tab shows the unread count in its title
function renderTitle() {
  const base = `${state.room?.name || 'Planning'} · Pixel Poker`;
  const badge = [state.poked ? '!' : '', state.chatUnread ? String(state.chatUnread) : ''].filter(Boolean).join(' ');
  document.title = badge ? `(${badge}) ${base}` : base;
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

function buildHand(deckId) {
  const deck = deckOf(deckId);
  state.handDeck = deck.id;
  const hand = $('#hand');
  hand.innerHTML = '';
  for (const v of deck.cards) {
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
      b.setAttribute('aria-label', v === '?' ? 'Not sure' : deck.id === 'fib' ? `${label(v)} points` : label(v));
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
  $('#revote').onclick = revote;
  $('#poke').onclick = poke;
  $('#qr').onclick = openQr;
  $('#qr-close').onclick = () => $('#qr-pop').close();
  $('#qr-expand').onclick = () => setQrBig(!$('#qr-pop').classList.contains('is-big'));
  $('#qr-pop').addEventListener('close', () => setQrBig(false));
  $('#recap-close').onclick = () => $('#recap').close();
  $('#recap-copy').onclick = () => copyText(recapText(), 'Recap copied');
  $('#chat-pill').onclick = jumpToLatestChat;
  buildEmojiPanel();
  $('#emoji-btn').onclick = () => toggleEmojiPanel();
  $('#chat-input').addEventListener('focus', () => setTyping(true));
  $('#chat-input').addEventListener('blur', () => setTyping(false));
  $('#chat-log').addEventListener('scroll', () => {
    if (chatAtBottom()) clearChatUnread();
  });
  $('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    sendChat($('#chat-input').value);
    $('#chat-input').value = '';
    toggleEmojiPanel(false);
  };
  document.querySelectorAll('[data-timer]').forEach((b) => (b.onclick = () => setTimer(Number(b.dataset.timer))));
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
    // points pick by value; other decks pick the nth card with 1-9
    const deck = deckOf(state.room?.deck);
    const map = deck.id === 'fib' ? { 1: '1', 2: '2', 3: '3', 5: '5', 8: '8' } : Object.fromEntries(deck.cards.slice(0, -2).map((c, i) => [i + 1, c]));
    const card = { ...map, '?': '?', c: 'coffee' }[e.key];
    if (card) pickCard(card);
  });
}

// ---------- settings: everything that is a preference lives behind the gear ----------

const root = document.documentElement;
// 'on' (full), 'minimal' or 'off'
const motionMode = () => (['on', 'off'].includes(root.dataset.motion) ? root.dataset.motion : 'minimal');
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
  // room rules only the host sets: set once, so they live here instead of the round bar
  {
    hostOnly: true,
    icon: () => 'card',
    label: () => 'Deck',
    value: () => deckOf(state.room?.deck).name,
    toggle: () => cycleDeck(),
  },
  {
    hostOnly: true,
    icon: () => (state.room?.autoReveal ? 'check' : 'eye'),
    label: () => 'Auto-show votes',
    value: () => (state.room?.autoReveal ? 'On' : 'Off'),
    toggle: () => toggleAutoReveal(),
  },
  {
    inRoom: true,
    action: true,
    icon: () => 'star',
    label: () => 'Session recap',
    value: () => (state.rounds.size ? `${state.rounds.size} ${state.rounds.size === 1 ? 'round' : 'rounds'}` : ''),
    toggle: () => openRecap(),
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
    value: () => ({ minecraft: 'Minecraft', normal: 'Normal' })[root.dataset.font] || 'Pixel',
    // cycles Pixel -> Minecraft -> Normal
    toggle: () => {
      const next = { minecraft: 'normal', normal: 'pixel' }[root.dataset.font] || 'minecraft';
      if (next === 'pixel') delete root.dataset.font;
      else root.dataset.font = next;
      saveRaw('sop.font', next);
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
  $('#emoji-btn')?.replaceChildren(iconCanvas('smile'));
}

const visibleSettings = () => SETTINGS.filter((x) => (!x.inRoom || state.rc) && (!x.hostOnly || (state.rc && amHost())));

function renderSettingsMenu() {
  const menu = $('#settings-menu');
  menu.replaceChildren();
  for (const item of visibleSettings()) {
    const b = el('button', 'menu-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(iconCanvas(item.icon()), el('span', 'menu-label', item.label()), el('span', 'menu-value', item.value()));
    b.onclick = () => {
      if (item.action) return item.toggle();
      item.toggle();
      play('pick');
      renderSettingsMenu();
      menu.querySelectorAll('.menu-item')[visibleSettings().indexOf(item)]?.focus();
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
    if (e.target.isConnected && !e.target.closest('#emoji-panel, #emoji-btn')) toggleEmojiPanel(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSettings({ refocus: true });
      toggleEmojiPanel(false);
    }
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
  renderTitle();
  $('#round-no').textContent = room ? (room.label ?? room.round) : '-';
  $('#revote-chip').hidden = !room?.revote;
  renderStatus();

  // host tools live in the round bar: while voting the timer, auto-show and Show votes,
  // after the reveal only New round, so the next step is always the obvious one
  $('#host-actions').hidden = !host;
  $('#host-chip').hidden = !host;
  if (host) {
    $('#host-tools').hidden = room.revealed;
    $('#reveal').hidden = room.revealed;
    $('#next').hidden = !room.revealed;
    $('#revote').hidden = !room.revealed;
    // poke only makes sense while someone is still thinking
    const waiting = room.revealed ? 0 : waitingFor().length;
    $('#poke').hidden = !waiting;
    $('#poke').textContent = waiting > 1 ? `Poke ${waiting}` : 'Poke';
  }
  if (host) {
    document.querySelectorAll('[data-timer]').forEach((b) => {
      b.disabled = room.revealed;
      b.classList.toggle('is-active', b.dataset.timer === '0' ? !room.timerEnd : false);
    });
  }

  // hand: rebuilt when the host switches decks
  if (room && deckOf(room.deck).id !== state.handDeck) buildHand(room.deck);
  const canVote = room && !room.revealed && !state.me.spectator;
  document.querySelectorAll('#hand .card').forEach((c) => {
    c.disabled = !canVote;
    c.classList.toggle('is-selected', !!room && state.myRound === room.round && c.dataset.value === state.myVote);
  });
  $('#hand').hidden = state.me.spectator;

  // scene
  const revealedVotes = players.filter((p) => p.vote != null);
  const stats = computeStats(revealedVotes, room?.deck);
  if (room?.revealed && revealedVotes.length) recordRound(room, revealedVotes);
  const allIn = players.filter((p) => p.voted).every((p) => p.vote != null);
  state.scene.setRoom({ revealed: !!room?.revealed, consensus: !!room?.revealed && allIn && stats.consensus, timerEnd: room?.timerEnd });
  state.scene.setPlayers(players);

  renderPlayers(players, host);
  renderResults(room, stats, allIn);
  if ($('#recap').open) renderRecap();

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

function recordRound(room, votes) {
  state.rounds.set(room.round, {
    label: room.label ?? room.round,
    revote: room.revote || 0,
    deck: deckOf(room.deck).id,
    votes: votes.map((p) => ({ id: p.id, name: p.name, vote: p.vote })),
    first: state.firstVoter.get(room.round) ?? null,
  });
  // a very long session keeps its latest rounds
  if (state.rounds.size > 300) state.rounds.delete(state.rounds.keys().next().value);
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
  const fmt = (n) => formatScale(room.deck, n);
  box.append(el('h2', null, 'Results'));
  if (!s.total) {
    box.append(el('div', 'res-note', allIn ? 'Nobody voted this round.' : 'Collecting votes...'));
    return;
  }
  const top = el('div', 'res-top');
  const t1 = el('div', 'res-tile is-main');
  // sizes have no average: the size nearest the middle stands in for it
  t1.append(el('span', 'k', 'Average'), el('span', 'v', fmt(s.average)));
  const t2 = el('div', 'res-tile');
  t2.append(el('span', 'k', 'Suggested'), el('span', 'v', fmt(s.suggested)));
  top.append(t1, t2);
  box.append(top);

  const row = (k, v) => {
    const r = el('div', 'res-row');
    r.append(el('span', null, k), el('b', null, v));
    return r;
  };
  if (s.median != null) box.append(row('Median', fmt(s.median)));
  if (s.min != null) box.append(row('Range', s.min === s.max ? fmt(s.min) : `${fmt(s.min)} to ${fmt(s.max)}`));
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
  const more = el('button', 'btn btn-small res-recap', 'Session recap');
  more.type = 'button';
  more.onclick = openRecap;
  box.append(more);
}

// ---------- session recap: a card worth a screenshot at the end of planning ----------

function openRecap() {
  closeSettings();
  renderRecap();
  $('#recap').showModal();
  play('reveal');
}

function renderRecap() {
  const r = computeRecap([...state.rounds.values()]);
  $('#recap-room').textContent = `${state.room?.name || 'Planning room'} · ${new Date().toLocaleDateString('sv-SE')}`;
  const tiles = $('#recap-tiles');
  tiles.replaceChildren();
  for (const [k, v] of [
    ['Rounds', r.rounds],
    ['Consensus', r.consensus],
    ['Agreement', r.agreement == null ? '-' : `${r.agreement}%`],
  ]) {
    const t = el('div', 'res-tile');
    t.append(el('span', 'k', k), el('span', 'v', String(v)));
    tiles.append(t);
  }
  const awards = $('#recap-awards');
  awards.replaceChildren();
  if (!r.awards.length) awards.append(el('li', 'res-note', 'Play a round and the awards show up here.'));
  for (const a of r.awards) {
    const li = el('li', 'award');
    const text = el('div', 'award-text');
    text.append(el('span', 'award-title', a.title), el('b', 'award-names', a.names.join(' & ') + (a.more ? ` +${a.more}` : '')), el('span', 'award-line', a.line));
    li.append(iconCanvas(a.icon), text);
    awards.append(li);
  }
  const list = $('#recap-rounds');
  list.replaceChildren();
  for (const x of r.list.slice(-12)) {
    const li = el('li');
    li.append(el('span', null, `Round ${x.label}${x.revote ? ` (re-vote ${x.revote})` : ''}`), el('b', null, x.result));
    if (x.consensus) li.append(el('span', 'recap-ok', 'consensus'));
    list.append(li);
  }
  $('#recap-rounds-wrap').hidden = !r.list.length;
}

function recapText() {
  const r = computeRecap([...state.rounds.values()]);
  return [
    `${state.room?.name || 'Planning room'} - ${new Date().toLocaleDateString('sv-SE')}`,
    `${r.rounds} rounds, ${r.consensus} with consensus${r.agreement == null ? '' : `, ${r.agreement}% agreement`}`,
    ...r.awards.map((a) => `${a.title}: ${a.names.join(' & ')} (${a.line})`),
    ...r.list.map((x) => `Round ${x.label}${x.revote ? ` re-vote ${x.revote}` : ''}: ${x.result}${x.consensus ? ' (consensus)' : ''}`),
  ].join('\n');
}

// ---------- QR code of the invite link, drawn locally ----------

function setQrBig(big) {
  $('#qr-pop').classList.toggle('is-big', big);
  $('#qr-expand').textContent = big ? 'Shrink' : 'Expand';
}

// a centred dialog like the recap; being modal, the settings menu cannot be open with it
function openQr() {
  closeSettings();
  const qr = qrcode(0, 'M');
  qr.addData(location.href);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const c = $('#qr-canvas');
  c.width = c.height = n + quiet * 2;
  const ctx = c.getContext('2d');
  // dark on white whatever the theme: phone cameras want it that way
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#0d0b1a';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) ctx.fillRect(x + quiet, y + quiet, 1, 1);
  $('#qr-pop').showModal();
}

// ============================================================

// for poking at a room from the console; only with ?debug in the address
if (new URLSearchParams(location.search).has('debug')) window.sopDebug = () => ({ scene: state.scene, rc: state.rc, me: state.me, room: state.room, peers: [...state.peers.values()], myVote: state.myVote, myRound: state.myRound, ready: state.ready });

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
