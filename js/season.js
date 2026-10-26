// Seasonal dressing for the room. Halloween runs from 15 October to 15 November;
// ?season=halloween or ?season=none in the address overrides the date for testing.
export function seasonFor(date = new Date(), search = '') {
  const forced = new URLSearchParams(search).get('season');
  if (forced === 'halloween' || forced === 'none') return forced;
  const m = date.getMonth();
  const d = date.getDate();
  return (m === 9 && d >= 15) || (m === 10 && d <= 15) ? 'halloween' : 'none';
}
