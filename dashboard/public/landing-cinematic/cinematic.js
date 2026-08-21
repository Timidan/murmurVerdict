const root = document.documentElement;
const cinematic = document.querySelector("[data-cinematic]");
const stage = document.querySelector("[data-stage]");
const header = document.querySelector("[data-site-header]");
const progressValue = document.querySelector("[data-progress-value]");
const particlesCanvas = document.querySelector("[data-particles]");
const railScene = document.querySelector("[data-moment='rail']");
const heroMoment = document.querySelector("[data-moment='hero']");
const skipSequence = document.querySelector(".skip-sequence");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = window.matchMedia("(pointer: fine)");
const lowPower =
  (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
  (navigator.deviceMemory && navigator.deviceMemory <= 4);

root.classList.toggle("low-power", Boolean(lowPower));

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const lerp = (from, to, progress) => from + (to - from) * progress;
const smoothstep = (from, to, value) => {
  const progress = clamp((value - from) / (to - from));
  return progress * progress * (3 - 2 * progress);
};
const segmentInOut = (inStart, inEnd, outStart, outEnd, value) =>
  smoothstep(inStart, inEnd, value) * (1 - smoothstep(outStart, outEnd, value));

let sectionTop = 0;
let sectionDistance = 1;
let actualProgress = 0;
let frameRequested = false;
let lastProgressText = null;

// Stage-heights of scroll the sequence spans. Biggest lever on beat visibility.
const SCROLL_RUNWAY = 7;
// Floor so landscape phones still get a sequence.
const MIN_TRAVEL_PX = 3600;
// No damping between scroll and progress: tried, unmeasurable, removed (see git log).
// Where #sealed deep links land — middle of SEALED's hold.
const SEALED_ANCHOR = 0.38;
// Where the rail takes over interactivity, 47% through its reveal.
const RAIL_HANDOFF = 0.85;
let pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };

const particleState = {
  context: particlesCanvas?.getContext("2d") ?? null,
  width: 0,
  height: 0,
  dpr: 1,
  points: [],
};

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function setRootNumber(name, value, digits = 4) {
  root.style.setProperty(name, Number(value).toFixed(digits));
}

function setRootPixels(name, value) {
  root.style.setProperty(name, `${value.toFixed(2)}px`);
}

function measure() {
  if (!cinematic || !stage) return;

  // Stage box, not innerHeight: stage is svh, innerHeight shifts as mobile chrome hides.
  const stageHeight = Math.round(stage.getBoundingClientRect().height) || window.innerHeight;
  const travel = Math.round(Math.max(MIN_TRAVEL_PX, stageHeight * SCROLL_RUNWAY));
  const cinematicHeight = stageHeight + travel;
  root.style.setProperty("--cinematic-height", `${cinematicHeight}px`);

  const rect = cinematic.getBoundingClientRect();
  sectionTop = rect.top + window.scrollY;
  sectionDistance = Math.max(1, travel);

  resizeParticles();
  requestRender();
}

function resizeParticles() {
  if (!particlesCanvas || !particleState.context || !stage) return;

  const rect = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  particleState.width = Math.max(1, Math.round(rect.width));
  particleState.height = Math.max(1, Math.round(rect.height));
  particleState.dpr = dpr;
  particlesCanvas.width = Math.round(particleState.width * dpr);
  particlesCanvas.height = Math.round(particleState.height * dpr);
  particleState.context.setTransform(dpr, 0, 0, dpr, 0, 0);

  const random = seededRandom(197703);
  const count = window.innerWidth < 640 ? 70 : window.innerWidth < 960 ? 110 : 170;
  particleState.points = Array.from({ length: count }, () => ({
    x: random(),
    y: random() * 0.72,
    depth: 0.25 + random() * 0.75,
    length: 1.5 + random() * 3.5,
    angle: -0.65 + random() * 1.3,
    alpha: 0.12 + random() * 0.38,
  }));
}

