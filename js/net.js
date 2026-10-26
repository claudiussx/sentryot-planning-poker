// Realtime room over public MQTT brokers (WebSocket). Everything after the '#'
// in the invite link stays in the browser: the topic and the AES-GCM key are
// both derived from the room token, so the brokers only ever relay ciphertext.
//
// Public brokers are free and occasionally flaky, so every client talks to all
// of them at once, publishes to each and de-duplicates what comes back. One
// broker going down does not empty the room.
//
// Anyone can publish to a public broker. Without the key they can only send
// noise: every message that counts (seats, room state, events, "I left") is
// encrypted and bound to its topic, so it cannot be forged or moved elsewhere.
import mqttModule from '../vendor/mqtt.esm.js';

const connect = mqttModule.connect || mqttModule.default?.connect;

export const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const NS = 'pixel-poker/v2';
const KDF_ITERATIONS = 150_000; // makes guessing room names offline slow, still quick to join
const MAX_PAYLOAD = 16 * 1024; // nothing legitimate comes close
const MAX_MESSAGES_PER_SECOND = 300; // beyond this someone is flooding the room
const EVENT_MAX_AGE_MS = 120_000; // replayed events older than this are ignored
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function newToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(12)));
}

export function newId() {
  return b64url(crypto.getRandomValues(new Uint8Array(6)));
}

// MQTT 3.1.1 PUBLISH, QoS 0, built by hand for leaveNow().
function publishPacket(topic, payload, retain) {
  const t = enc.encode(topic);
  const body = 2 + t.length + payload.length;
  const len = [];
  let n = body;
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    len.push(b);
  } while (n > 0);
  const out = new Uint8Array(1 + len.length + body);
  out[0] = 0x30 | (retain ? 1 : 0);
  out.set(len, 1);
  let o = 1 + len.length;
  out[o++] = t.length >> 8;
  out[o++] = t.length & 0xff;
  out.set(t, o);
  out.set(payload, o + t.length);
  return out;
}

export class RoomClient extends EventTarget {
  constructor({ token, myId, brokers = BROKERS }) {
    super();
    this.token = token;
    this.myId = myId;
    this.sid = newId(); // this tab's session: a "gone" notice only counts for the session that sent it
    this.urls = brokers;
    this.clients = [];
    this.online = new Set(); // broker indexes we are connected to
    this.presenceOn = new Map(); // peer id -> broker indexes that currently hold their seat
    this.sids = new Map(); // peer id -> their current session id
    this.seenEvents = new Map(); // event id -> time, to drop the copies from other brokers
    this.budget = { second: 0, count: 0 };
    this.queue = Promise.resolve();
    this.leaving = false; // once set, nothing may put our seat back
  }

