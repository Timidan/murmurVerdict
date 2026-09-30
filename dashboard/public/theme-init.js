// Theme bootstrap — loaded synchronously (no defer) BEFORE the fonts
// stylesheet link, to avoid a render-blocking gap where the page could
// otherwise paint with the wrong theme on slow networks. Lives as a file,
// not inline, so the CSP can stay script-src 'self' with no hash to
// maintain. Mirrors logic in dashboard/src/verdict/ui/theme.ts
// (resolveTheme + applyTheme). Keep in sync.
(function () {
  function applyFavicons(theme) {
    var svg = document.getElementById("favicon-svg");
    var ico = document.getElementById("favicon-ico");
    var apple = document.getElementById("apple-touch");
    if (svg) svg.setAttribute("href", "/brand/favicon-" + theme + ".svg");
    if (ico) ico.setAttribute("href", "/brand/favicon-" + theme + ".ico");
    if (apple) apple.setAttribute("href", "/brand/app-icon-" + theme + ".png");
    var meta = document.getElementById("meta-theme-color");
    if (meta) meta.setAttribute("content", theme === "paper" ? "#FCF9F2" : "#000000");
  }
  var stored = null;
  try {
    stored = localStorage.getItem("murmur.theme");
  } catch (e) {
    // localStorage may be blocked; treat as "no stored value" and continue.
  }
  var prefersLight =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  var theme =
    stored === "paper" || stored === "dark"
      ? stored
      : prefersLight
      ? "paper"
      : "dark";
  if (theme === "paper") {
    document.documentElement.setAttribute("data-theme", "paper");
  }
  applyFavicons(theme);

  // The sting is black and cannot paint until React mounts, so without
  // this the first visit flashes the theme background then slams to black.
  // Decide here, synchronously, and paint the backdrop before first paint.
  try {
    // Path AND hash must both point at the landing page: routing is
    // path-based now (route.ts canonicalizes #/x to /x), so a deep link
    // like /leaderboard arrives with an empty hash. Mirrors the landing
    // set in route.ts parseLocation. Keep in sync.
    var h = window.location.hash;
    var pth = window.location.pathname;
    var onLanding =
      (h === "" || h === "#" || h === "#/") &&
      (pth === "/" || pth === "" || pth === "/landing");
    var seen = localStorage.getItem("murmur.sting.seen") === "1";
    var reduced =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (onLanding && !seen && !reduced) {
      document.documentElement.setAttribute("data-sting", "");
    }
  } catch (e) {
    // storage blocked — skip the sting backdrop rather than guess
  }
})();