function drawParticles(progress) {
  const { context, width, height, points } = particleState;
  if (!context || !width || !height || reducedMotion.matches) return;

  context.clearRect(0, 0, width, height);
  context.lineCap = "round";
  context.lineWidth = 1;

  for (const point of points) {
    const drift = (progress - 0.5) * 34 * point.depth;
    const x = point.x * width + pointer.x * 11 * point.depth + drift;
    const y = point.y * height + pointer.y * 7 * point.depth - drift * 0.18;
    const dx = Math.cos(point.angle) * point.length;
    const dy = Math.sin(point.angle) * point.length;
    context.strokeStyle = `rgba(232, 232, 232, ${point.alpha})`;
    context.beginPath();
    context.moveTo(x - dx, y - dy);
    context.lineTo(x + dx, y + dy);
    context.stroke();
  }
}

function readProgress() {
  return clamp((window.scrollY - sectionTop) / sectionDistance);
}

function render() {
  frameRequested = false;
  actualProgress = readProgress();

  const pointerEase = 0.14;
  pointer.x += (pointer.targetX - pointer.x) * pointerEase;
  pointer.y += (pointer.targetY - pointer.y) * pointerEase;

  const progress = actualProgress;
  // Beat timings as fractions of the section. SEALED and RESOLVED enter at the
  // same pace (0.10) on purpose; the tail used to sit idle and now carries them.
  const heroVisibility = 1 - smoothstep(0.03, 0.18, progress);
  const portalOpen = smoothstep(0.15, 0.25, progress);
  const sealedVisibility = segmentInOut(0.235, 0.335, 0.42, 0.47, progress);
  const resolvedVisibility = segmentInOut(0.51, 0.61, 0.72, 0.77, progress);
  const railVisibility = smoothstep(0.78, 0.93, progress);
  const worldPush = smoothstep(0.03, 0.77, progress);
  const focusStrength = resolvedVisibility;

  setRootNumber("--progress", progress);
  setRootNumber("--hero-visibility", heroVisibility);
  setRootNumber("--portal-open", portalOpen);
  setRootNumber("--sealed-visibility", sealedVisibility);
  setRootNumber("--resolved-visibility", resolvedVisibility);
  setRootNumber("--rail-visibility", railVisibility);
  setRootNumber("--world-scale", lerp(1, 1.13, worldPush), 5);
  setRootNumber("--focus-visibility", focusStrength);

  // Carry the full-bleed backdrop blur only while it is actually visible.
  stage?.classList.toggle("focus-active", focusStrength > 0.001);

  setRootPixels("--far-x", pointer.x * -6 + lerp(0, -12, progress));
  setRootPixels("--far-y", pointer.y * -4 + lerp(0, -8, progress));
  setRootPixels("--near-x", pointer.x * 13 + lerp(0, -30, progress));
  setRootPixels("--near-y", pointer.y * 8 + lerp(0, -18, progress));

  if (progressValue) {
    // Integer readout — skip the write when it has not changed.
    const shown = String(Math.round(progress * 100)).padStart(2, "0");
    if (shown !== lastProgressText) {
      lastProgressText = shown;
      progressValue.textContent = shown;
    }
  }

  header?.classList.toggle("is-scrolled", window.scrollY > 24);
  header?.classList.toggle("has-verdict", progress > RAIL_HANDOFF);
  const heroInteractive = heroVisibility > 0.55;
  heroMoment?.classList.toggle("is-interactive", heroInteractive);
  if (heroMoment) {
    if (heroInteractive) heroMoment.removeAttribute("inert");
    else heroMoment.setAttribute("inert", "");
  }

  const skipInteractive = railVisibility < 0.75;
  skipSequence?.classList.toggle("is-interactive", skipInteractive);
  if (skipSequence) {
    if (skipInteractive) skipSequence.removeAttribute("inert");
    else skipSequence.setAttribute("inert", "");
  }

  const railInteractive = progress > RAIL_HANDOFF;
  railScene?.classList.toggle("is-interactive", railInteractive);
  if (railScene) {
    if (railInteractive) railScene.removeAttribute("inert");
    else railScene.setAttribute("inert", "");
  }

  drawParticles(progress);

  const pointerDelta =
    Math.abs(pointer.targetX - pointer.x) + Math.abs(pointer.targetY - pointer.y);
  // Only the pointer ease needs frames of its own; scroll drives the rest.
  if (pointerDelta > 0.001) {
    requestRender();
  }
}

