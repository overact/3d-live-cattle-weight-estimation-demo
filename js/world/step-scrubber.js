/* Step scrubber: DOM timeline for the recon replay at stations 03 / 04.
   Click = seek and PAUSE (the convention from viser / SuperSplat / <video>);
   play resumes the loop from the scrubbed phase. Class "ui" on purpose —
   ?tour=1 hides all .ui chrome and the tour must stay pure autoplay for the
   recorder. Desktop-only by stylesheet (the phone keeps the auto loop). */

export function initStepScrubber() {
  try {
    const el = document.createElement("div");
    el.className = "step-scrubber ui hud-mono";
    el.innerHTML =
      `<button class="scrub-play" type="button" aria-label="Pause or resume the reconstruction replay">⏸</button>` +
      `<span class="scrub-tag">RECON REPLAY</span>` +
      `<div class="scrub-track" role="slider" tabindex="0" aria-label="Reconstruction step" ` +
      `aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="scrub-head"></div></div>` +
      `<span class="scrub-label"></span>`;
    document.body.appendChild(el);
    const playBtn = el.querySelector(".scrub-play");
    const tag = el.querySelector(".scrub-tag");
    const track = el.querySelector(".scrub-track");
    const head = el.querySelector(".scrub-head");
    const label = el.querySelector(".scrub-label");

    let player = null, station = null, dragging = false;
    let lastText = "", lastPaused = null, lastU = -1;
    let lastStage = -1, lastStep = -1, lastSteps = -1;

    let boundVersion = -1, lastLoadState = "";
    const canScrub = () => player?.ready === true;

    function rebuildTicks() {
      track.querySelectorAll(".scrub-tick").forEach((t) => t.remove());
      if (!player) return;
      for (const tick of player.tickUs()) {
        const t = document.createElement("span");
        t.className = tick.major ? "scrub-tick scrub-tick--stage" : "scrub-tick";
        t.style.left = `${(tick.u * 100).toFixed(2)}%`;
        track.appendChild(t);
      }
      boundVersion = player.version ?? 0;
    }

    function syncLoadState() {
      if (!player) return;
      const state = player.loadState || (player.isReal ? "ready" : "idle");
      if (state === lastLoadState) return;
      lastLoadState = state;
      const enabled = canScrub();
      playBtn.disabled = !enabled;
      track.setAttribute("aria-disabled", enabled ? "false" : "true");
      el.classList.toggle("is-loading", !enabled);
      if (!enabled) {
        label.textContent = state === "loading"
          ? "LOADING REAL TRACE"
          : state === "unavailable"
            ? "REAL TRACE UNAVAILABLE · REVISIT TO RETRY"
            : "REAL TRACE LOADS ON ARRIVAL";
        track.setAttribute("aria-valuetext", label.textContent);
      }
    }

    function syncPlayBtn() {
      if (!player || !canScrub() || player.paused === lastPaused) return;
      lastPaused = player.paused;
      playBtn.textContent = player.paused ? "▶" : "⏸";
    }
    function seekFromEvent(e) {
      if (!canScrub()) return;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return;
      const u = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      player.scrubTo(u);
      syncPlayBtn();
    }
    track.addEventListener("pointerdown", (e) => {
      if (!canScrub()) return;
      dragging = true;
      track.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    });
    track.addEventListener("pointermove", (e) => {
      if (dragging && canScrub()) seekFromEvent(e);
    });
    const endDrag = () => { dragging = false; };
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);
    playBtn.addEventListener("click", () => {
      if (!canScrub()) return;
      player.setPaused(!player.paused);
      syncPlayBtn();
      playBtn.blur();   // keep Space/Enter flowing to the document (main.js precedent)
    });
    /* keyboard access for the role=slider contract: arrows nudge, Home/End
       jump. stopPropagation so arrows don't also drive stepStation(). */
    track.addEventListener("keydown", (e) => {
      if (!canScrub()) return;
      let u = null;
      if (e.key === "ArrowLeft") u = player.progress - 0.02;
      else if (e.key === "ArrowRight") u = player.progress + 0.02;
      else if (e.key === "Home") u = 0;
      else if (e.key === "End") u = 1;
      if (u === null) return;
      e.preventDefault();
      e.stopPropagation();
      player.scrubTo(u);
      syncPlayBtn();
    });

    return {
      /* dwell arrival at a recon station: bind that station's player */
      attach(p, stationIndex) {
        if (!p) { this.detach(); return; }
        player = p;
        station = stationIndex;
        /* station 04's centre agreement cloud and its board free-run by
           design — the pause honestly claims only the flanking recon pair */
        tag.textContent = stationIndex === 4
          ? "MULTI-VIEW RECON REPLAY" : "SINGLE-VIEW RECON REPLAY";
        rebuildTicks();
        lastText = ""; lastPaused = null; lastU = -1;
        lastStage = -1; lastStep = -1; lastSteps = -1;
        lastLoadState = "";
        syncLoadState();
        syncPlayBtn();
        el.classList.add("show");
      },
      /* leaving the station ends any pause — the pause belongs to the widget,
         not to the world, so exhibits never stay frozen behind our back */
      detach() {
        if (player) player.setPaused(false);
        player = null; station = null; dragging = false;
        el.classList.remove("show");
      },
      /* driven from the render loop (deterministic under ?fixedstep) */
      update() {
        if (!player) return;
        syncLoadState();
        if ((player.version ?? 0) !== boundVersion) rebuildTicks();
        const u = player.progress;
        if (Math.abs(u - lastU) > 0.0005) {
          lastU = u;
          /* left%, not translateX%: percentage transforms resolve against the
             head's own box, left against the track. One tiny element inside
             an isolated fixed pill — the gated layout write is negligible. */
          head.style.left = `${(u * 100).toFixed(2)}%`;
        }
        const st = player.state;
        if (canScrub() && (st.stage !== lastStage || st.step !== lastStep || st.steps !== lastSteps)) {
          lastStage = st.stage; lastStep = st.step; lastSteps = st.steps;
          lastText =
            `S${st.stage} · STEP ${String(st.step + 1).padStart(2, "0")}/${st.steps}`;
          label.textContent = lastText;
          track.setAttribute("aria-valuenow", String(Math.round(u * 100)));
          track.setAttribute("aria-valuetext", lastText);
        }
        syncPlayBtn();
      },
      get qaState() {
        const st = player ? player.state : null;
        return {
          visible: el.classList.contains("show"),
          station,
          paused: player ? player.paused : null,
          u: player ? player.progress : null,
          stage: st ? st.stage : null,
          step: st ? st.step : null,
          loadState: player?.loadState ?? null,
          ready: player?.ready ?? false,
          version: player?.version ?? null,
          enabled: !!canScrub(),
          label: label.textContent
        };
      }
    };
  } catch (err) {
    /* the world must load scrubberless rather than not at all */
    console.warn("step scrubber disabled:", err);
    return { attach() {}, detach() {}, update() {}, get qaState() { return { visible: false }; } };
  }
}