  async init() {
    const material = await crypto.subtle.importKey('raw', enc.encode(this.token), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(NS), iterations: KDF_ITERATIONS }, material, 42 * 8),
    );
    this.base = `${NS}/${hex(bits.slice(0, 10))}`;
    this.key = await crypto.subtle.importKey('raw', bits.slice(10), 'AES-GCM', false, ['encrypt', 'decrypt']);
    // sealed ahead of time: the broker sends the first if the connection dies,
    // the second goes out when we leave on purpose, even from a closing page
    const mine = `p/${this.myId}`;
    this.lostNotice = await this.seal({ id: this.myId, gone: 'lost', sid: this.sid }, mine);
    this.leftNotice = await this.seal({ id: this.myId, gone: 'left', sid: this.sid }, mine);
  }

  get connected() {
    return this.online.size > 0;
  }

  // The topic is part of the authenticated data, so a message cannot be replayed on another topic.
  async seal(obj, rel) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(rel) }, this.key, enc.encode(JSON.stringify(obj))),
    );
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    return out;
  }

  async open(bytes, rel) {
    if (!bytes || bytes.length < 29) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(rel) }, this.key, bytes.slice(12));
      const data = JSON.parse(dec.decode(plain));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
      return null; // not ours, or tampered with
    }
  }

  #status() {
    this.dispatchEvent(new CustomEvent('status', { detail: this.connected ? 'online' : 'reconnecting' }));
  }

  #overBudget() {
    const second = Math.floor(Date.now() / 1000);
    if (second !== this.budget.second) this.budget = { second, count: 0 };
    return ++this.budget.count > MAX_MESSAGES_PER_SECOND;
  }

  // Resolves as soon as one broker is connected and subscribed; the others keep
  // trying in the background. Rejects only if none answers in time.
  connect(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new Error('No relay answered'));
      }, timeoutMs);

      this.urls.forEach((url, i) => {
        const client = connect(url, {
          clientId: `pp_${newId()}`,
          keepalive: 45,
          reconnectPeriod: 2500,
          connectTimeout: 8000,
          clean: true,
          // if the tab dies without saying goodbye the broker tells the room, in our own sealed words
          will: { topic: `${this.base}/p/${this.myId}`, payload: this.lostNotice, retain: true, qos: 0 },
        });
        this.clients[i] = client;

        client.on('connect', () => {
          client.subscribe(`${this.base}/#`, { qos: 0 }, (err) => {
            if (err) {
              console.warn('Relay refused the subscription', { broker: url, error: err });
              return;
            }
            this.online.add(i);
            this.#status();
            if (!this.leaving) this.dispatchEvent(new CustomEvent('broker-online', { detail: i }));
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
          });
        });
        client.on('close', () => {
          if (!this.online.delete(i)) return;
          // whatever this broker told us about seats is no longer live
          for (const set of this.presenceOn.values()) set.delete(i);
          this.#status();
        });
        client.on('error', (e) => console.warn('Relay error', { broker: url, error: e?.message || e }));
        client.on('message', (topic, payload) => {
          if (payload.length > MAX_PAYLOAD || this.#overBudget()) return;
          // decrypt is async: chain it so messages are handled in arrival order
          this.queue = this.queue.then(() => this.#onMessage(i, topic, payload)).catch((e) => console.error('Failed to handle room message', { topic, error: e }));
        });
      });
    });
  }

  async #onMessage(broker, topic, payload) {
    const rel = topic.slice(this.base.length + 1);
    // an empty payload is a retained seat being cleared: tidy-up only, it proves nothing
    if (!payload.length) return;
    if (rel.startsWith('p/')) {
      const id = rel.slice(2);
      const data = await this.open(payload, rel);
      if (!data || data.id !== id) return;
      if (data.gone) return this.#onGone(broker, id, data);
      if (typeof data.sid === 'string') this.sids.set(id, data.sid);
      let set = this.presenceOn.get(id);
      if (!set) this.presenceOn.set(id, (set = new Set()));
      set.add(broker);
      this.dispatchEvent(new CustomEvent('presence', { detail: data }));
    } else if (rel === 'room') {
      const data = await this.open(payload, rel);
      if (data) this.dispatchEvent(new CustomEvent('room', { detail: data }));
    } else if (rel === 'evt') {
      const data = await this.open(payload, rel);
      if (!data || typeof data.eid !== 'string' || this.seenEvents.has(data.eid)) return;
      const now = Date.now();
      if (!Number.isFinite(data.ts) || data.ts < now - EVENT_MAX_AGE_MS || data.ts > now + EVENT_MAX_AGE_MS) return;
      this.seenEvents.set(data.eid, now);
      if (this.seenEvents.size > 500) for (const [k, t] of this.seenEvents) if (now - t > EVENT_MAX_AGE_MS) this.seenEvents.delete(k);
      this.dispatchEvent(new CustomEvent('event', { detail: data }));
    }
  }

  // "gone" only counts from the session we know for that seat, so an old notice replayed later does nothing
  #onGone(broker, id, data) {
    if (data.sid !== this.sids.get(id)) return;
    const set = this.presenceOn.get(id);
    if (data.gone === 'left') {
      this.presenceOn.delete(id);
      this.dispatchEvent(new CustomEvent('presence-gone', { detail: { id, left: true } }));
      return;
    }
    if (!set) return;
    set.delete(broker);
    if (set.size === 0) {
      this.presenceOn.delete(id);
      this.dispatchEvent(new CustomEvent('presence-gone', { detail: { id, left: false } }));
    }
  }

  async #publish(rel, obj, retain, only) {
    if (this.leaving) return;
    const payload = await this.seal(obj, rel);
    const topic = `${this.base}/${rel}`;
    const sends = [];
    this.clients.forEach((c, i) => {
      if (!c || !this.online.has(i) || (only != null && only !== i)) return;
      sends.push(new Promise((r) => c.publish(topic, payload, { qos: 0, retain }, r)));
    });
    await Promise.all(sends);
  }

  // `only` targets one broker, e.g. one that just came back online
  publishPresence(p, only) {
    return this.#publish(`p/${this.myId}`, { ...p, sid: this.sid }, true, only);
  }

  publishRoom(room, only) {
    return this.#publish('room', room, true, only);
  }

  sendEvent(evt) {
    return this.#publish('evt', { ...evt, eid: newId(), ts: Date.now() }, false);
  }

  // Synchronous on purpose: runs from pagehide, where awaited work never finishes.
  // mqtt.js queues writes asynchronously, so the packets go straight to the WebSocket,
  // which browsers still flush while the page closes.
  leaveNow() {
    this.leaving = true;
    const seat = `${this.base}/p/${this.myId}`;
    const empty = new Uint8Array(0);
    this.clients.forEach((c, i) => {
      if (!c || !this.online.has(i)) return;
      const ws = c.stream?.socket;
      if (ws instanceof WebSocket && ws.readyState === WebSocket.OPEN) {
        ws.send(publishPacket(seat, this.leftNotice, false));
        ws.send(publishPacket(seat, empty, true));
        ws.send(new Uint8Array([0xe0, 0x00])); // DISCONNECT: we left on purpose
      } else {
        c.publish(seat, this.leftNotice, { qos: 0, retain: false });
        c.publish(seat, empty, { qos: 0, retain: true });
      }
    });
  }

  close() {
    for (const c of this.clients) c?.end(true);
    this.online.clear();
  }

  // The Leave button: the page stays open, so send through mqtt.js and wait for it,
  // but never longer than a moment, and never let a reconnect put the seat back.
  async leave() {
    this.leaving = true;
    const seat = `${this.base}/p/${this.myId}`;
    const within = (ms, work) => Promise.race([work, new Promise((r) => setTimeout(r, ms))]);
    await within(
      1500,
      Promise.all(
        this.clients.map((c, i) => {
          if (!c || !this.online.has(i)) return null;
          c.publish(seat, this.leftNotice, { qos: 0, retain: false });
          return new Promise((r) => c.publish(seat, new Uint8Array(0), { qos: 0, retain: true }, r));
        }),
      ),
    );
    await within(1500, Promise.all(this.clients.map((c) => c && new Promise((r) => c.end(false, {}, r)))));
    this.online.clear();
  }
}
