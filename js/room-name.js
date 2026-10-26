// Named rooms: everyone who types the same room name lands in the same room.
// "Sprint 43 Planning", "sprint-43-planning" and " sprint 43  planning " are one room.
export function roomSlug(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

const TOKEN = /^[A-Za-z0-9_-]{12,32}$/;

// '#r=<token>' is a private room (random secret), '#room=<name>' a named one.
export function parseRoomHash(hash) {
  const h = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const r = h.get('r');
  // a malformed private link is refused, never turned into a guessable named room
  if (r != null) return TOKEN.test(r) ? { token: r } : null;
  const slug = roomSlug(h.get('room') || '');
  return slug ? { token: `room:${slug}`, slug } : null;
}