function requestRender() {
  if (frameRequested || reducedMotion.matches) return;
  frameRequested = true;
  requestAnimationFrame(render);
}

function initializeMotion() {
  if (!cinematic || !stage || reducedMotion.matches) {
    root.classList.remove("motion-ok");
    railScene?.removeAttribute("inert");
    return;
  }

  root.classList.add("motion-ok");
  measure();

  if (window.location.hash === "#sealed") {
    window.scrollTo({
      top: sectionTop + sectionDistance * SEALED_ANCHOR,
      behavior: "auto",
    });
  }

  render();

  window.addEventListener("scroll", requestRender, { passive: true });
  window.addEventListener("resize", measure, { passive: true });

  if (finePointer.matches) {
    window.addEventListener(
      "pointermove",
      (event) => {
        pointer.targetX = clamp(event.clientX / window.innerWidth, 0, 1) * 2 - 1;
        pointer.targetY = clamp(event.clientY / window.innerHeight, 0, 1) * 2 - 1;
        requestRender();
      },
      { passive: true },
    );

    document.addEventListener("mouseleave", () => {
      pointer.targetX = 0;
      pointer.targetY = 0;
      requestRender();
    });
  }

  const resizeObserver = new ResizeObserver(measure);
  resizeObserver.observe(stage);
}

