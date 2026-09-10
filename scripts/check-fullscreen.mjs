/* Fullscreen toggle contract: the button state machine, the Escape guard that
   keeps one Escape press meaning "leave fullscreen", the fallbacks, and the
   static wiring in index.html / main.js / the two stylesheets. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFullscreenControl } from "../js/world/fullscreen.js?v=20260910-fullscreen";

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------- a DOM small enough to reason about, faithful where it matters ----
   Listeners keep their capture flag and are invoked capture-first, so the
   module's guard can be proven to run before the page's bubble handlers. The
   key event deliberately has no preventDefault: while fullscreen is active the
   browser must still be free to perform its own exit, so touching it throws. */
function makeDoc({ standard = true, webkit = false } = {}) {
  const listeners = [];
  const doc = {
    fullscreenElement: null,
    webkitFullscreenElement: null,
    documentElement: {},
    requests: 0,
    exits: 0,
    options: null,
    argCount: 0,
    addEventListener(type, fn, capture = false) {
      listeners.push({ type, fn, capture: Boolean(capture) });
    },
    removeEventListener(type, fn, capture = false) {
      const at = listeners.findIndex(
        (entry) => entry.type === type && entry.fn === fn && entry.capture === Boolean(capture));
      if (at >= 0) listeners.splice(at, 1);
    },
    countListeners(type) { return listeners.filter((entry) => entry.type === type).length; },
    emit(type) {
      const event = {
        key: "Escape",
        stopped: false,
        stopImmediatePropagation() { this.stopped = true; }
      };
      /* capture listeners first regardless of registration order, exactly like
         a real keydown whose target sits below document */
      const ordered = [...listeners].sort((a, b) => Number(b.capture) - Number(a.capture));
      let bubbleRan = 0;
      for (const entry of ordered) {
        if (entry.type !== type) continue;
        entry.fn(event);
        if (!entry.capture) bubbleRan++;
        if (event.stopped) break;
      }
      return { stopped: event.stopped, bubbleRan };
    }
  };
  if (standard) {
    doc.documentElement.requestFullscreen = function requestFullscreen(...args) {
      doc.requests++;
      doc.argCount = args.length;
      doc.options = args[0] ?? null;
      doc.fullscreenElement = doc.documentElement;
      return Promise.resolve();
    };
    doc.exitFullscreen = function exitFullscreen() {
      doc.exits++;
      doc.fullscreenElement = null;
      return Promise.resolve();
    };
  }
  if (webkit) {
    doc.documentElement.webkitRequestFullscreen = function webkitRequestFullscreen(...args) {
      doc.requests++;
      doc.argCount = args.length;
      doc.webkitFullscreenElement = doc.documentElement;
      return undefined;   // older WebKit resolves nothing
    };
    doc.webkitExitFullscreen = function webkitExitFullscreen() {
      doc.exits++;
      doc.webkitFullscreenElement = null;
    };
  }
  return doc;
}

function makeButton() {
  const attributes = new Map();
  const listeners = new Map();
  return {
    hidden: false,
    blurs: 0,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    blur() { this.blurs++; },
    click() { listeners.get("click")?.({}); }
  };
}

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));

/* ---------- entering, leaving, and keeping the button honest ---------- */
{
  const doc = makeDoc();
  const button = makeButton();
  const control = createFullscreenControl(button, doc);

  assert.equal(button.getAttribute("aria-pressed"), "false", "starts unpressed");
  assert.equal(button.getAttribute("aria-label"), "Enter fullscreen");
  assert.match(button.getAttribute("title"), /Escape exits/);
  assert.deepEqual(control.state, { supported: true, active: false, hidden: false });

  button.click();
  await flush();
  assert.equal(doc.requests, 1, "the click requests fullscreen");
  assert.equal(doc.options?.navigationUI, "hide", "the standard API asks for a clean booth frame");
  assert.equal(button.blurs, 1, "the toggle drops focus so Space/Enter keep reaching the world");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.getAttribute("aria-label"), "Exit fullscreen");

  /* the browser's own Escape: no page handler runs, but the state still syncs */
  doc.fullscreenElement = null;
  doc.emit("fullscreenchange");
  assert.equal(button.getAttribute("aria-pressed"), "false", "native Escape re-syncs the icon");
  assert.equal(button.getAttribute("aria-label"), "Enter fullscreen");

  button.click();
  await flush();
  assert.equal(doc.requests, 2);
  assert.equal(control.isActive(), true);
  button.click();
  await flush();
  assert.equal(doc.exits, 1, "the second click leaves fullscreen again");
  assert.equal(control.isActive(), false);
}

