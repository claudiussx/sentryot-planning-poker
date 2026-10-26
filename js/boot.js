// Runs before first paint (a plain script, not a module) so saved choices do not flash.
(function () {
  var root = document.documentElement;
  try {
    var theme = localStorage.getItem('sop.theme');
    if (theme !== 'light' && theme !== 'dark') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    root.dataset.theme = theme;
    var font = localStorage.getItem('sop.font');
    if (font === 'normal' || font === 'minecraft') root.dataset.font = font;
    var motion = localStorage.getItem('sop.motion');
    // minimal motion unless the person picked something else
    if (motion !== 'on' && motion !== 'minimal' && motion !== 'off') motion = 'minimal';
    root.dataset.motion = motion;
  } catch (e) {
    root.dataset.theme = 'dark';
  }
})();