function setupRail() {
  const viewport = document.querySelector("[data-rail-viewport]");
  const rail = document.querySelector("[data-rail]");
  const cards = Array.from(document.querySelectorAll(".chapter-card"));
  const previous = document.querySelector("[data-rail-prev]");
  const next = document.querySelector("[data-rail-next]");
  const status = document.querySelector("[data-rail-status]");
  if (!viewport || !rail || !cards.length || !previous || !next || !status) return;

  let activeIndex = 0;
  let scrollFrame = 0;
  let settleFrame = 0;
  let settleTimer = 0;
  let settleTransitionHandler = null;
  let reducedSettleFrame = 0;
  let drag = null;

  const stageNames = cards.map((card) => card.querySelector(".chapter-card__index")?.textContent || "Stage");
  const velocityThreshold = 0.11;
  const velocityFreshnessWindow = 120;
  const rubberStrength = 0.18;
  const maximumRubberOffset = 18;

  function maximumScrollLeft() {
    return Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  }

  function cardScrollLeft(index) {
    return clamp(cards[index].offsetLeft, 0, maximumScrollLeft());
  }

  function setRailOffset(value) {
    rail.style.setProperty("--rail-offset", `${value.toFixed(2)}px`);
  }

  function renderedRailOffset() {
    const transform = getComputedStyle(rail).transform;
    if (!transform || transform === "none") return 0;

    const match = transform.match(/^matrix(3d)?\((.+)\)$/);
    if (!match) return 0;
    const values = match[2].split(",").map(Number);
    return match[1] ? values[12] || 0 : values[4] || 0;
  }

  function clearSettleWatchers() {
    cancelAnimationFrame(settleFrame);
    settleFrame = 0;
    clearTimeout(settleTimer);
    settleTimer = 0;
    if (settleTransitionHandler) {
      rail.removeEventListener("transitionend", settleTransitionHandler);
      settleTransitionHandler = null;
    }
  }

  function completeSettle() {
    clearSettleWatchers();
    setRailOffset(0);
    viewport.classList.remove("is-flip-primed", "is-settling");
  }

  function clearSettleForImmediateInput() {
    const hasPendingSettle =
      viewport.classList.contains("is-flip-primed") ||
      viewport.classList.contains("is-settling") ||
      viewport.classList.contains("is-reduced-primed");
    if (!hasPendingSettle) return;

    clearSettleWatchers();
    cancelAnimationFrame(reducedSettleFrame);
    reducedSettleFrame = 0;
    viewport.classList.add("is-flip-primed");
    setRailOffset(0);
    rail.getBoundingClientRect();
    viewport.classList.remove("is-flip-primed", "is-settling", "is-reduced-primed");
  }

  function nearestIndex(left = viewport.scrollLeft) {
    let closest = 0;
    let distance = Number.POSITIVE_INFINITY;
    cards.forEach((card, index) => {
      const currentDistance = Math.abs(cardScrollLeft(index) - left);
      if (currentDistance < distance) {
        distance = currentDistance;
        closest = index;
      }
    });
    return closest;
  }

  function projectedIndex(left, velocity) {
    if (velocity > 0) {
      const nextIndex = cards.findIndex((card, index) => cardScrollLeft(index) > left + 0.5);
      return nextIndex === -1 ? cards.length - 1 : nextIndex;
    }

    for (let index = cards.length - 1; index >= 0; index -= 1) {
      if (cardScrollLeft(index) < left - 0.5) return index;
    }
    return 0;
  }

  function updateRailState(announce = false) {
    const isScrollable = maximumScrollLeft() > 1;
    viewport.classList.toggle("is-static", !isScrollable);

    if (!isScrollable) {
      activeIndex = -1;
      previous.disabled = true;
      next.disabled = true;
      cards.forEach((card) => card.removeAttribute("aria-current"));
      status.textContent = "All four lifecycle stages are visible.";
      return;
    }

    const nextIndex = nearestIndex();
    const changed = nextIndex !== activeIndex;
    activeIndex = nextIndex;
    previous.disabled = activeIndex === 0;
    next.disabled = activeIndex === cards.length - 1;
    cards.forEach((card, index) => {
      if (index === activeIndex) card.setAttribute("aria-current", "step");
      else card.removeAttribute("aria-current");
    });
    if (announce && changed) {
      status.textContent = `Lifecycle stage ${activeIndex + 1} of ${cards.length}: ${stageNames[activeIndex]}`;
    }
  }

  function goTo(index, behavior = reducedMotion.matches ? "auto" : "smooth") {
    clearSettleForImmediateInput();
    if (maximumScrollLeft() <= 1) return;
    const targetIndex = clamp(index, 0, cards.length - 1);
    viewport.scrollTo({
      left: cardScrollLeft(targetIndex),
      behavior,
    });
  }

  previous.addEventListener("click", () => goTo(activeIndex - 1));
  next.addEventListener("click", () => goTo(activeIndex + 1));

  viewport.addEventListener(
    "scroll",
    () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => updateRailState(true));
    },
    { passive: true },
  );

  viewport.addEventListener("keydown", (event) => {
    if (maximumScrollLeft() <= 1) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      goTo(activeIndex - 1, "auto");
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      goTo(activeIndex + 1, "auto");
    }
    if (event.key === "Home") {
      event.preventDefault();
      goTo(0, "auto");
    }
    if (event.key === "End") {
      event.preventDefault();
      goTo(cards.length - 1, "auto");
    }
  });

  viewport.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse") {
      clearSettleForImmediateInput();
      return;
    }
    if (event.button !== 0 || maximumScrollLeft() <= 1) return;

    cancelAnimationFrame(reducedSettleFrame);

    const renderedOffset = reducedMotion.matches ? 0 : renderedRailOffset();
    setRailOffset(renderedOffset);
    rail.getBoundingClientRect();
    viewport.classList.add("is-dragging");
    clearSettleWatchers();
    viewport.classList.remove("is-flip-primed", "is-settling", "is-reduced-primed");

    const currentLeft = viewport.scrollLeft;
    const normalizedLeft = clamp(currentLeft - renderedOffset, 0, maximumScrollLeft());
    const residualOffset = reducedMotion.matches
      ? 0
      : renderedOffset - (currentLeft - normalizedLeft);
    viewport.scrollLeft = normalizedLeft;
    setRailOffset(residualOffset);

    const desiredStart = normalizedLeft - residualOffset / rubberStrength;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      desiredStart,
      lastDesired: desiredStart,
      lastTime: event.timeStamp,
      velocity: 0,
      rubberOffset: residualOffset,
    };
    viewport.setPointerCapture(event.pointerId);
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;

    const desired = drag.desiredStart - (event.clientX - drag.startX);
    const elapsed = event.timeStamp - drag.lastTime;
    if (!reducedMotion.matches && elapsed > 0) {
      drag.velocity = (desired - drag.lastDesired) / elapsed;
    }
    drag.lastDesired = desired;
    drag.lastTime = event.timeStamp;

    const clampedLeft = clamp(desired, 0, maximumScrollLeft());
    const overshoot = desired - clampedLeft;
    drag.rubberOffset = reducedMotion.matches
      ? 0
      : clamp(-overshoot * rubberStrength, -maximumRubberOffset, maximumRubberOffset);
    viewport.scrollLeft = clampedLeft;
    setRailOffset(drag.rubberOffset);
  });

  function finishDrag(event, projectVelocity) {
    if (!drag || drag.pointerId !== event.pointerId) return;

    const release = drag;
    drag = null;
    const releaseLeft = viewport.scrollLeft;
    const velocityIsFresh = event.timeStamp - release.lastTime <= velocityFreshnessWindow;
    const velocity = velocityIsFresh ? release.velocity : 0;
    const shouldProject =
      projectVelocity && !reducedMotion.matches && Math.abs(velocity) > velocityThreshold;
    const targetIndex = shouldProject
      ? projectedIndex(releaseLeft, velocity)
      : nearestIndex(releaseLeft);
    const targetLeft = cardScrollLeft(targetIndex);

    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    viewport.scrollTo({ left: targetLeft, behavior: "auto" });

    if (reducedMotion.matches) {
      setRailOffset(0);
      viewport.classList.remove("is-dragging");
      viewport.classList.add("is-reduced-primed");
      rail.getBoundingClientRect();
      reducedSettleFrame = requestAnimationFrame(() => {
        viewport.classList.remove("is-reduced-primed");
      });
      return;
    }

    const flipOffset = targetLeft - releaseLeft + release.rubberOffset;
    viewport.classList.add("is-flip-primed", "is-settling");
    setRailOffset(flipOffset);
    rail.getBoundingClientRect();
    viewport.classList.remove("is-dragging");

    settleFrame = requestAnimationFrame(() => {
      settleFrame = 0;
      viewport.classList.remove("is-flip-primed");
      rail.getBoundingClientRect();

      if (Math.abs(flipOffset) < 0.01) {
        completeSettle();
        return;
      }

      settleTransitionHandler = (transitionEvent) => {
        if (transitionEvent.target !== rail || transitionEvent.propertyName !== "transform") return;
        completeSettle();
      };
      rail.addEventListener("transitionend", settleTransitionHandler);
      settleTimer = window.setTimeout(completeSettle, 360);
      setRailOffset(0);
    });
  }

  viewport.addEventListener("pointerup", (event) => finishDrag(event, true));
  viewport.addEventListener("pointercancel", (event) => finishDrag(event, false));
  new ResizeObserver(() => updateRailState(false)).observe(viewport);
  updateRailState(false);
}

