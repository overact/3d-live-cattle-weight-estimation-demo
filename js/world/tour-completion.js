/* Each stop waits for its visible output, independently of the narration. */
export function exhibitCompletion(step, process, modelStates = [], deployment = {}, carry = {}) {
  const handingOff = carry.pendingStation === step &&
    ["waiting", "deposit", "pickup"].includes(carry.phase);
  if (step >= 1 && step <= 4) {
    if (process?.loadState === "unavailable") {
      return { exhibit: true, message: "REPLAY UNAVAILABLE · CONTINUING WITH THE EXPLANATION" };
    }
    return { exhibit: !!(process?.completed || process?.outputReady) && !handingOff, message: "" };
  }
  if (step === 5) {
    const settled = modelStates.length === 5 && modelStates.every(s => s === "ready" || s === "unavailable");
    return {
      exhibit: settled && (!handingOff || modelStates.includes("unavailable")),
      message: modelStates.includes("unavailable") ? "SOME MODELS UNAVAILABLE · SHOWING LOADED COMPARISONS" : ""
    };
  }
  return { exhibit: (step !== 8 || !!deployment.weightReady) && !handingOff, message: "" };
}