/* ---------- one Escape press, one action ---------- */
{
  const doc = makeDoc();
  const button = makeButton();
  /* the real page handlers: roam.js registers before this module, main.js and
     race.js after it — none of them may fire alongside the native exit */
  let pageEscapes = 0;
  doc.addEventListener("keydown", () => { pageEscapes++; });
  const control = createFullscreenControl(button, doc);
  doc.addEventListener("keydown", () => { pageEscapes++; });

  assert.equal(doc.emit("keydown").bubbleRan, 2, "Escape keeps its page meaning outside fullscreen");
  assert.equal(pageEscapes, 2);

  button.click();
  await flush();
  const swallowed = doc.emit("keydown");
  assert.equal(swallowed.stopped, true, "the guard claims Escape while fullscreen is active");
  assert.equal(swallowed.bubbleRan, 0, "the guard runs in the capture phase, before every page handler");
  assert.equal(pageEscapes, 2, "no page Escape action fires alongside the native exit");

  doc.fullscreenElement = null;
  doc.emit("fullscreenchange");
  doc.emit("keydown");
  assert.equal(pageEscapes, 4, "and Escape is handed back once fullscreen ends");

  const listeners = doc.countListeners("keydown");
  control.dispose();
  assert.equal(doc.countListeners("keydown"), listeners - 1, "dispose unhooks the guard");
  assert.equal(doc.countListeners("fullscreenchange"), 0, "dispose unhooks the state sync");
}

/* ---------- refused requests and browsers without the element API ---------- */
{
  const doc = makeDoc();
  doc.documentElement.requestFullscreen = () => Promise.reject(new Error("denied"));
  const button = makeButton();
  const control = createFullscreenControl(button, doc);
  button.click();
  await flush();
  assert.equal(await control.enter(), false, "a refused request reports failure instead of throwing");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.ok(warnings.some((line) => line.includes("refused")), "the refusal is reported once");
}
{
  const doc = makeDoc({ standard: false });   // iPhone Safari: no element fullscreen
  const button = makeButton();
  const control = createFullscreenControl(button, doc);
  assert.equal(button.hidden, true, "an unusable toggle hides instead of lying");
  assert.equal(control.state.supported, false);
  assert.equal(doc.countListeners("keydown"), 0, "no guard is installed without the API");
  assert.equal(await control.toggle(), false);
  assert.equal(await control.enter(), false);
  assert.equal(await control.exit(), false);
}
{
  const doc = makeDoc({ standard: false, webkit: true });   // older Safari
  const button = makeButton();
  const control = createFullscreenControl(button, doc);
  button.click();
  await flush();
  assert.equal(doc.requests, 1, "the webkit spelling still enters fullscreen");
  assert.equal(doc.argCount, 0, "the prefixed call takes no options object");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  button.click();
  await flush();
  assert.equal(doc.exits, 1, "and leaves it through the prefixed exit");
}

console.warn = realWarn;

/* ---------- static wiring ---------- */
/* One query per changed file: the stylesheets have not moved since the feature
   landed, the toggle module moved to clear a cached failure, and main.js moved
   with both. */
const CSS_VERSION = "20260910-fullscreen";
const VERSION = "20260910-fs2";          // fullscreen.js itself
const MAIN_VERSION = "20260910-failsoft2";
const ranchHtml = read("index.html");
const worldMain = read("js/world/main.js");
const worldCss = read("css/world.css");
const raceCss = read("css/race.css");

for (const fragment of [
  'id="btnFullscreen" class="fullscreen-btn hud-mono ui"',
  'aria-pressed="false" aria-label="Enter fullscreen"',
  'class="fullscreen-btn__icon fullscreen-btn__icon--enter"',
  'class="fullscreen-btn__icon fullscreen-btn__icon--exit"'
]) {
  if (!ranchHtml.includes(fragment)) throw new Error(`index.html is missing the fullscreen toggle: ${fragment}`);
}
for (const fragment of [
  `css/world.css?v=${CSS_VERSION}`,
  `css/race.css?v=${CSS_VERSION}`,
  `js/world/main.js?v=${MAIN_VERSION}`
]) {
  /* the runtime changed, so the cache-busting query must have moved with it */
  if (!ranchHtml.includes(fragment)) throw new Error(`index.html did not bump ${fragment}`);
}
/* Spelled without "from" so the boundary scanner in check-public.mjs cannot
   mistake this assertion for a real module edge. */
for (const fragment of [
  "loadFullscreenControl",
  `"./fullscreen.js?v=${VERSION}"`,
  'loadFullscreenControl(document.getElementById("btnFullscreen"))',
  "fullscreen toggle unavailable",
  'reason: "module-unavailable"'
]) {
  if (!worldMain.includes(fragment)) throw new Error(`js/world/main.js is missing ${fragment}`);
}
/* The toggle must stay a fail-soft dynamic import: a static edge here means one
   unfetchable file costs the whole world, which is exactly how "CHECKING
   WEBGL…" used to hang forever after a partial deploy. */