function setupLiveData() {
  const scoreScene = document.querySelector(".evidence--score");
  const count = document.querySelector("[data-verdict-count]");
  const leaderboard = document.querySelector("[data-leaderboard]");
  const controller = new AbortController();
  const apiOrigin = window.MURMUR_API_ORIGIN || "";
  const api = `${apiOrigin}/v1`;
  const activeSwaps = new WeakMap();

  function scoreSceneVisible() {
    if (!scoreScene) return false;
    const visibility = Number.parseFloat(
      getComputedStyle(root).getPropertyValue("--resolved-visibility"),
    );
    const bounds = scoreScene.getBoundingClientRect();
    return visibility > 0.15 && bounds.bottom > 0 && bounds.top < window.innerHeight;
  }

  function clearSwap(target) {
    activeSwaps.get(target)?.cancel();
    activeSwaps.delete(target);
    target.classList.remove("is-data-exiting", "is-data-entering", "is-data-settling");
  }

  function swapData(target, mutate) {
    if (!target) return;
    clearSwap(target);

    if (!scoreSceneVisible()) {
      mutate();
      return;
    }

    let exitFinished = false;
    let entranceFinished = false;
    let exitTimer = 0;
    let entranceTimer = 0;
    let entranceFrame = 0;

    const finishEntrance = () => {
      if (entranceFinished) return;
      entranceFinished = true;
      clearTimeout(entranceTimer);
      target.removeEventListener("transitionend", handleEntranceEnd);
      target.classList.remove("is-data-settling");
      if (activeSwaps.get(target)?.cancel === cancel) activeSwaps.delete(target);
    };

    const handleEntranceEnd = (event) => {
      if (event.target === target && event.propertyName === "opacity") finishEntrance();
    };

    const beginEntrance = () => {
      target.addEventListener("transitionend", handleEntranceEnd);
      target.classList.add("is-data-settling");
      target.classList.remove("is-data-entering");
      entranceTimer = window.setTimeout(
        finishEntrance,
        reducedMotion.matches ? 90 : 230,
      );
    };

    const finishExit = () => {
      if (exitFinished) return;
      exitFinished = true;
      clearTimeout(exitTimer);
      target.removeEventListener("transitionend", handleExitEnd);
      target.classList.add("is-data-entering");
      target.classList.remove("is-data-exiting");
      mutate();
      target.getBoundingClientRect();
      entranceFrame = requestAnimationFrame(beginEntrance);
    };

    const handleExitEnd = (event) => {
      if (event.target === target && event.propertyName === "opacity") finishExit();
    };

    const cancel = () => {
      clearTimeout(exitTimer);
      clearTimeout(entranceTimer);
      cancelAnimationFrame(entranceFrame);
      target.removeEventListener("transitionend", handleExitEnd);
      target.removeEventListener("transitionend", handleEntranceEnd);
    };

    activeSwaps.set(target, { cancel });
    target.addEventListener("transitionend", handleExitEnd);
    target.classList.add("is-data-exiting");
    exitTimer = window.setTimeout(finishExit, reducedMotion.matches ? 90 : 170);
  }

  const showLeaderboardUnavailable = () => {
    const placeholder = leaderboard?.querySelector("li span:nth-child(2)");
    if (!leaderboard || !placeholder) return;
    swapData(leaderboard, () => {
      placeholder.textContent = "live record unavailable";
    });
  };

  fetch(`${api}/stats`, { signal: controller.signal })
    .then((response) => (response.ok ? response.json() : null))
    .then((stats) => {
      if (count && typeof stats?.calls_resolved === "number") {
        swapData(count, () => {
          count.textContent = stats.calls_resolved.toLocaleString("en-US");
        });
      }
    })
    .catch(() => {});

  fetch(`${api}/leaderboard?limit=4`, { signal: controller.signal })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      if (!leaderboard || !Array.isArray(payload?.rows) || !payload.rows.length) {
        showLeaderboardUnavailable();
        return;
      }
      swapData(leaderboard, () => {
        leaderboard.replaceChildren();
        payload.rows.slice(0, 4).forEach((row, index) => {
          const item = document.createElement("li");
          const rank = document.createElement("span");
          const name = document.createElement("span");
          const score = document.createElement("strong");
          rank.textContent = String(index + 1).padStart(2, "0");
          name.textContent = row.display_slug || row.agent_slug || "agent";
          score.textContent =
            typeof row.verdict_score === "number" ? row.verdict_score.toFixed(2) : "··";
          item.append(rank, name, score);
          leaderboard.append(item);
        });
      });
    })
    .catch(showLeaderboardUnavailable);

  window.addEventListener("pagehide", () => controller.abort(), { once: true });
}

function setupSequenceLinks() {
  document.querySelectorAll('a[href="#sealed"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      if (reducedMotion.matches || !root.classList.contains("motion-ok")) return;
      event.preventDefault();
      window.scrollTo({
        top: sectionTop + sectionDistance * SEALED_ANCHOR,
        behavior: "smooth",
      });
      history.replaceState(null, "", "#sealed");
    });
  });
}

function waitForMedia() {
  const images = Array.from(document.querySelectorAll(".world__image"));
  return Promise.all(
    images.map((image) => {
      if (image.complete) return image.decode?.().catch(() => {}) ?? Promise.resolve();
      return new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    }),
  );
}

setupRail();
setupLiveData();
setupSequenceLinks();

waitForMedia().finally(() => {
  root.classList.add("media-ready");
  initializeMotion();
});

reducedMotion.addEventListener("change", () => window.location.reload());
