/* Fullscreen toggle for the Agreement Ranch HUD (the button itself lives in
   index.html; index.html stays the single source of the icon markup).

   Named "present mode" rather than "fullscreen" on purpose: content blockers
   match request URLs, and a path ending in fullscreen.js is caught by filters
   aimed at fullscreen-interstitial ads. A visitor with such a filter saw
   net::ERR_BLOCKED_BY_CLIENT, which the fail-soft import turned into a hidden
   button. Do not rename this file back.

   The control is a real toggle, not a one-way request: browsers disagree about
   who owns the Escape key while an element is fullscreen (Chrome consumes it,
   others hand it to the page), so state is always read back from
   `fullscreenchange` and never trusted from the click. While fullscreen is
   active a capture-phase listener swallows Escape before the ranch handlers
   (map toggle, roam exit, Gaming-mode exit) can see it, so one Escape press
   means exactly one thing: leave fullscreen. It deliberately does NOT call
   preventDefault — the browser must always be free to perform its own exit.

   A browser without the element API (iPhone Safari) gets no button at all
   rather than one that cannot work. Safari's older `webkit` spellings are
   accepted for the same reason. `doc` is injectable so the state machine can
   be driven by scripts/check-fullscreen.mjs without a browser. */

const CHANGE_EVENTS = ["fullscreenchange", "webkitfullscreenchange"];
const ENTER_LABEL = "Enter fullscreen";
const EXIT_LABEL = "Exit fullscreen";
const ENTER_TITLE = "Enter fullscreen (V · Escape exits)";
const EXIT_TITLE = "Exit fullscreen (V · Escape works too)";

export function createFullscreenControl(button, doc = globalThis.document) {
  const root = doc.documentElement;
  const standard = typeof root.requestFullscreen === "function";
  const requestMethod = standard
    ? root.requestFullscreen.bind(root)
    : (typeof root.webkitRequestFullscreen === "function" ? root.webkitRequestFullscreen.bind(root) : null);
  const exitMethod = typeof doc.exitFullscreen === "function"
    ? doc.exitFullscreen.bind(doc)
    : (typeof doc.webkitExitFullscreen === "function" ? doc.webkitExitFullscreen.bind(doc) : null);
  const supported = typeof requestMethod === "function";

  function isActive() {
    return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement || null);
  }

  function sync() {
    const active = isActive();
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.setAttribute("aria-label", active ? EXIT_LABEL : ENTER_LABEL);
    button.setAttribute("title", active ? EXIT_TITLE : ENTER_TITLE);
  }

  function report(err) {
    console.warn("fullscreen request refused:", err);
  }

  function enter() {
    if (!supported || isActive()) return Promise.resolve(false);
    let pending;
    try {
      /* `navigationUI: "hide"` is the standard-API spelling for a clean booth
         frame; the webkit fallback takes no options it understands. */
      pending = standard ? requestMethod({ navigationUI: "hide" }) : requestMethod();
    } catch (err) {
      report(err);
      return Promise.resolve(false);
    }
    /* requestFullscreen resolves with no useful value and can reject (embed
       permissions, user refusal), so the resolved state — not the call —
       decides what the button says. */
    return Promise.resolve(pending).then(() => {
      sync();
      return isActive();
    }, (err) => {
      report(err);
      sync();
      return false;
    });
  }

  function leave() {
    if (!supported || !isActive() || typeof exitMethod !== "function") {
      return Promise.resolve(false);
    }
    let pending;
    try {
      pending = exitMethod();
    } catch (err) {
      report(err);
      return Promise.resolve(false);
    }
    return Promise.resolve(pending).then(() => {
      sync();
      return isActive();
    }, (err) => {
      report(err);
      sync();
      return false;
    });
  }

  function toggle() {
    return isActive() ? leave() : enter();
  }

  /* Capture phase on purpose: main.js, roam.js, race.js and auto-tour-hud.js
     all listen for keydown later in the bubble phase, and roam.js calls
     stopImmediatePropagation() of its own — nothing below this can re-enable
     a page-level Escape action mid-fullscreen. */
  function onKeyDown(event) {
    if (event.key !== "Escape" || !isActive()) return;
    event.stopImmediatePropagation();
  }

  function onClick() {
    /* Match the roam toggle: after a pointer press the button must not keep
       focus, or the next Space/Enter re-triggers fullscreen instead of
       reaching the world. */
    if (typeof button.blur === "function") button.blur();
    toggle();
  }

  /* The button is chrome, so it is hidden until the visitor enters the world
     (and in the ?tour=1 recorder frame). The shortcut rides the same state:
     before the world is on screen there is nothing to present. */
  function onScreen() {
    if (button.hidden) return false;
    const view = doc.defaultView;
    const style = view && typeof view.getComputedStyle === "function" ? view.getComputedStyle(button) : null;
    return !style || style.visibility !== "hidden";
  }

  function isTyping(target) {
    if (!target || typeof target.closest !== "function") return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable]"));
  }

  /* V: a presenter key, free in every ranch mode (roam owns Space/E/F/M/C,
     the tour owns T, Gaming mode owns P/Q/R). It never interrupts narration —
     going fullscreen is orthogonal to the tour. */
  function onShortcut(event) {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key !== "v" && event.key !== "V") return;
    if (!onScreen() || isTyping(event.target)) return;
    event.preventDefault();
    toggle();
  }

  if (!supported) {
    /* No element fullscreen here (iPhone Safari): hide rather than lie. */
    button.hidden = true;
  } else {
    button.addEventListener("click", onClick);
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("keydown", onShortcut);
    for (const type of CHANGE_EVENTS) doc.addEventListener(type, sync);
    sync();
  }

  return {
    get state() {
      return { supported, active: isActive(), hidden: Boolean(button.hidden) };
    },
    isActive,
    enter,
    exit: leave,
    toggle,
    dispose() {
      button.removeEventListener("click", onClick);
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("keydown", onShortcut);
      for (const type of CHANGE_EVENTS) doc.removeEventListener(type, sync);
    }
  };
}
