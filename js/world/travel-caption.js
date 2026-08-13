/* Travel handoff caption: one top-center HUD line, visible while the camera
   rides between stations, narrating the data handoff on that leg.
   Deliberately NOT class "ui": body.tour hides .ui, and this caption is the
   one piece of chrome the ?tour=1 narration keeps. */

import { LEGS, hopCaption } from "./handoff-content.js?v=20260813-rgbd-pointcloud";

export function initTravelCaption() {
  try {
    const el = document.createElement("div");
    el.className = "travel-caption hud-mono";
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    let visible = false;
    const hide = () => {
      if (!visible) return;
      /* keep the text through the fade; assistive tech drops it immediately */
      el.classList.remove("show");
      el.setAttribute("aria-hidden", "true");
      visible = false;
    };
    const raise = (text) => {
      if (!text) { hide(); return; }
      el.textContent = text;
      el.classList.add("show");
      el.setAttribute("aria-hidden", "false");
      visible = true;
    };
    return {
      /* interactive travel from a to b (either direction, any distance) */
      show(a, b) {
        raise(Math.abs(b - a) === 1 ? LEGS[Math.min(a, b)] : hopCaption(a, b));
      },
      /* tour travel is always the single forward leg i → i+1 */
      showLeg(i) { raise(LEGS[i]); },
      hide
    };
  } catch (err) {
    /* the world must load captionless rather than not at all */
    console.warn("travel captions disabled:", err);
    return { show() {}, showLeg() {}, hide() {} };
  }
}
