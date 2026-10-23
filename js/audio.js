// Tiny chiptune blips with WebAudio. No files to load.
let ctx = null;
let muted = false;
try {
  muted = localStorage.getItem('sop.muted') === '1';
} catch {
  /* storage blocked: default to sound on */
}

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, start, dur, { type = 'square', vol = 0.05, slide = 0 } = {}) {
  const a = ac();
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime + start);
  if (slide) o.frequency.linearRampToValueAtTime(freq + slide, a.currentTime + start + dur);
  g.gain.setValueAtTime(vol, a.currentTime + start);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + start);
  o.stop(a.currentTime + start + dur + 0.02);
}

const SOUNDS = {
  join: () => [523, 659, 784].forEach((f, i) => tone(f, i * 0.07, 0.09)),
  leave: () => [392, 311].forEach((f, i) => tone(f, i * 0.08, 0.1, { vol: 0.03 })),
  pick: () => tone(880, 0, 0.05, { vol: 0.035 }),
  scribble: () => {
    for (let i = 0; i < 6; i++) tone(200 + Math.random() * 300, i * 0.06, 0.04, { type: 'sawtooth', vol: 0.012 });
  },
  reveal: () => [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.08, 0.12, { vol: 0.045 })),
  consensus: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i * 0.1, 0.14, { type: 'triangle', vol: 0.08 })),
  round: () => [659, 523].forEach((f, i) => tone(f, i * 0.09, 0.1, { vol: 0.035 })),
  throw: () => tone(300, 0, 0.25, { type: 'triangle', vol: 0.05, slide: 500 }),
  hit: () => tone(160, 0, 0.12, { type: 'square', vol: 0.05, slide: -80 }),
  tick: () => tone(1200, 0, 0.03, { vol: 0.02 }),
  emote: () => tone(1046, 0, 0.06, { type: 'triangle', vol: 0.05 }),
};

export function play(name) {
  if (muted) return;
  try {
    SOUNDS[name]?.();
  } catch {
    /* audio not available: stay silent */
  }
}

export function isMuted() {
  return muted;
}

export function setMuted(m) {
  muted = m;
  try {
    localStorage.setItem('sop.muted', m ? '1' : '0');
  } catch {
    /* ignore */
  }
}
