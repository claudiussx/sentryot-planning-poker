// The planning room: wall, desks, characters and effects on one low-res canvas,
// with a DOM overlay for crisp name plates and click targets.
import { PAL, R, drawCharacter, drawChair, drawDesk, drawMark, drawText, SCENE, textWidth, drawIcon, drawEmoteBubble, drawBadgeCheck, seedOf, rng, shade } from './sprites.js';

const SW = 46; // seat width
const WH = 50; // wall height
const ROWH = 64;
const FIRST_DESK = WH + 22;
// keep in sync with the one-screen media query in style.css
const FIT_SCREEN = '(min-width: 1101px) and (min-height: 600px)';

const CONFETTI = [PAL.teal, PAL.cyan, PAL.gold, PAL.red, PAL.pink, PAL.green, PAL.white];

export class Scene {
  constructor(host, { onSeatClick } = {}) {
    this.host = host;
    this.onSeatClick = onSeatClick;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'scene-canvas';
    this.overlay = document.createElement('div');
    this.overlay.className = 'scene-overlay';
    host.append(this.canvas, this.overlay);
    this.ctx = this.canvas.getContext('2d');
    this.players = [];
    this.anim = new Map();
    this.seats = new Map();
    this.particles = [];
    this.balls = [];
    this.room = { revealed: false, consensus: false, timerEnd: null };
    this.still = false;
    this.calm = false;
    this.stars = Array.from({ length: 14 }, (_, i) => {
      const r = rng(i + 11);
      return { x: r(), y: r(), p: r() * 3000 };
    });
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(host);
    this.layout();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.remove();
    this.overlay.remove();
  }

  // ---------- state in ----------

  setPlayers(players) {
    const now = performance.now();
    const ids = new Set(players.map((p) => p.id));
    for (const [id, seat] of this.seats) {
      if (!ids.has(id)) {
        this.poof(seat.cx, seat.dy - 12, 14);
        this.anim.delete(id);
      }
    }
    for (const p of players) {
      let a = this.anim.get(p.id);
      if (!a) {
        a = { joinT: now, seed: seedOf(p.id) % 1000, pick: p.pick, revealT: 0, hitT: -1e9, emote: null, emoteUntil: 0, scribbleStart: -1e9, hadValue: p.vote != null };
        this.anim.set(p.id, a);
        a.needsPoof = true;
      }
      if (p.pick !== a.pick) {
        a.pick = p.pick;
        if (p.voted && !this.room.revealed) a.scribbleStart = now;
      }
      if (this.room.revealed && p.vote != null && !a.hadValue) a.revealT = Math.max(a.revealT, now);
      a.hadValue = p.vote != null;
    }
    this.players = players;
    this.layout();
  }

  setRoom(room) {
    const now = performance.now();
    if (room.revealed && !this.room.revealed) {
      this.players.forEach((p, i) => {
        const a = this.anim.get(p.id);
        if (a) a.revealT = now + i * 130;
      });
    }
    if (room.consensus && !this.room.consensus) setTimeout(() => this.confetti(), 300 + this.players.length * 130);
    this.room = { ...room };
  }

  // typing lasts until told otherwise, but never longer than this without a refresh
  setTyping(id, on) {
    const a = this.anim.get(id);
    if (a) a.typingUntil = on ? performance.now() + 7000 : 0;
  }

  emote(id, icon) {
    const a = this.anim.get(id);
    if (!a) return;
    a.emote = icon;
    a.emoteUntil = performance.now() + 2600;
  }

  throwBall(fromId, toId) {
    const from = this.seats.get(fromId);
    const to = this.seats.get(toId);
    if (!from || !to) return;
    // paper balls fly in every motion setting: it is the one thing people throw on purpose
    this.balls.push({ fx: from.cx + 6, fy: from.dy - 14, tx: to.cx, ty: to.dy - 20, start: performance.now(), dur: 700, toId });
  }

  // ---------- layout ----------

