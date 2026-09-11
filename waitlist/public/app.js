// Murmur waitlist — form handling + theme toggle
// No dependencies, no build step.

(function () {
  "use strict";

  // ── Theme ──────────────────────────────────────────────────────────

  var STORAGE_KEY = "murmur.theme";

  function resolveTheme() {
    var stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) { /* private */ }
    if (stored === "paper" || stored === "dark") return stored;
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return "paper";
    return "dark";
  }

  function applyTheme(theme) {
    if (theme === "paper") {
      document.documentElement.setAttribute("data-theme", "paper");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    var meta = document.getElementById("meta-theme-color");
    if (meta) meta.setAttribute("content", theme === "paper" ? "#FCF9F2" : "#0A0A0A");
    var svg = document.getElementById("favicon-svg");
    if (svg) svg.href = "/brand/favicon-" + theme + ".svg";
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) { /* private */ }
  }

  // Runs from the document head before styles paint.
  applyTheme(resolveTheme());

  function bindPage() {
  var toggleBtn = document.getElementById("theme-toggle");
  if (toggleBtn) {
    function updateToggleLabel() {
      var current = document.documentElement.getAttribute("data-theme") === "paper" ? "paper" : "dark";
      var next = current === "paper" ? "dark" : "paper";
      toggleBtn.setAttribute("aria-label", "Switch to " + next + " mode");
      toggleBtn.setAttribute("aria-pressed", String(current === "paper"));
      toggleBtn.querySelector("[data-icon]").textContent = current === "paper" ? "◐" : "◑";
      toggleBtn.querySelector("[data-label]").textContent = next;
    }
    updateToggleLabel();

    toggleBtn.addEventListener("click", function () {
      var current = document.documentElement.getAttribute("data-theme") === "paper" ? "paper" : "dark";
      var next = current === "paper" ? "dark" : "paper";
      applyTheme(next);
      updateToggleLabel();
    });

    // Cross-tab sync
    window.addEventListener("storage", function (ev) {
      if (ev.key !== STORAGE_KEY) return;
      applyTheme(resolveTheme());
      updateToggleLabel();
    });
  }

  // ── Waitlist form ──────────────────────────────────────────────────

  var form = document.getElementById("waitlist-form");
  var emailInput = document.getElementById("waitlist-email");
  var honeypot = document.getElementById("waitlist-hp");
  var submitBtn = document.getElementById("waitlist-submit");
  var statusEl = document.getElementById("waitlist-status");
  var countEl = document.getElementById("waitlist-count");

  if (!form || !emailInput || !submitBtn || !statusEl) return;

  var inflight = false;

  function refreshCount() {
    if (!countEl) return;
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 5000);
    fetch("/api/waitlist/count", { cache: "no-store", signal: controller.signal })
      .then(function (res) {
        if (!res.ok) throw new Error("count unavailable");
        return res.json();
      })
      .then(function (data) {
        if (!data || !Number.isInteger(data.count) || data.count < 0) throw new Error("invalid count");
        countEl.textContent = new Intl.NumberFormat().format(data.count) + " on the waitlist";
      })
      .catch(function () { countEl.textContent = "Waitlist count unavailable"; })
      .finally(function () { clearTimeout(timeout); });
  }

  refreshCount();

  function setStatus(msg, type) {
    statusEl.textContent = msg;
    emailInput.setAttribute("aria-invalid", String(type === "error"));
    statusEl.setAttribute("data-type", type || "");
  }

  function setSubmitting(on) {
    inflight = on;
    emailInput.disabled = on;
    submitBtn.disabled = on;
    submitBtn.querySelector("[data-text]").textContent = on ? "Joining…" : "Join waitlist";
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (inflight) return;

    var email = emailInput.value.trim();
    if (!email) {
      setStatus("Enter your email address.", "error");
      emailInput.focus();
      return;
    }

    // Native validation
    if (!emailInput.validity.valid) {
      setStatus("Enter a valid email address.", "error");
      emailInput.focus();
      return;
    }

    setStatus("", "");
    setSubmitting(true);

    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 12000);

    var payload = { email: email };
    // Honeypot field
    if (honeypot && honeypot.value) {
      payload.website = honeypot.value;
    }

    fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then(function (res) {
        if (res.status === 429) {
          clearTimeout(timeout);
          var retry = res.headers.get("Retry-After");
          var msg = retry
            ? "Too many requests. Try again in " + retry + " seconds."
            : "Too many requests. Try again later.";
          setStatus(msg, "error");
          setSubmitting(false);
          return;
        }
        return res.json().then(function (data) {
          clearTimeout(timeout);
          if (res.ok && data && data.ok === true) {
            // Show success state
            form.hidden = true;
            setStatus("You’re on the list. We’ll email you when Murmur opens.", "success");
            refreshCount();
            statusEl.focus({ preventScroll: true });
          } else {
            setStatus(data && data.error ? data.error : "Something went wrong. Try again.", "error");
            setSubmitting(false);
          }
        });
      })
      .catch(function (err) {
        clearTimeout(timeout);
        if (err.name === "AbortError") {
          setStatus("Request timed out. Check your connection and try again.", "error");
        } else {
          setStatus("Network error. Check your connection and try again.", "error");
        }
        setSubmitting(false);
      });
  });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindPage, { once: true });
  } else {
    bindPage();
  }
})();
