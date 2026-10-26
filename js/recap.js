// End-of-session recap: what this browser saw at the reveals, turned into a few silly awards.
import { computeStats, scaleOf, formatScale } from './stats.js';

const times = (n) => (n === 1 ? 'once' : `${n} times`);

// rounds: [{ label, revote, deck, votes: [{ id, name, vote }], first: id of the first voter or null }]
export function computeRecap(rounds) {
  const played = rounds.filter((r) => r.votes.length);
  const people = new Map();
  const person = (id, name) => {
    let p = people.get(id);
    if (!p) people.set(id, (p = { name, match: 0, first: 0, edge: 0, coffee: 0, unsure: 0 }));
    p.name = name; // the latest name wins
    return p;
  };
  let consensus = 0;
  let agreement = 0;
  let scored = 0;
  const list = [];
  for (const r of played) {
    const s = computeStats(r.votes, r.deck);
    if (s.consensus) consensus++;
    if (s.numericCount) {
      agreement += s.agreement;
      scored++;
    }
    for (const v of r.votes) {
      const p = person(v.id, v.name);
      if (v.vote === 'coffee') p.coffee++;
      if (v.vote === '?') p.unsure++;
      const n = scaleOf(r.deck, v.vote);
      if (n == null) continue;
      if (n === s.suggested) p.match++;
      if (s.spread && (n === s.min || n === s.max)) p.edge++;
    }
    const first = r.votes.find((v) => v.id === r.first);
    if (first) person(first.id, first.name).first++;
    list.push({ label: r.label, revote: r.revote || 0, result: formatScale(r.deck, s.suggested), consensus: s.consensus, votes: s.total });
  }

  const award = (key, title, icon, line) => {
    const best = Math.max(0, ...[...people.values()].map((p) => p[key]));
    if (!best) return null;
    const names = [...people.values()].filter((p) => p[key] === best).map((p) => p.name);
    return { key, title, icon, names: names.slice(0, 3), more: Math.max(0, names.length - 3), line: line(best) };
  };
  return {
    rounds: played.length,
    consensus,
    agreement: scored ? Math.round(agreement / scored) : null,
    awards: [
      award('match', 'Mind reader', 'idea', (n) => `picked the suggested card ${times(n)}`),
      award('first', 'Fastest draw', 'rocket', (n) => `first to vote ${times(n)}`),
      award('edge', 'Wild card', 'fire', (n) => `at the edge of a big spread ${times(n)}`),
      award('coffee', 'Coffee lover', 'coffee', (n) => `asked for coffee ${times(n)}`),
      award('unsure', 'Deep thinker', 'question', (n) => `played ? ${times(n)}`),
    ].filter(Boolean),
    list,
  };
}
