import assert from "node:assert/strict";
import {
  AUTO_TOUR_STEPS,
  clampTourStepIndex,
  createAutoTour
} from "../js/world/auto-tour.js?v=20260907-ranch-drive-v6";

assert.equal(AUTO_TOUR_STEPS.length, 9, "tour must cover Steps 00-08");
assert.deepEqual(AUTO_TOUR_STEPS.map((step) => step.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
assert.deepEqual(AUTO_TOUR_STEPS.map((step) => step.number), ["00", "01", "02", "03", "04", "05", "06", "07", "08"]);
for (const step of AUTO_TOUR_STEPS) {
  for (const obsolete of ["approachSeconds", "dwellSeconds", "approachActions", "dwellActions"]) {
    assert.equal(obsolete in step, false,
      `Step ${step.number} must not carry timer-driven presentation policy (${obsolete})`);
  }
  for (const defensiveAside of [
    /not a live prediction/i,
    /not claiming/i,
    /perfect geometry/i
  ]) {
    assert.doesNotMatch(`${step.narration} ${step.speech}`, defensiveAside,
      `Step ${step.number} must stay in presenter voice without defensive asides`);
  }
}
assert.match(AUTO_TOUR_STEPS[3].narration, /baseline/i);
assert.match(AUTO_TOUR_STEPS[4].narration, /both stages/i);
assert.match(AUTO_TOUR_STEPS[8].narration, /illustrative 480 kg/i);

assert.equal(clampTourStepIndex(undefined), 0);
assert.equal(clampTourStepIndex(-20), 0);
assert.equal(clampTourStepIndex(4.6), 5);
assert.equal(clampTourStepIndex(99), 8);

/* Arrival is an event, not a minimum approach duration. A missing arrival may
   wait indefinitely without retry timers or authored-clock side effects. */
const travelLog = [];
const roamState = { nearStation: -1, grounded: true, autoTarget: 0 };
let signals = { narration: false, exhibit: false };
const tour = createAutoTour({
  travelTo(index) { travelLog.push(index); },
  getRoamState: () => roamState,
  getCompletionState: () => signals
});

assert.equal(tour.start(-8), 0);
tour.update(999);
assert.equal(tour.qaState.phase, "approach");
assert.equal(tour.qaState.stepIndex, 0);
assert.deepEqual(travelLog, [0], "director must not poll travelTo with a retry timer");

roamState.nearStation = 0;
roamState.autoTarget = null;
tour.update(0.01);
assert.equal(tour.qaState.phase, "dwell");
tour.update(999);
assert.equal(tour.qaState.phase, "dwell", "presentation must wait for completion events, not elapsed time");
assert.deepEqual(tour.qaState.completion, { narration: false, exhibit: false });

/* The completion barrier is latched. This matters for looping Step 08: its
   kg-ready state can pass before a slow voice finishes and must still count. */
signals = { narration: false, exhibit: true };
tour.update(0.01);
assert.deepEqual(tour.qaState.completion, { narration: false, exhibit: true });
signals = { narration: true, exhibit: false };
tour.update(0.01);
assert.equal(tour.qaState.phase, "approach");
assert.equal(tour.qaState.stepIndex, 1);

/* With immediate test adapters, exactly two update events advance each Step:
   physical arrival, then the completion barrier. */
const fastTravel = [];
const fastState = { nearStation: 0, grounded: true, autoTarget: null };
const fastTour = createAutoTour({
  travelTo(index) {
    fastTravel.push(index);
    fastState.nearStation = index;
    fastState.autoTarget = null;
  },
  getRoamState: () => fastState,
  getCompletionState: () => ({ narration: true, exhibit: true })
});
fastTour.start(0);
for (let i = 0; i < AUTO_TOUR_STEPS.length; i++) {
  fastTour.update(0.01);
  assert.equal(fastTour.qaState.phase, "dwell");
  fastTour.update(0.01);
}
assert.equal(fastTour.qaState.cycleNumber, 1);
assert.equal(fastTour.qaState.stepIndex, 0);
assert.deepEqual(fastTravel, [0, 1, 2, 3, 4, 5, 6, 7, 8, 0]);

fastTour.start(5);
for (let i = 0; i < AUTO_TOUR_STEPS.length; i++) {
  fastTour.update(0.01);
  fastTour.update(0.01);
}
assert.deepEqual(fastTravel.slice(-10), [5, 6, 7, 8, 0, 1, 2, 3, 4, 5]);

function assertInterruptsCleanly(arriveFirst, expectedPhase) {
  let cancellations = 0;
  const releases = [];
  const interruptState = {
    nearStation: arriveFirst ? 0 : -1,
    grounded: true,
    autoTarget: arriveFirst ? null : 0
  };
  const interruptTour = createAutoTour({
    travelTo() {},
    press(action, down) { releases.push([action, down]); },
    getRoamState: () => interruptState,
    getCompletionState: () => ({ narration: false, exhibit: true }),
    cancelTravel() { cancellations += 1; }
  });
  interruptTour.start(0);
  if (arriveFirst) interruptTour.update(0.01);
  assert.equal(interruptTour.qaState.phase, expectedPhase);
  assert.equal(interruptTour.stop(`test-${expectedPhase}`), true);
  assert.equal(interruptTour.active, false);
  assert.equal(cancellations, 1);
  for (const action of ["run", "jump", "dash"]) {
    assert(releases.some(([released, down]) => released === action && down === false));
  }
}

assertInterruptsCleanly(false, "approach");
assertInterruptsCleanly(true, "dwell");

const selections=[],selectionEvents=[];
let selectedPose={nearStation:0,grounded:true,autoTarget:null};
const selectionTour=createAutoTour({travelTo:i=>selections.push(i),getRoamState:()=>selectedPose,
  getCompletionState:()=>({narration:false,exhibit:true}),onState:s=>selectionEvents.push(s)});
selectionTour.start(0);selectionTour.update(.01);
selectionTour.selectStep(4);
assert.equal(selectionTour.active,true);assert.equal(selectionTour.qaState.phase,"approach");
assert.equal(selectionTour.qaState.stepIndex,4);assert.equal(selectionTour.qaState.lastStopReason,null);
selectedPose={nearStation:4,grounded:true,autoTarget:null};selectionTour.update(.01);
assert.equal(selectionTour.qaState.phase,"dwell");
selectionTour.selectStep(2);selectionTour.selectStep(4);
assert.deepEqual(selections,[0,4,2,4]);
assert.equal(selectionEvents.some(s=>s.type==="stop"),false,"step selection never exits narration mode");
assert.equal(selectionEvents.at(-1).type,"start","same-step reselect resets voice deduplication");
console.log("Auto tour verified: arrival, narration barriers, and Step selection without mode exit.");
