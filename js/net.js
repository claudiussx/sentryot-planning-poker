// Realtime room over public MQTT brokers (WebSocket). Everything after the '#'
// in the invite link stays in the browser: the topic is a hash of the room
// token and every payload is AES-GCM encrypted with a key derived from it, so
// the brokers only ever relay ciphertext.
//
// Public brokers are free and occasionally flaky, so every client talks to all
// of them at once, publishes to each and de-duplicates what comes back. One
// broker going down does not empty the room.
import mqttModule from '../vendor/mqtt.esm.js';

const connect = mqttModule.connect || mqttModule.default?.connect;

export const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const NS = 'sentryot-poker/v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(12)));
}

export function newId() {
  return b64url(crypto.getRandomValues(new Uint8Array(6)));
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export class RoomClient extends EventTarget {
  constructor({ token, myId, brokers = BROKERS }) {
    super();
    this.token = token;
    this.myId = myId;
    this.urls = brokers;
    this.clients = [];
    this.online = new Set(); // broker indexes we are connected to
    this.presenceOn = new Map(); // peer id -> broker indexes that currently hold their seat
    this.seenEvents = new Map(); // event id -> time, to drop the copies from other brokers
    this.queue = Promise.resolve();
  }

  async init() {
    const topicHash = await sha256(`topic:${this.token}`);
    this.base = `${NS}/${[...topicHash.slice(0, 10)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    this.key = await crypto.subtle.importKey('raw', await sha256(`key:${this.token}`), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  get connected() {
    return this.online.size > 0;
  }

  async seal(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, enc.encode(JSON.stringify(obj))));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    return out;
  }

  async open(bytes) {
    if (!bytes || bytes.length < 13) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, this.key, bytes.slice(12));
      return JSON.parse(dec.decode(plain));
    } catch {
      return null; // not ours, or tampered with
    }
  }

  #status() {
    this.dispatchEvent(new CustomEvent('status', { detail: this.connected ? 'online' : 'reconnecting' }));
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
          clientId: `sop_${newId()}`,
          keepalive: 20,
          reconnectPeriod: 2500,
          connectTimeout: 8000,
          clean: true,
          // the broker clears our seat if the tab dies without saying goodbye
          will: { topic: `${this.base}/p/${this.myId}`, payload: new Uint8Array(0), retain: true, qos: 0 },
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
            this.dispatchEvent(new CustomEvent('broker-online', { detail: i }));
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
        // decrypt is async: chain it so messages are handled in arrival order
        client.on('message', (topic, payload) => {
          this.queue = this.queue.then(() => this.#onMessage(i, topic, payload)).catch((e) => console.error('Failed to handle room message', { topic, error: e }));
        });
      });
    });
  }

  async #onMessage(broker, topic, payload) {
    const rel = topic.slice(this.base.length + 1);
    if (rel.startsWith('p/')) {
      const id = rel.slice(2);
      let set = this.presenceOn.get(id);
      if (!payload.length) {
        if (!set) return;
        set.delete(broker);
        if (set.size === 0) {
          this.presenceOn.delete(id);
          this.dispatchEvent(new CustomEvent('presence-gone', { detail: { id } }));
        }
        return;
      }
      const data = await this.open(payload);
      if (!data || data.id !== id) return;
      if (!set) this.presenceOn.set(id, (set = new Set()));
      set.add(broker);
      this.dispatchEvent(new CustomEvent('presence', { detail: data }));
    } else if (rel === 'room') {
      const data = await this.open(payload);
      if (data) this.dispatchEvent(new CustomEvent('room', { detail: data }));
    } else if (rel === 'evt') {
      const data = await this.open(payload);
      if (!data || typeof data.eid !== 'string' || this.seenEvents.has(data.eid)) return;
      const now = Date.now();
      this.seenEvents.set(data.eid, now);
      for (const [k, t] of this.seenEvents) if (now - t > 60_000) this.seenEvents.delete(k);
      this.dispatchEvent(new CustomEvent('event', { detail: data }));
    }
  }

  async #publish(rel, obj, retain, only) {
    const payload = obj == null ? new Uint8Array(0) : await this.seal(obj);
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
    return this.#publish(`p/${this.myId}`, p, true, only);
  }

  publishRoom(room, only) {
    return this.#publish('room', room, true, only);
  }

  sendEvent(evt) {
    return this.#publish('evt', { ...evt, eid: newId() }, false);
  }

  close() {
    for (const c of this.clients) c?.end(true);
    this.online.clear();
  }

  async leave() {
    try {
      await this.#publish(`p/${this.myId}`, null, true);
    } finally {
      await Promise.all(this.clients.map((c) => c && new Promise((r) => c.end(false, {}, r))));
      this.online.clear();
    }
  }
}
