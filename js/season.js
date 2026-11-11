// Seasonal dressing for the room. Halloween runs from 15 October to 10 November, Christmas
// from 11 November to 6 January; ?season=halloween, ?season=christmas or ?season=none in the
// address overrides the date for testing.
const FORCED = new Set(['halloween', 'christmas', 'none']);

export function seasonFor(date = new Date(), search = '') {
  const forced = new URLSearchParams(search).get('season');
  if (FORCED.has(forced)) return forced;
  const m = date.getMonth();
  const d = date.getDate();
  if ((m === 9 && d >= 15) || (m === 10 && d <= 10)) return 'halloween';
  if ((m === 10 && d >= 11) || m === 11 || (m === 0 && d <= 6)) return 'christmas';
  return 'none';
}