  layout() {
    const cw = this.host.clientWidth || 800;
    const ch = this.host.clientHeight;
    const n = Math.max(1, this.players.length);
    const measure = (S) => {
      const LW = Math.max(120, Math.floor(cw / S));
      const fit = Math.max(1, Math.floor((LW - 8) / SW));
      const rows = Math.ceil(n / fit);
      return { S, LW, rows, perRow: Math.ceil(n / rows), LH: FIRST_DESK + (rows - 1) * ROWH + 30 };
    };
    let m;
    if (matchMedia(FIT_SCREEN).matches && ch > 0) {
      // the page has a fixed height here: take the biggest pixel size whose table fits it
      for (const S of [5, 4, 3.5, 3, 2.5, 2, 1.5, 1]) {
        m = measure(S);
        if (m.LH * S <= ch) break;
      }
      m.LH = Math.max(m.LH, Math.floor(ch / m.S)); // extra height becomes floor
    } else {
      m = measure(cw < 560 ? 2 : cw < 1500 ? 3 : 4);
    }
    const { S, LW, rows, perRow, LH } = m;

    this.S = S;
    this.LW = LW;
    this.LH = LH;
    if (this.canvas.width !== LW || this.canvas.height !== LH) {
      this.canvas.width = LW;
      this.canvas.height = LH;
    }
    this.canvas.style.width = `${LW * S}px`;
    this.canvas.style.height = `${LH * S}px`;
    this.overlay.style.width = `${LW * S}px`;
    this.overlay.style.height = `${LH * S}px`;
    this.ctx.imageSmoothingEnabled = false;

    this.rows = [];
    this.seats = new Map();
    for (let r = 0; r < rows; r++) {
      const members = this.players.slice(r * perRow, (r + 1) * perRow);
      const x0 = Math.floor((LW - members.length * SW) / 2);
      const dy = FIRST_DESK + r * ROWH;
      this.rows.push({ x0, dy, w: members.length * SW, members });
      members.forEach((p, i) => this.seats.set(p.id, { cx: x0 + i * SW + SW / 2, dy, row: r }));
    }
    this.renderOverlay();
  }

