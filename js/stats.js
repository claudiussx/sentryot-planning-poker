// Pure voting maths, shared by the UI and the node tests.

// The host picks one deck per room. '?' and coffee are in every deck and never count.
export const DECKS = {
  fib: { id: 'fib', name: 'Fibonacci', cards: ['0.5', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', 'coffee'] },
  tshirt: { id: 'tshirt', name: 'T-shirt', cards: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?', 'coffee'] },
  hours: { id: 'hours', name: 'Hours', cards: ['1h', '2h', '4h', '8h', '16h', '24h', '40h', '?', 'coffee'] },
};
export const DECK_IDS = Object.keys(DECKS);
export const DECK = DECKS.fib.cards;
// any card from any deck: what a vote may be on the wire
export const ALL_CARDS = new Set(DECK_IDS.flatMap((id) => DECKS[id].cards));

export function deckOf(id) {
  return DECKS[id] || DECKS.fib;
}

const scored = (deck) => deck.cards.filter((c) => c !== '?' && c !== 'coffee');

// Where a card sits on its deck's scale: points and hours by number, sizes by position.
export function scaleOf(deckId, v) {
  const deck = deckOf(deckId);
  if (!scored(deck).includes(v)) return null;
  if (deck.id === 'tshirt') return scored(deck).indexOf(v);
  return Number(deck.id === 'hours' ? v.slice(0, -1) : v);
}

// A number on the deck's scale back as text: 5, 8h, or the nearest size.
export function formatScale(deckId, n) {
  if (n == null) return '-';
  const deck = deckOf(deckId);
  if (deck.id === 'tshirt') return nearestCard(deckId, n);
  return deck.id === 'hours' ? `${n}h` : String(n);
}

// the card closest to a number on the scale; ties go to the larger card: estimates round up
export function nearestCard(deckId, n) {
  let best = null;
  let bestD = Infinity;
  for (const c of scored(deckOf(deckId))) {
    const d = Math.abs(scaleOf(deckId, c) - n);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export const NUMERIC_DECK = scored(DECKS.fib).map(Number);

export function isNumeric(v) {
  return typeof v === 'string' && v !== '' && !Number.isNaN(Number(v));
}

export function label(v) {
  if (v === 'coffee') return 'Coffee';
  return v;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

export function nearestDeckValue(n) {
  return Number(nearestCard('fib', n));
}

// votes: [{ id, name, vote }] where vote is a card of the deck; numbers come back on the deck's scale
export function computeStats(votes, deckId = 'fib') {
  const deck = deckOf(deckId);
  const valid = votes.filter((v) => deck.cards.includes(v.vote));
  const numeric = valid.filter((v) => scaleOf(deck.id, v.vote) != null).map((v) => ({ ...v, n: scaleOf(deck.id, v.vote) }));
  const counts = new Map();
  for (const v of valid) counts.set(v.vote, (counts.get(v.vote) || []).concat(v.name));
  const distribution = deck.cards.filter((d) => counts.has(d)).map((d) => ({ value: d, count: counts.get(d).length, names: counts.get(d) }));

  const result = {
    total: valid.length,
    numericCount: numeric.length,
    unsure: (counts.get('?') || []).length,
    coffee: (counts.get('coffee') || []).length,
    distribution,
    average: null,
    median: null,
    min: null,
    max: null,
    suggested: null,
    consensus: false,
    agreement: 0,
    spread: null,
  };
  if (!numeric.length) return result;

  const sorted = numeric.map((v) => v.n).sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mid = Math.floor(sorted.length / 2);
  result.average = round1(sum / sorted.length);
  result.median = sorted.length % 2 ? sorted[mid] : round1((sorted[mid - 1] + sorted[mid]) / 2);
  result.min = sorted[0];
  result.max = sorted[sorted.length - 1];
  result.suggested = scaleOf(deck.id, nearestCard(deck.id, sum / sorted.length));

  const topCount = Math.max(...distribution.filter((d) => scaleOf(deck.id, d.value) != null).map((d) => d.count));
  result.agreement = Math.round((topCount / numeric.length) * 100);
  result.consensus = numeric.length >= 2 && result.min === result.max && result.unsure === 0;

  // two or more cards apart on the deck: worth a conversation
  const steps = scored(deck).map((c) => scaleOf(deck.id, c));
  const gap = steps.indexOf(result.max) - steps.indexOf(result.min);
  if (gap >= 3) {
    const low = numeric.find((v) => v.n === result.min);
    const high = numeric.find((v) => v.n === result.max);
    result.spread = { low: { name: low.name, vote: low.vote }, high: { name: high.name, vote: high.vote } };
  }
  return result;
}
