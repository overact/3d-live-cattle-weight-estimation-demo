import assert from "node:assert/strict";
import { exhibitCompletion } from "../js/world/tour-completion.js";
import { stationAcceptsArtifact, submissionStationForArtifact } from "../js/world/pipeline-carry.js?v=20260907-ranch-drive-v6";
import { PRIMARY_PIPELINE_IDS, PIPELINE_BRANCHES } from "../js/world/pipeline-map.js?v=20260907-ranch-drive-v6";

for (const step of [1, 2, 3, 4]) {
  assert.equal(exhibitCompletion(step, { ready: true, completed: false }).exhibit, false);
  assert.equal(exhibitCompletion(step, { completed: true }).exhibit, true);
  assert.equal(exhibitCompletion(step, { loadState: "loading" }).exhibit, false);
  const unavailable = exhibitCompletion(step, { loadState: "unavailable" });
  assert.equal(unavailable.exhibit, true);
  assert.match(unavailable.message, /UNAVAILABLE/);
}
assert.equal(exhibitCompletion(5, null, ["ready"]).exhibit, false);
assert.equal(exhibitCompletion(5, null, ["ready", "ready", "ready", "ready", "loading"]).exhibit, false);
assert.equal(exhibitCompletion(5, null, Array(5).fill("ready")).exhibit, true);
assert.match(exhibitCompletion(5, null, ["ready", "ready", "ready", "ready", "unavailable"]).message, /UNAVAILABLE/);
assert.equal(exhibitCompletion(8, null, [], { weightReady: false }).exhibit, false);
assert.equal(exhibitCompletion(8, null, [], { weightReady: true }).exhibit, true);
assert.equal(exhibitCompletion(3, { completed: true }, [], {}, { pendingStation: 3, phase: "pickup" }).exhibit, false);
assert.equal(exhibitCompletion(3, { completed: true }, [], {}, { pendingStation: null, phase: "carry" }).exhibit, true);
assert.equal(stationAcceptsArtifact(4, 2, "single-view-next"), true, "fusion accepts masks directly from segmentation");
assert.equal(stationAcceptsArtifact(4, 2, "multi-view-next"), true, "optional baseline can return the triptych");
assert.equal(stationAcceptsArtifact(4, 2, "single-view-processing"), false, "partial triptych cannot be submitted");
assert.equal(stationAcceptsArtifact(4, 3), false, "single-view geometry is not fusion input");
assert.equal(stationAcceptsArtifact(6, 4), true, "features accept fusion directly without a comparison stop");
assert.equal(stationAcceptsArtifact(6, 5), true);
assert.equal(submissionStationForArtifact(2, "single-view-next"), 4);
assert.equal(submissionStationForArtifact(4), 6);
assert.deepEqual(PRIMARY_PIPELINE_IDS, ["capture", "segment", "fusion", "features", "weigh"]);
assert(PIPELINE_BRANCHES.some(branch => branch.id === "reconstruct" && branch.kind === "evidence"));
console.log("Tour exhibit barriers verified: capture, masks, both traces, all comparisons, deployment.");
