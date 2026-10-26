// Runs before first paint (a plain script, not a module) so saved choices do not flash.
(function () {
  var root = document.documentElement;
  try {
    var theme = localStorage.getItem('sop.theme');
    if (theme !== 'light' && theme !== 'dark') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    root.dataset.theme = theme;
    if (localStorage.getItem('sop.font') === 'normal') root.dataset.font = 'normal';
    var motion = localStorage.getItem('sop.motion');
    if (motion !== 'on' && motion !== 'minimal' && motion !== 'off') motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'minimal' : 'on';
    root.dataset.motion = motion;
  } catch (e) {
    root.dataset.theme = 'dark';
  }
})();
