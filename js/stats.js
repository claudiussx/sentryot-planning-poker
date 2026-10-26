// Pure voting maths, shared by the UI and the node tests.

export const DECK = ['0.5', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', 'coffee'];
export const NUMERIC_DECK = DECK.filter((v) => isNumeric(v)).map(Number);

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
  let best = NUMERIC_DECK[0];
  for (const d of NUMERIC_DECK) {
    // ties go to the larger card: estimates round up
    if (Math.abs(d - n) <= Math.abs(best - n)) best = d;
  }
  return best;
}

// votes: [{ id, name, vote }] where vote is a deck value
export function computeStats(votes) {
  const valid = votes.filter((v) => DECK.includes(v.vote));
  const numeric = valid.filter((v) => isNumeric(v.vote)).map((v) => ({ ...v, n: Number(v.vote) }));
  const counts = new Map();
  for (const v of valid) counts.set(v.vote, (counts.get(v.vote) || []).concat(v.name));
  const distribution = DECK.filter((d) => counts.has(d)).map((d) => ({ value: d, count: counts.get(d).length, names: counts.get(d) }));

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
  result.suggested = nearestDeckValue(sum / sorted.length);

  const topCount = Math.max(...distribution.filter((d) => isNumeric(d.value)).map((d) => d.count));
  result.agreement = Math.round((topCount / numeric.length) * 100);
  result.consensus = numeric.length >= 2 && result.min === result.max && result.unsure === 0;

  // two or more cards apart on the deck: worth a conversation
  const gap = NUMERIC_DECK.indexOf(result.max) - NUMERIC_DECK.indexOf(result.min);
  if (gap >= 3) {
    const low = numeric.find((v) => v.n === result.min);
    const high = numeric.find((v) => v.n === result.max);
    result.spread = { low: { name: low.name, vote: low.vote }, high: { name: high.name, vote: high.vote } };
  }
  return result;
}
