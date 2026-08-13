/* A first-time reader needs one question per exhibit, not a second wall of
   prose. These prompts stay independent of the panel copy so the HUD can be
   brief while the panel carries methods and provenance. */

const GUIDE = [
  {
    question: "How can three RGB views become kilograms?",
    proof: "The amber path follows the paper from evidence to evaluated result."
  },
  {
    question: "What enters the pipeline?",
    proof: "Matched left, right, and top RGB views; no scale or depth sensor at inference."
  },
  {
    question: "What is removed before 3D reconstruction?",
    proof: "SAM 3 isolates the cattle in each view with the prompt “cattle or cow”."
  },
  {
    question: "How does one RGB view become a 3D reconstruction?",
    proof: "Replay the real 50-step coarse structure and 25-step latent refinement trace."
  },
  {
    question: "Where does cross-view agreement act?",
    proof: "Per-view updates are weighted inside Stage 1; Stage 2 refines the shared structure across views."
  },
  {
    question: "Does the 3D representation change the weight result?",
    proof: "Compare reconstruction sources under the same downstream evaluation protocol."
  },
  {
    question: "How does geometry become a feature vector?",
    proof: "The world overlay illustrates the paper's geometric, shape, percentile, density, and statistical groups."
  },
  {
    question: "What result is actually supported?",
    proof: "Dataset result: 103 cattle, 5-fold CV, 2.22±0.56% MAPE and R² 0.69±0.10."
  },
  {
    question: "What could deployment look like?",
    proof: "Approaching the gantry starts left → right → top RGB handoff; the real 5,941-point cow then moves along the northbound line into an illustrative—not inferred—kg stage."
  }
];

export function initReaderGuide() {
  const el = document.getElementById("researchGuide");
  const stepEl = document.getElementById("guideStep");
  const questionEl = document.getElementById("guideQuestion");
  const proofEl = document.getElementById("guideProof");

  function show(index) {
    const i = Math.min(GUIDE.length - 1, Math.max(0, index));
    const item = GUIDE[i];
    stepEl.textContent = `${String(i).padStart(2, "0")} / 08`;
    questionEl.textContent = item.question;
    proofEl.textContent = item.proof;
    el.classList.add("show");
  }

  function overview() {
    stepEl.textContent = "MAP";
    questionEl.textContent = "Choose the evidence you want to inspect.";
    proofEl.textContent = "Click an exhibit, follow the numbered path, or enter calf roam mode.";
    el.classList.add("show");
  }

  function hide() {
    el.classList.remove("show");
  }

  return { show, overview, hide };
}