  renderOverlay() {
    const S = this.S;
    const keep = new Set();
    for (const p of this.players) {
      const seat = this.seats.get(p.id);
      if (!seat) continue;
      keep.add(p.id);
      let el = this.overlay.querySelector(`[data-seat="${CSS.escape(p.id)}"]`);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'seat';
        el.dataset.seat = p.id;
        el.innerHTML = '<span class="plate"><span class="plate-name"></span></span>';
        el.addEventListener('click', () => this.onSeatClick?.(el.dataset.seat));
        this.overlay.append(el);
      }
      el.style.left = `${(seat.cx - SW / 2) * S}px`;
      el.style.top = `${(seat.dy - 46) * S}px`;
      el.style.width = `${SW * S}px`;
      el.style.height = `${65 * S}px`;
      // the card stands on the desk edge, a little taller than the old plate
      el.style.setProperty('--plate-top', `${52 * S}px`);
      el.style.setProperty('--plate-h', `${11 * S}px`);
      el.style.setProperty('--plate-inset', `${3 * S}px`);
      el.classList.toggle('is-me', !!p.isMe);
      el.classList.toggle('is-spectator', !!p.spectator);
      el.classList.toggle('is-host', !!p.isHost);
      el.classList.toggle('is-offline', !!p.offline);
      el.disabled = !!p.isMe;
      el.querySelector('.plate-name').textContent = p.name;
      el.title = p.isMe ? `${p.name} (you)` : `Throw a paper ball at ${p.name}`;
      el.setAttribute('aria-label', el.title);
    }
    for (const el of [...this.overlay.children]) if (!keep.has(el.dataset.seat)) el.remove();
  }

  // ---------- effects ----------

  poof(x, y, n = 10, colors = [PAL.value, PAL.secondary, PAL.white]) {
    if (this.still) return;
    for (let i = 0; i < n; i++) {
      const ang = (Math.PI * 2 * i) / n + Math.random() * 0.5;
      const sp = 0.4 + Math.random() * 0.6;
      this.particles.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 0.2, g: 0, life: 500 + Math.random() * 300, born: performance.now(), c: colors[i % colors.length], size: Math.random() < 0.4 ? 2 : 1 });
    }
  }

  confetti() {
    if (this.still) return;
    const now = performance.now();
    for (let i = 0; i < (this.calm ? 40 : 110); i++) {
      this.particles.push({
        x: Math.random() * this.LW,
        y: -Math.random() * 30,
        vx: (Math.random() - 0.5) * 0.6,
        vy: 0.2 + Math.random() * 0.4,
        g: 0.0008,
        max: 0.45 + Math.random() * 0.35,
        life: 3200 + Math.random() * 1600,
        born: now,
        c: CONFETTI[i % CONFETTI.length],
        size: Math.random() < 0.5 ? 2 : 1,
        wob: Math.random() * 6,
      });
    }
  }

  // ---------- drawing ----------

  // Motion 'off': time stands still for everything decorative, and state changes
  // (voting, reveal, joining) jump straight to their end pose.
  // Motion 'minimal': the room is a still picture except for slow ceiling lights;
  // people skip idle breathing and move at half speed, and what people do
  // (scribbling, raising signs, cheering, paper balls, emotes) still plays.
  setMotion(mode) {
    const still = mode === 'off';
    this.still = still;
    this.calm = mode === 'minimal';
    if (still) this.particles = [];
  }

  loop(t) {
    this.raf = requestAnimationFrame(this.loop);
    this.draw(this.still ? 0 : t);
  }

  drawWall(t) {
    const { ctx, LW } = this;
    R(ctx, 0, 0, LW, WH, PAL.wall);
    for (let x = 18; x < LW; x += 36) R(ctx, x, 0, 1, WH - 4, PAL.wallDark);
    R(ctx, 0, WH - 4, LW, 4, PAL.border);
    R(ctx, 0, WH - 4, LW, 1, PAL.borderLight);

    // floor
    R(ctx, 0, WH, LW, this.LH - WH, PAL.wallDark);
    for (let y = WH + 12; y < this.LH; y += 16) R(ctx, 0, y, LW, 1, PAL.floorLine);
    for (let x = 8; x < LW; x += 24) R(ctx, x, WH, 1, this.LH - WH, PAL.floorLine);

    // string lights
    for (let x = 4, i = 0; x < LW; x += 9, i++) {
      R(ctx, x, 3 + (i % 2), 3, 1, PAL.border);
      // minimal motion keeps only the lights, at a slower pace
      const on = Math.floor((this.calm ? t / 3.5 : t) / 600 + i) % 3 !== 0;
      R(ctx, x + 1, 4 + (i % 2), 1, 2, on ? CONFETTI[i % 5] : PAL.border);
    }

    // window: a starry night in the dark theme, a sunny day in the light one (a still picture in minimal motion)
    const tw = this.calm ? 0 : t;
    const wx = 8;
    const wy = 9;
    const ww = Math.min(44, Math.floor(LW / 4));
    R(ctx, wx - 2, wy - 2, ww + 4, 30, PAL.border);
    R(ctx, wx, wy, ww, 26, PAL.sky);
    if (SCENE.light) {
      R(ctx, wx + ww - 10, wy + 3, 6, 6, PAL.moon);
      R(ctx, wx + ww - 11, wy + 5, 8, 2, PAL.moon);
      R(ctx, wx + ww - 8, wy + 2, 2, 8, PAL.moon);
      // clouds drift slowly across
      for (const [i, cy] of [
        [0, 4],
        [1, 10],
      ]) {
        const cx = wx + ((Math.floor(tw / 400) + i * 23) % (ww + 12)) - 8;
        R(ctx, Math.max(wx, cx), wy + cy, Math.max(0, Math.min(8, wx + ww - cx)), 2, PAL.white);
        R(ctx, Math.max(wx, cx + 2), wy + cy - 1, Math.max(0, Math.min(4, wx + ww - cx - 2)), 1, PAL.white);
      }
    } else {
      R(ctx, wx + ww - 9, wy + 4, 5, 5, PAL.moon);
      R(ctx, wx + ww - 8, wy + 4, 2, 2, PAL.sky);
      for (const s of this.stars) {
        const on = (tw + s.p) % 3000 > 400;
        if (on) R(ctx, wx + 1 + Math.floor(s.x * (ww - 12)), wy + 1 + Math.floor(s.y * 14), 1, 1, s.x > 0.6 ? PAL.cyan : PAL.white);
      }
    }
    // little skyline, lit windows at night
    for (let x = 0, i = 0; x < ww; i++) {
      const bw = 4 + ((i * 7) % 5);
      const bh = 5 + ((i * 13) % 9);
      R(ctx, wx + x, wy + 26 - bh, Math.min(bw, ww - x), bh, PAL.skyline);
      if (i % 2 && !SCENE.light) R(ctx, wx + x + 1, wy + 26 - bh + 2, 1, 1, PAL.gold);
      x += bw + 1;
    }
    R(ctx, wx + Math.floor(ww / 2), wy, 1, 26, PAL.border);
    R(ctx, wx, wy + 13, ww, 1, PAL.border);
    R(ctx, wx - 3, wy + 26, ww + 6, 2, PAL.borderLight);

    // poster of the game's card
    const px = Math.floor(LW / 2) - 10;
    R(ctx, px - 1, 7, 22, 26, PAL.ink);
    R(ctx, px, 8, 20, 24, PAL.panel);
    drawMark(ctx, px + 1, 9);
    R(ctx, px + 4, 29, 12, 1, PAL.teal);

    // wall screen: countdown or clock
    const mw = 40;
    const mx = LW - mw - 8;
    if (mx > px + 26) {
      R(ctx, mx - 2, 7, mw + 4, 24, PAL.ink);
      R(ctx, mx, 9, mw, 20, PAL.screen);
      const steady = this.still || this.calm;
      let text;
      let color = PAL.tealDark;
      let blinkColon = false;
      if (this.room.timerEnd && !this.room.revealed) {
        const left = Math.max(0, Math.ceil((this.room.timerEnd - Date.now()) / 1000));
        text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        color = left <= 10 ? (steady || Math.floor(t / 250) % 2 ? PAL.red : shade(PAL.red, -0.35)) : PAL.teal;
      } else {
        const d = new Date();
        text = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        blinkColon = !steady && Math.floor(t / 1000) % 2 === 0;
      }
      // size from the text with its colon, so a blinking colon never changes the digit size
      const s = textWidth(text, 2) <= mw - 4 ? 2 : 1;
      const x0 = mx + Math.floor((mw - textWidth(text, s)) / 2);
      const y0 = 9 + Math.floor((20 - 5 * s) / 2);
      drawText(ctx, text, x0, y0, color, s);
      if (blinkColon) {
        const i = text.indexOf(':');
        drawText(ctx, ':', x0 + textWidth(text.slice(0, i), s) + s, y0, PAL.screen, s);
      }
      R(ctx, mx + mw / 2 - 3, 31, 6, 3, PAL.ink);
    }

    // plant
    if (LW > 230) {
      const plx = mx > px + 26 ? mx - 18 : LW - 16;
      R(ctx, plx, WH - 10, 9, 7, PAL.plantPot);
      R(ctx, plx - 1, WH - 11, 11, 2, shade(PAL.plantPot, 0.08));
      const sway = this.calm ? 0 : Math.floor(t / 900) % 2;
      R(ctx, plx + 3, WH - 20, 2, 9, PAL.leafDark);
      R(ctx, plx - 1 + sway, WH - 18, 4, 3, PAL.leaf);
      R(ctx, plx + 5 - sway, WH - 22, 4, 3, PAL.leaf);
      R(ctx, plx + 1, WH - 25, 4, 4, shade(PAL.leaf, 0.08));
    }
  }

  draw(t) {
    const { ctx } = this;
    const now = performance.now();
    ctx.clearRect(0, 0, this.LW, this.LH);
    this.drawWall(t);

    const revealed = this.room.revealed;
    const consensus = this.room.consensus;

    for (const row of this.rows) {
      for (const p of row.members) drawChair(ctx, this.seats.get(p.id).cx, row.dy);
      drawDesk(ctx, row.x0 - 4, row.dy, row.w + 8);
      row.members.forEach((p, i) => this.drawPlayer(p, i, t, now, revealed, consensus));
    }

    this.drawBalls(now);
    this.drawParticles(now);
  }

  drawPlayer(p, i, t, now, revealed, consensus) {
    const { ctx } = this;
    const seat = this.seats.get(p.id);
    const a = this.anim.get(p.id);
    if (!seat || !a) return;
    if (a.needsPoof) {
      a.needsPoof = false;
      this.poof(seat.cx, seat.dy - 14, 12, [PAL.teal, PAL.cyan, PAL.white]);
    }
    const { cx, dy } = seat;
    const still = this.still;
    const calm = this.calm;
    // people keep their own clock: at half speed in minimal motion
    const tp = calm ? t / 2 : t;
    const join = still ? 1 : Math.min(1, (now - a.joinT) / 450);
    // idle breathing is decoration: off in minimal motion, joining still slides in
    let bob = still ? 0 : Math.round((1 - join) * 26) + (calm || Math.floor((tp + a.seed * 13) / 700) % 2 ? 0 : -1);

    let pose;
    let raise = 1;
    const face = {};
    if (p.spectator) pose = 'spectator';
    else if (revealed) {
      if (p.vote != null) {
        raise = still ? 1 : Math.max(0, (now - a.revealT) / (calm ? 700 : 380));
        pose = consensus && raise >= 1 ? 'cheer' : 'reveal';
        if (!still && raise > 0.7 && raise < 1.3) bob -= 2;
        if (pose === 'cheer') bob = still ? 0 : -Math.round(Math.abs(Math.sin((tp + i * 160) / 170)) * (calm ? 2 : 4));
      } else pose = 'shrug';
    } else if (p.voted) {
      pose = !still && now - a.scribbleStart < 1300 ? 'scribble' : 'voted';
    } else if (p.away || p.offline) pose = 'away';
    else pose = 'think';

    const hit = now - a.hitT;
    let shake = 0;
    if (hit < 650) {
      shake = still ? 0 : Math.floor(hit / 60) % 2 ? 1 : -1;
      face.mouth = 'o';
    }

    const scribble = pose === 'scribble' ? (now - a.scribbleStart) / 1300 : 0;
    const paperFace = pose === 'voted' ? 'down' : 'up';
    drawCharacter(ctx, {
      cx: cx + shake,
      dy,
      look: p.look,
      pose,
      t: tp,
      seed: a.seed,
      bob,
      raise,
      value: p.vote,
      face,
      crown: p.isHost,
      thinkPhase: ((tp + a.seed * 53) % 6000) / 6000,
      paper: pose === 'spectator' || pose === 'reveal' || pose === 'cheer' ? null : { face: paperFace, scribble, seed: a.seed + a.pick },
    });

    const hy = dy - 24 + bob;
    const badgeY = hy - 15 + (calm || Math.floor(t / 400) % 2 ? 0 : -1);
    if (pose === 'voted') drawBadgeCheck(ctx, cx - 4, badgeY);
    if (pose === 'spectator' && !a.emote) {
      drawEmoteBubble(ctx, 'eye', cx + 5, hy - 13);
    }

    let bubble = null;
    if (a.emote && now < a.emoteUntil) bubble = a.emote;
    // the dots fill in one by one while someone types; steady when motion is reduced
    else if (a.typingUntil > now) bubble = still || calm ? 'talk' : ['talk1', 'talk2', 'talk'][Math.floor(t / 350) % 3];
    else if (hit < 650) bubble = 'bang';
    else if (pose === 'away') bubble = 'zzz';
    else if (pose === 'shrug') bubble = 'question';
    else if (pose === 'think' && !still && (t + a.seed * 71) % 9000 < 1600) bubble = 'question';
    if (bubble) {
      const pop = a.emote && now < a.emoteUntil ? Math.min(1, (2600 - (a.emoteUntil - now)) / 120) : 1;
      if (pop >= 1) {
        drawEmoteBubble(ctx, bubble, cx + 5, hy - 14);
      } else {
        R(ctx, cx + 8, hy - 11, 4, 4, PAL.white); // pop-in, at the bubble centre
      }
    }

    if (p.isMe && !revealed) {
      // a little floor arrow under my seat
      const ay = dy + 21 + (calm ? 0 : Math.floor(t / 350) % 2);
      R(ctx, cx - 2, ay + 2, 5, 1, PAL.teal);
      R(ctx, cx - 1, ay + 1, 3, 1, PAL.teal);
      R(ctx, cx, ay, 1, 1, PAL.teal);
    }
  }

  drawBalls(now) {
    const { ctx } = this;
    this.balls = this.balls.filter((b) => {
      const k = (now - b.start) / b.dur;
      if (k >= 1) {
        const a = this.anim.get(b.toId);
        if (a) a.hitT = now;
        this.poof(b.tx, b.ty, 8, [PAL.paper, PAL.paperShade]);
        return false;
      }
      const x = b.fx + (b.tx - b.fx) * k;
      const y = b.fy + (b.ty - b.fy) * k - Math.sin(Math.PI * k) * (26 + Math.abs(b.tx - b.fx) * 0.15);
      R(ctx, x - 1, y - 1, 3, 3, PAL.paper);
      R(ctx, x, y, 1, 1, PAL.paperShade);
      R(ctx, x - 1, y + 1, 1, 1, shade(PAL.paperShade, -0.1));
      return true;
    });
  }

  drawParticles(now) {
    const { ctx } = this;
    this.particles = this.particles.filter((p) => {
      const age = now - p.born;
      if (age > p.life || p.y > this.LH + 4) return false;
      p.vy += p.g * 16;
      if (p.max) p.vy = Math.min(p.vy, p.max);
      p.x += p.vx + (p.wob ? Math.sin((age + p.wob * 100) / 200) * 0.2 : 0);
      p.y += p.vy;
      if (!p.g) {
        p.vx *= 0.94;
        p.vy *= 0.94;
      }
      R(ctx, p.x, p.y, p.size, p.size, p.c);
      return true;
    });
  }
}