if (/from\s+["']\.\/fullscreen\.js/.test(worldMain)) {
  throw new Error("fullscreen.js must not be a static import: it would be fatal to the world graph");
}
if (!/import\(["']\.\/fullscreen\.js\?v=/.test(worldMain)) {
  throw new Error("fullscreen.js must be imported on demand");
}
if (!worldMain.includes("fullscreen: {\n      enter: () => fullscreen.enter()")) {
  throw new Error("window.__world has no fullscreen QA hook");
}
for (const fragment of [
  ".fullscreen-btn {",
  ".fullscreen-btn[hidden] { display: none !important; }",
  '.fullscreen-btn[aria-pressed="true"] .fullscreen-btn__icon--exit { display: block; }',
  ".auto-tour-hud, .fullscreen-btn",
  "@media (max-width: 640px) {\n  .fullscreen-btn {"
]) {
  if (!worldCss.includes(fragment)) throw new Error(`css/world.css is missing ${fragment}`);
}
/* the toggle must outlive the dock's tour trims and Gaming mode's hidden chrome */
if (!worldCss.includes("body.tour .ui,") || !raceCss.includes("body.race-active .fullscreen-btn")) {
  throw new Error("the fullscreen toggle is not accounted for in tour and race modes");
}

/* ---------- the poster's failure surface ----------
   A module the browser cannot fetch never runs main.js, so the page itself has
   to say so. The guard is inline in index.html; run it here with a stub DOM. */
const reporterSource = ranchHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!reporterSource) throw new Error("index.html has no inline world-failure reporter");
if (ranchHtml.indexOf("<script>") > ranchHtml.indexOf('<script type="module"')) {
  throw new Error("the failure reporter must run before the world module script");
}

function runReporter() {
  const listeners = {};
  const timers = [];
  const classes = [];
  const status = { textContent: "CHECKING WEBGL…", classList: { add: (c) => classes.push(c) } };
  const retry = { textContent: "FOLLOW THE CALF", disabled: true, onclick: null };
  let replaced = null;
  const win = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }
  };
  const doc = {
    getElementById: (id) => (id === "introStatus" ? status : id === "btnEnter" ? retry : null)
  };
  const location = { href: "https://example.test/index.html?tour=1", replace: (u) => { replaced = u; } };
  new Function("document", "window", "location", reporterSource)(doc, win, location);
  return { status, retry, listeners, timers, replaced: () => replaced };
}

{
  const first = "CHECKING WEBGL…";
  let h = runReporter();
  assert.equal(h.status.textContent, first, "the reporter leaves the poster alone until something fails");
  assert.equal(typeof h.listeners.error, "function", "it listens for load failures");
  assert.equal(h.timers[0]?.ms, 15000, "and arms the slow-download hint");

  /* a nested import failure surfaces as an error on the main.js script element */
  h.listeners.error({ target: { tagName: "SCRIPT", src: "https://x/js/world/main.js?v=20260910-fullscreen" } });
  assert.match(h.status.textContent, /WORLD RUNTIME FAILED TO LOAD/);
  assert.match(h.status.textContent, /CTRL\+SHIFT\+R/, "the message names the way out");
  assert.equal(h.retry.textContent, "RETRY LOAD");
  assert.equal(h.retry.disabled, false, "the retry button becomes usable");
  h.retry.onclick();
  assert.match(h.replaced(), /[?&]retry=\d+/, "retry reloads through a fresh document URL");
  assert.match(h.replaced(), /tour=1/, "and keeps the visitor's parameters");

  /* runtime errors stay main.js's business */
  h = runReporter();
  h.listeners.error({ target: { tagName: "IMG", src: "x.webp" } });
  assert.equal(h.status.textContent, first, "a failed image does not claim the world is broken");
  h = runReporter();
  h.listeners.error({ target: { tagName: "SPAN" } });
  assert.equal(h.status.textContent, first);

  /* a slow first visit is not a failure */
  h = runReporter();
  h.timers[0].fn();
  assert.match(h.status.textContent, /STILL FETCHING THE WORLD RUNTIME/);
  assert.match(h.status.textContent, /CTRL\+SHIFT\+R/);
  h = runReporter();
  h.status.textContent = "READY 12:00:00 · STATIONS 0–8";
  h.timers[0].fn();
  assert.equal(h.status.textContent, "READY 12:00:00 · STATIONS 0–8", "a world that answered is left alone");
}

console.log("Fullscreen toggle verified: click enters, Escape exits, one press means one action.");
console.log("World-failure surface verified: a module that cannot load says so on the poster.");
