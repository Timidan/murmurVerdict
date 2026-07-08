export interface PublicEmbedScriptInput {
  publicUrl: string;
}

export function publicEmbedScript(input: PublicEmbedScriptInput): string {
  return PUBLIC_EMBED_SCRIPT_TEMPLATE.replace(
    /__PUBLIC_URL__/g,
    JSON.stringify(input.publicUrl),
  );
}

// Drop-in widget served at /embed.js. Single-file vanilla JS with no build step
// and no runtime deps.
const PUBLIC_EMBED_SCRIPT_TEMPLATE = `(function () {
  var BASE = __PUBLIC_URL__;
  var script = document.currentScript;
  if (!script) return;
  var slug = script.getAttribute("data-slug");
  if (!slug) {
    console.warn("[murmur-embed] missing data-slug on the <script> tag");
    return;
  }
  var variant = script.getAttribute("data-variant") || "badge";
  var href = script.getAttribute("data-href") || (BASE + "/share/" + encodeURIComponent(slug));
  var live = script.getAttribute("data-no-live") !== "true";
  var mediaVersion = +(script.getAttribute("data-version") || "0");
  if (mediaVersion !== mediaVersion || mediaVersion < 0) mediaVersion = 0;

  function mediaUrl() {
    return BASE + "/v1/" + (variant === "og" ? "og" : "badge") + "/" + encodeURIComponent(slug) + ".svg?v=" + mediaVersion;
  }

  function refreshMedia() {
    mediaVersion += 1;
    built.img.src = mediaUrl();
  }

  function build() {
    var img = document.createElement("img");
    img.src = mediaUrl();
    img.alt = slug + " on Murmur Verdict";
    img.loading = "lazy";
    img.style.display = "inline-block";
    img.style.maxWidth = "100%";
    img.style.height = "auto";
    if (variant === "badge") {
      img.width = 320;
      img.height = 80;
    } else {
      img.width = 1200;
      img.height = 630;
    }
    var anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.style.display = "inline-block";
    anchor.style.textDecoration = "none";
    anchor.appendChild(img);
    return { anchor: anchor, img: img };
  }

  var built = build();
  if (script.parentNode) {
    script.parentNode.insertBefore(built.anchor, script);
  }

  if (!live || typeof EventSource === "undefined") return;

  var es;
  var attempt = 0;
  function connect() {
    try {
      es = new EventSource(BASE + "/v1/stream");
    } catch (e) {
      return;
    }
    es.addEventListener("leaderboard.update", function () {
      refreshMedia();
    });
    es.addEventListener("call.resolved", function (ev) {
      try {
        var p = JSON.parse(ev.data || "{}");
        if (p.agent_slug && p.agent_slug !== slug) return;
        refreshMedia();
      } catch (e) {}
    });
    es.onerror = function () {
      if (es) es.close();
      es = null;
      var delay = Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 6)));
      attempt++;
      setTimeout(connect, delay);
    };
  }
  connect();
})();
`;
