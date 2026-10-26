// The simple view (for boring people): the same table as plain cards with names and votes.
// It answers to everything the pixel room does, so the page can swap one for the other.
import { label } from './stats.js';
import { drawIconCentered, SHIRTS } from './sprites.js';

const MARK_MS = 2600;

function iconCanvas(name, cls) {
  const c = document.createElement('canvas');
  c.width = 9;
  c.height = 9;
  c.className = cls;
  drawIconCentered(c.getContext('2d'), name, 0, 0, 9, 9);
  return c;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export class SimpleTable {
  constructor(host) {
    this.root = el('div', 'simple');
    this.root.setAttribute('role', 'list');
    host.append(this.root);
    this.players = [];
    this.room = { revealed: false, consensus: false };
    this.marks = new Map(); // id -> { icon, until }
    this.typing = new Set();
    this.timers = new Set();
  }

  destroy() {
    for (const t of this.timers) clearTimeout(t);
    this.root.remove();
  }

  // the pixel room's motion, layout and paper balls have nothing to do here
  setMotion() {}
  layout() {}
  throwBall() {}

  setPlayers(players) {
    this.players = players;
    this.render();
  }

  setRoom(room) {
    this.room = room;
    this.render();
  }

  setTyping(id, on) {
    if (on) this.typing.add(id);
    else this.typing.delete(id);
    this.render();
  }

  emote(id, icon) {
    this.mark(id, icon);
  }

  poke(ids) {
    for (const id of ids) this.mark(id, 'bang');
  }

  mark(id, icon) {
    this.marks.set(id, { icon, until: Date.now() + MARK_MS });
    this.render();
    const t = setTimeout(() => {
      this.timers.delete(t);
      if ((this.marks.get(id)?.until ?? 0) <= Date.now()) {
        this.marks.delete(id);
        this.render();
      }
    }, MARK_MS + 20);
    this.timers.add(t);
  }

  render() {
    const { revealed, consensus } = this.room;
    const keep = new Set();
    for (const p of this.players) {
      keep.add(p.id);
      let seat = this.root.querySelector(`[data-seat="${CSS.escape(p.id)}"]`);
      if (!seat) {
        seat = el('div', 'simple-seat');
        seat.dataset.seat = p.id;
        seat.setAttribute('role', 'listitem');
        this.root.append(seat);
      }
      // each part is rebuilt only when it changes, so a card flips once and not on every update
      const cardKey = JSON.stringify([p.spectator, revealed, consensus, p.voted, p.vote]);
      if (seat.dataset.card !== cardKey) {
        seat.dataset.card = cardKey;
        seat.querySelector('.simple-card')?.remove();
        seat.prepend(this.card(p, revealed, consensus));
      }
      const nameKey = JSON.stringify([p.name, p.isMe, p.isHost, p.look.shirt, this.status(p, revealed)]);
      if (seat.dataset.name !== nameKey) {
        seat.dataset.name = nameKey;
        seat.querySelectorAll('.simple-name, .simple-state').forEach((e) => e.remove());
        seat.querySelector('.simple-card').after(this.nameRow(p), el('div', 'simple-state', this.status(p, revealed)));
      }
      const mark = this.marks.get(p.id)?.icon ?? '';
      if (seat.dataset.mark !== mark) {
        seat.dataset.mark = mark;
        seat.querySelector('.simple-mark')?.remove();
        if (mark) seat.append(iconCanvas(mark, 'simple-mark'));
      }
      seat.classList.toggle('is-me', !!p.isMe);
      seat.classList.toggle('is-offline', !!p.offline);
      seat.classList.toggle('is-spectator', !!p.spectator);
    }
    for (const s of [...this.root.children]) if (!keep.has(s.dataset.seat)) s.remove();
  }

  card(p, revealed, consensus) {
    const card = el('div', 'simple-card');
    if (p.spectator) {
      card.classList.add('is-watching');
      card.append(iconCanvas('eye', 'simple-icon'));
    } else if (revealed && p.vote != null) {
      card.classList.add('is-up');
      if (consensus) card.classList.add('is-agree');
      if (p.vote === 'coffee') card.append(iconCanvas('coffee', 'simple-icon'));
      else {
        const v = el('span', 'simple-val', label(p.vote));
        if (label(p.vote).length >= 3) v.classList.add('is-long');
        card.append(v);
      }
    } else if (p.voted) {
      card.classList.add(revealed ? 'is-waiting' : 'is-down');
    } else {
      card.classList.add('is-empty');
    }
    return card;
  }

  nameRow(p) {
    const row = el('div', 'simple-name');
    const dot = el('span', 'simple-dot');
    dot.style.background = SHIRTS[p.look.shirt];
    row.append(dot, el('span', 'simple-name-text', p.isMe ? `${p.name} (you)` : p.name));
    if (p.isHost) row.append(el('span', 'simple-host', 'HOST'));
    return row;
  }

  status(p, revealed) {
    if (p.spectator) return 'watching';
    if (revealed) return p.vote != null ? (p.vote === 'coffee' ? 'coffee' : 'voted') : p.voted ? '...' : 'no vote';
    if (p.voted) return 'ready';
    if (p.offline) return 'asleep';
    if (this.typing.has(p.id)) return 'typing...';
    return p.away ? 'away' : 'thinking';
  }
}
