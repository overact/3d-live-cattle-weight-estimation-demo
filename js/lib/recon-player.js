/* recon-player.js — reusable point-cloud "reconstruction process" player.
   Visualizes SAM-3D's TWO-STAGE diffusion reconstruction as a looping
   animation. Deterministic: everything is a pure function of the clock
   handed to update(t), so tour seeking and recording work.

   Timeline per loop:
     STAGE-1 (sparse structure): points converge out of a noise shell into
       the coarse voxel shape (uP 0→1);
     STAGE-2 (structured-latent refinement): the settled shape sharpens —
       residual shimmer anneals away, points tighten and take their final
       tone (uQ 0→1);
     hold → quick dissolve → repeat.

   Two data modes, chosen by what you pass in:

   REAL mode — stepsPayload: true per-step geometry (see
     scripts/PLAN_C_EXPORT.md). meta.json { steps, counts, stages? } +
     steps.bin (normalized int16 xyz, with legacy float32 support). The required
     stage2.rgba.bin carries
     model-predicted degree-0 SH color plus aggregate opacity. stages [n1, n2] marks
     where stage-2 begins in the step sequence; the player swaps the visible
     positions per step — genuine evolving geometry.

   STYLIZED mode — only `positions` (the final cloud): geometry is
     synthesized. Label it as stylized in the UI. */

import * as THREE from "../../vendor/three.module.js";

/* deterministic per-index hash (0..1) — no Math.random, seek-safe */
function hash1(i, salt) {
  let h = (i * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export async function loadReconSteps(baseUrl) {
  try {
    /* Start geometry beside metadata; declared model color is part of the
       trace contract and must arrive before the evidence is displayable. */
    const [metaResponse, stepsResponse] = await Promise.all([
      fetch(`${baseUrl}/meta.json`, { cache: "no-cache" }),
      fetch(`${baseUrl}/steps.bin`, { cache: "no-cache" })
    ]);
    if (!metaResponse.ok || !stepsResponse.ok) {
      throw new Error(
        `${baseUrl} reconstruction trace → HTTP ${metaResponse.status}/${stepsResponse.status}`
      );
    }
    const meta = await metaResponse.json();
    if (!meta.stage2Rgba?.file) {
      throw new Error("Stage-2 model-color export is missing");
    }
    const rgbaRequest = fetch(
      `${baseUrl}/${meta.stage2Rgba.file}`, { cache: "no-cache" });
    const buf = await stepsResponse.arrayBuffer();
    if (!Array.isArray(meta.counts) || meta.counts.length !== meta.steps) {
      throw new Error("reconstruction step count mismatch");
    }
    if (!Array.isArray(meta.stages) || meta.stages.reduce((a, b) => a + b, 0) !== meta.steps) {
      throw new Error("reconstruction stage count mismatch");
    }
    if (meta.stageStepIds && (
      meta.stageStepIds.length !== 2 ||
      meta.stageStepIds[0].length !== meta.stages[0] ||
      meta.stageStepIds[1].length !== meta.stages[1])) {
      throw new Error("reconstruction source step ids mismatch");
    }
    const total = meta.counts.reduce((a, b) => a + b, 0);
    const positionEncoding = meta.positionEncoding || {
      format: "float32", itemSize: 3, normalized: false, scale: 1
    };
    if (positionEncoding.itemSize !== 3 ||
        !["int16", "float32"].includes(positionEncoding.format)) {
      throw new Error("unsupported reconstruction position encoding");
    }
    const bytesPerComponent = positionEncoding.format === "int16" ? 2 : 4;
    if (buf.byteLength !== total * 3 * bytesPerComponent) {
      throw new Error(`steps.bin size mismatch`);
    }
    let positions;
    if (positionEncoding.format === "int16") {
      if (positionEncoding.normalized !== true ||
          Math.abs(positionEncoding.scale - 1 / 32767) > 1e-12) {
        throw new Error("invalid normalized int16 position encoding");
      }
      const packed = new Int16Array(buf);
      positions = new Float32Array(packed.length);
      const scale = positionEncoding.scale;
      for (let i = 0; i < packed.length; i++) positions[i] = packed[i] * scale;
    } else {
      positions = new Float32Array(buf);
    }
    const rgbaResponse = await rgbaRequest;
    if (!rgbaResponse.ok) {
      throw new Error(`${baseUrl}/${meta.stage2Rgba.file} → HTTP ${rgbaResponse.status}`);
    }
    const rgbaBuffer = await rgbaResponse.arrayBuffer();
    const expectedCounts = meta.counts.slice(meta.stages[0]);
    if (
      meta.stage2Rgba.itemSize !== 4 ||
      meta.stage2Rgba.format !== "uint8" ||
      !Array.isArray(meta.stage2Rgba.counts) ||
      meta.stage2Rgba.counts.length !== expectedCounts.length ||
      meta.stage2Rgba.counts.some((count, i) => count !== expectedCounts[i])
    ) {
      throw new Error("Stage-2 RGBA metadata mismatch");
    }
    const expectedBytes = expectedCounts.reduce((a, b) => a + b, 0) * 4;
    if (rgbaBuffer.byteLength !== expectedBytes) {
      throw new Error("stage2.rgba.bin size mismatch");
    }
    const stage2Rgba = new Uint8Array(rgbaBuffer);
    /* How many Gaussians each latent voxel contributes to a Stage-2 frame.
       1 is the legacy centroid trace. Anything higher means the frame arrays
       are voxel-major with this run length, strongest Gaussian first — which
       is what lets a weak device draw only a prefix of each voxel. */
    const stage2PerVoxel = Math.max(1, Math.trunc(meta.stage2GaussiansPerVoxel || 1));
    if (stage2PerVoxel > 1 &&
        meta.counts.slice(meta.stages[0]).some((n) => n % stage2PerVoxel)) {
      throw new Error(
        `Stage-2 counts are not whole voxels of ${stage2PerVoxel}`);
    }
    return {
      steps: meta.steps, counts: meta.counts,
      stages: meta.stages || null,
      stageStepIds: meta.stageStepIds || null,
      stageTotals: [meta.trace?.stage1_steps, meta.trace?.stage2_steps],
      source: meta.source || null,
      trace: meta.trace || null,
      positions,
      positionEncoding,
      stage2PerVoxel,
      stage2Rgba
    };
  } catch (err) {
    console.warn(`Reconstruction trace unavailable for ${baseUrl}:`, err);
    return null;   // caller keeps the evidence mount empty and offers retry
  }
}

/* Source indices for drawing `keep` of every `perVoxel` Gaussians.

   The exporter writes each voxel's run strongest-first, so a prefix is the
   most opaque subset rather than an arbitrary one. Indices increase with the
   voxel, which means the array built for the largest frame is also correct,
   as a prefix, for every smaller frame — one allocation covers the trace. */
export function stage2LodIndices(maxCount, perVoxel, keep) {
  if (!(perVoxel > 1) || keep >= perVoxel) return null;   // nothing to thin
  const voxels = Math.floor(maxCount / perVoxel);
  const out = new Int32Array(voxels * keep);
  for (let v = 0, w = 0; v < voxels; v++) {
    const base = v * perVoxel;
    for (let j = 0; j < keep; j++) out[w++] = base + j;
  }
  return out;
}

/* Stage-2 soft-disc constants, exported so the unit tests assert the numbers
   the shader actually receives instead of restating them. */
export const STAGE2_DISC = {
  SIZE_BOOST: 1.30,      // regrow the footprint the gaussian falloff hides
  FALLOFF_K: 4.5,        // fragment weight = exp(-K * d^2)
  DISCARD_BELOW: 0.06,   // cheapest tail cut for the disc
  ADDITIVE_ALPHA: 0.40   // the additive arm's tuned per-point alpha compensation
};

export function createReconPlayer({
  positions,             // Float32Array [N*3] final cloud (model space)
  stepsPayload = null,   // real per-step payload from loadReconSteps()
  stageSteps = [50, 50], // step counts per stage for the readout
  period = 15,           // loop length in seconds
  s1Frac = 0.40,         // fraction spent on stage-1 structure convergence
  s2Frac = 0.24,         // fraction spent on stage-2 refinement
  dissolveFrac = 0.08,   // fraction melting back to noise (rest = hold)
  noiseRadius = 0.8,     // noise shell radius, in units of cloud half-extent
  pointSize = 0.50,
  stage2PointSize = pointSize * 0.88,
  stage1Opacity = 0.54,
  stage2Opacity = 0.62,
  stage2Exposure = 1.15,
  stage2Gamma = 0.85,
  stage2Density = null,  // Gaussians per voxel to DRAW; null = whatever the
                         // trace carries. Lower it on weak devices.
  stage2Blending = "normal", // "normal" | "additive" — soft-disc composite mode.
                         // Additive is order-independent but over-brightens
                         // dense overlaps; kept as a ?s2blend=additive A/B.
  hot = 0xe39b2d,        // unconverged (noisy) points
  cool = 0x86d7ea,       // stage-1 settled structure
  fine = 0xe8e4da,       // stage-2 refined final tone
  onStep = null          // onStep({stage, step, steps, label}) on change
} = {}) {
  const real = !!stepsPayload;
  const S = real ? stepsPayload.steps : null;
  const stages = real
    ? (stepsPayload.stages || [S, 0])
    : stageSteps;
  const stageStepIds = real && stepsPayload.stageStepIds
    ? stepsPayload.stageStepIds
    : stages.map((count) => Array.from({ length: count }, (_, i) => i));
  const stageTotals = real && stepsPayload.stageTotals
    ? stepsPayload.stageTotals.map((total, i) => total || stages[i])
    : stages;
  const N = real ? Math.max(...stepsPayload.counts) : positions.length / 3;
  const stage1Max = real
    ? Math.max(...stepsPayload.counts.slice(0, stages[0]), 0)
    : N;
  const stage2PerVoxel = real ? (stepsPayload.stage2PerVoxel || 1) : 1;
  const stage2Keep = Math.max(1, Math.min(
    stage2PerVoxel,
    Math.trunc(stage2Density ?? stage2PerVoxel)
  ));
  const stage2RawMax = real && stages[1] > 0
    ? Math.max(...stepsPayload.counts.slice(stages[0]), 0)
    : 0;
  const stage2Lod = real
    ? stage2LodIndices(stage2RawMax, stage2PerVoxel, stage2Keep)
    : null;
  /* A denser cloud describes the same surface with more, finer samples. sqrt
     scaling made the exported top-8 trace numerically dense but visually
     needle-thin; this softer exponent preserves LOD ordering while letting the
     real Gaussian centers read as one surface. */
  const stage2SizeScale = Math.pow(stage2Keep, -0.35);
  /* Buffer capacity is what is DRAWN, so opting a phone down to 4 of 8
     Gaussians also halves vertex memory, not just the draw work. */
  const stage2Max = real && stages[1] > 0
    ? (stage2Lod ? stage2Lod.length : stage2RawMax)
    : N;

  /* half-extent of the final cloud → noise shell scale */
  const finalPos = real
    ? stepsPayload.positions.subarray(
        stepsPayload.counts.slice(0, S - 1).reduce((a, b) => a + b, 0) * 3)
    : positions;
  let ext = 0;
  for (let i = 0; i < finalPos.length; i++) ext = Math.max(ext, Math.abs(finalPos[i]));
  const shell = ext * noiseRadius;

  function makeGeometry(capacity, withRgba = false) {
    const geo = new THREE.BufferGeometry();
    const source = real ? new Float32Array(capacity * 3) : new Float32Array(positions);
    const posAttr = new THREE.BufferAttribute(source, 3);
    if (real) posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", posAttr);

    /* Real traces need the stagger/grain hash but never sample the procedural
       noise shell, so skip its trigonometry on the evidence install path. */
    const noise = new Float32Array(capacity * 3);
    const rand = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      rand[i] = hash1(i, 17);
      if (real) continue;
      const u = hash1(i, 3) * 2 - 1;
      const a = hash1(i, 7) * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const rad = shell * (0.55 + 0.45 * hash1(i, 11));
      noise[i * 3] = Math.cos(a) * r * rad;
      noise[i * 3 + 1] = u * rad;
      noise[i * 3 + 2] = Math.sin(a) * r * rad;
    }
    geo.setAttribute("aNoise", new THREE.BufferAttribute(noise, 3));
    geo.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
    let rgbaAttr = null;
    if (withRgba) {
      rgbaAttr = new THREE.BufferAttribute(new Uint8Array(capacity * 4), 4, true);
      if (real) rgbaAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("aRGBA", rgbaAttr);
    }
    /* Three.js defaults to Infinity, which renders correctly but poisons QA
       counters and JSON reports, including the zero-vertex real-only mount. */
    geo.setDrawRange(0, capacity);
    return { geo, posAttr, rgbaAttr };
  }

  const stage1 = makeGeometry(stage1Max);
  const stage2 = makeGeometry(stage2Max, true);

  /* Small antialiased translucent points reveal the structure instead of
     reading as coarse opaque discs. */
  const stage1Mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.NormalBlending, fog: false,
    uniforms: {
      uP: { value: 0 },          // stage-1: 0 = noise, 1 = coarse structure
      uTime: { value: 0 },
      uSize: { value: pointSize },
      uOpacity: { value: stage1Opacity },
      uReal: { value: real ? 1 : 0 },
      uHot: { value: new THREE.Color(hot) },
      uCool: { value: new THREE.Color(cool) }
    },
    vertexShader: /* glsl */ `
      attribute vec3 aNoise;
      attribute float aRand;
      uniform float uP;
      uniform float uTime;
      uniform float uSize;
      uniform float uReal;
      varying float vE;
      void main() {
        /* staggered stage-1 convergence: each point locks on its own schedule */
        float e = clamp(uP * 1.35 - aRand * 0.35, 0.0, 1.0);
        e = e * e * (3.0 - 2.0 * e);
        vE = e;
        vec3 p = position;
        if (uReal < 0.5) {
          vec3 noisePos = position * 0.2 + aNoise;
          float w = 1.0 - e;
          noisePos += w * 0.05 * vec3(
            sin(uTime * 1.7 + aRand * 43.0),
            sin(uTime * 2.3 + aRand * 71.0),
            cos(uTime * 1.9 + aRand * 23.0));
          p = mix(noisePos, position, e);
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uSize * mix(1.45, 1.0, e) * (60.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHot;
      uniform vec3 uCool;
      uniform float uOpacity;
      varying float vE;
      void main() {
        float radius = length(gl_PointCoord - 0.5);
        float coverage = 1.0 - smoothstep(0.34, 0.50, radius);
        float alpha = uOpacity * coverage;
        if (alpha < 0.03) discard;
        vec3 col = mix(uHot, uCool, vE);
        gl_FragColor = vec4(col, alpha);
      }
    `
  });

  /* Stage 2 uses real model-predicted degree-0 SH RGB when the trace carries
     it. Older payloads retain the deterministic display palette. */
  const additive = stage2Blending === "additive";
  /* The gaussian falloff hides ~30% of the flat disc's footprint, so the
     point grows to keep apparent surface coverage; additive compositing sums
     overlaps instead of stacking them, so its per-point alpha drops hard. */
  const stage2Mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: false,
    uniforms: {
      uQ: { value: 0 },
      uTime: { value: 0 },
      uSize: { value: stage2PointSize * stage2SizeScale * STAGE2_DISC.SIZE_BOOST },
      uOpacity: { value: stage2Opacity * (additive ? STAGE2_DISC.ADDITIVE_ALPHA : 1) },
      uExposure: { value: stage2Exposure },
      uGamma: { value: stage2Gamma },
      uReal: { value: real ? 1 : 0 },
      uHasRealColor: { value: real && stepsPayload.stage2Rgba ? 1 : 0 },
      uLow: { value: new THREE.Color(0x3b2118) },
      uMid: { value: new THREE.Color(fine === 0xe8e4da ? 0xd88b2b : fine) },
      uHigh: { value: new THREE.Color(0xf3e6ca) }
    },
    vertexShader: /* glsl */ `
      attribute float aRand;
      attribute vec4 aRGBA;
      uniform float uQ;
      uniform float uTime;
      uniform float uSize;
      uniform float uReal;
      varying float vBand;
      varying float vGrain;
      varying vec4 vRGBA;
      void main() {
        vec3 p = position;
        if (uReal < 0.5) {
          p += (1.0 - uQ) * 0.018 * vec3(
            sin(uTime * 2.1 + aRand * 91.0),
            sin(uTime * 1.6 + aRand * 53.0),
            cos(uTime * 2.4 + aRand * 37.0));
        }
        vBand = clamp(position.z * 0.48 + 0.52 + 0.10 * sin(position.y * 8.0), 0.0, 1.0);
        vGrain = aRand;
        vRGBA = aRGBA;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uSize * mix(1.12, 0.96, uQ) * (60.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uLow;
      uniform vec3 uMid;
      uniform vec3 uHigh;
      uniform float uQ;
      uniform float uOpacity;
      uniform float uExposure;
      uniform float uGamma;
      uniform float uHasRealColor;
      varying float vBand;
      varying float vGrain;
      varying vec4 vRGBA;
      void main() {
        /* soft gaussian disc instead of a flat coin: the fragment's weight
           falls off as exp(-k d^2), so each point reads as a splat-like blob
           and dense overlaps blend into a continuous surface */
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float coverage = exp(-${STAGE2_DISC.FALLOFF_K} * d * d);
        if (coverage < ${STAGE2_DISC.DISCARD_BELOW}) discard;
        float lower = smoothstep(0.05, 0.58, vBand);
        float upper = smoothstep(0.58, 0.96, vBand);
        vec3 col = mix(uLow, uMid, lower);
        col = mix(col, uHigh, upper);
        col *= 0.88 + 0.18 * vGrain;
        col = mix(col, uHigh, 0.08 * uQ);
        vec3 modelRGB = pow(clamp(vRGBA.rgb * uExposure, 0.0, 1.0), vec3(uGamma));
        col = mix(col, modelRGB, uHasRealColor);
        float modelAlpha = mix(1.0, 0.45 + 0.55 * vRGBA.a, uHasRealColor);
        float alpha = uOpacity * modelAlpha * coverage;
        if (alpha < 0.03) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `
  });

  const stage1Points = new THREE.Points(stage1.geo, stage1Mat);
  const stage2Points = new THREE.Points(stage2.geo, stage2Mat);
  /* A conservative fixed sphere covers normalized geometry plus the stylized
     noise shell, while still allowing off-camera stations to be culled. */
  stage1.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2.4);
  stage2.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2.4);
  stage1Points.frustumCulled = true;
  stage2Points.frustumCulled = true;
  stage2Points.visible = false;
  const stage1Root = new THREE.Group();
  const stage2Root = new THREE.Group();
  stage1Root.add(stage1Points);
  stage2Root.add(stage2Points);
  const group = new THREE.Group();
  group.add(stage1Root, stage2Root);

  /* real mode: copy step k's positions in and clamp the draw range */
  const stepOffsets = [];
  const stage2RgbaOffsets = [];
  if (real) {
    let off = 0;
    for (const c of stepsPayload.counts) { stepOffsets.push(off); off += c; }
    let rgbaOff = 0;
    for (const c of stepsPayload.counts.slice(stages[0])) {
      stage2RgbaOffsets.push(rgbaOff);
      rgbaOff += c;
    }
  }
  function setRealStep(stageIndex, frame) {
    const k = stageIndex === 0 ? frame : stages[0] + frame;
    const n = stepsPayload.counts[k];
    const target = stageIndex === 0 ? stage1 : stage2;
    if (stageIndex === 1 && stage2Lod) {
      /* Thinned: gather the leading (most opaque) Gaussians of each voxel.
         Indices rise with the voxel, so the prefix of the shared index array
         that covers this frame's voxels is exactly the right slice. */
      const drawn = Math.floor(n / stage2PerVoxel) * stage2Keep;
      const src = stepsPayload.positions;
      const base = stepOffsets[k] * 3;
      const dst = target.posAttr.array;
      for (let i = 0; i < drawn; i++) {
        const s = base + stage2Lod[i] * 3;
        const d = i * 3;
        dst[d] = src[s];
        dst[d + 1] = src[s + 1];
        dst[d + 2] = src[s + 2];
      }
      target.posAttr.needsUpdate = true;
      target.geo.setDrawRange(0, drawn);
      if (stepsPayload.stage2Rgba) {
        const rgba = stepsPayload.stage2Rgba;
        const rgbaBase = stage2RgbaOffsets[frame] * 4;
        const rdst = target.rgbaAttr.array;
        for (let i = 0; i < drawn; i++) {
          const s = rgbaBase + stage2Lod[i] * 4;
          const d = i * 4;
          rdst[d] = rgba[s];
          rdst[d + 1] = rgba[s + 1];
          rdst[d + 2] = rgba[s + 2];
          rdst[d + 3] = rgba[s + 3];
        }
        target.rgbaAttr.needsUpdate = true;
      }
      return;
    }
    target.posAttr.array.set(
      stepsPayload.positions.subarray(stepOffsets[k] * 3, (stepOffsets[k] + n) * 3));
    target.posAttr.needsUpdate = true;
    target.geo.setDrawRange(0, n);
    if (stageIndex === 1 && stepsPayload.stage2Rgba) {
      const rgbaOff = stage2RgbaOffsets[frame] * 4;
      target.rgbaAttr.array.set(
        stepsPayload.stage2Rgba.subarray(rgbaOff, rgbaOff + n * 4)
      );
      target.rgbaAttr.needsUpdate = true;
    }
  }

  /* loop schedule: pure function of t → {P, Q} */
  const holdFrac = Math.max(0.05, 1 - s1Frac - s2Frac - dissolveFrac);
  function phasesAt(t) {
    const local = ((t % period) + period) % period / period;
    if (local < s1Frac) return { P: local / s1Frac, Q: 0 };
    if (local < s1Frac + s2Frac) return { P: 1, Q: (local - s1Frac) / s2Frac };
    if (local < s1Frac + s2Frac + holdFrac) return { P: 1, Q: 1 };
    const r = 1 - (local - s1Frac - s2Frac - holdFrac) / dissolveFrac;
    return { P: Math.max(0, r), Q: Math.max(0, r) };
  }

  /* readout state from {P,Q}: which stage, which step within it */
  function stateOf(P, Q) {
    const describe = (stage, frame) => ({
      stage,
      frame,
      step: stageStepIds[stage - 1][frame] ?? frame,
      steps: stageTotals[stage - 1]
    });
    if (P < 1) {
      return describe(1, Math.min(stages[0] - 1, Math.floor(P * stages[0])));
    }
    if (stages[1] <= 0) {   // stage-1-only data: hold on its final step
      return describe(1, stages[0] - 1);
    }
    if (Q < 1) {
      return describe(2, Math.min(stages[1] - 1, Math.floor(Q * stages[1])));
    }
    return describe(2, stages[1] - 1);
  }

  /* ---- pause / scrub: a virtual clock in front of the caller's clock ----
     The caller keeps passing its own monotonically-growing time; while paused
     the player renders a frozen virtual time, and on resume the loop continues
     from that exact phase (drift re-anchors on the next update call). Scrubbing
     maps the step-scrubber's 0..1 track onto the ACTIVE window (stage 1 + 2);
     hold and dissolve are playback-only. */
  const activeFrac = s1Frac + s2Frac;
  let paused = false, pauseT = 0, drift = 0, syncDrift = false, lastVT = 0;
  /* Completion is a one-shot simulation event, not "currently showing the
     final frame". The final frame appears slightly before Q reaches 1 and the
     loop later dissolves, so downstream handoffs need this latched boundary. */
  let completed = false;
  function setPaused(on) {
    on = !!on;
    if (on === paused) return;
    paused = on;
    if (on) pauseT = lastVT;
    else syncDrift = true;
  }
  function scrubTo(u) {
    u = Math.min(1, Math.max(0, u));
    /* route the pause through setPaused so any future side effect it grows
       applies here too; then aim the frozen clock at the target phase */
    setPaused(true);
    pauseT = Math.min(u, 0.9999) * activeFrac * period;
  }
  /* exhibits restart their local clock at 0 on every dwell arrival (onActive
     → update(0)); the virtual clock must forget old drift/pause state or the
     revisit would resume mid-phase instead of at the noise shell */
  function resetClock() {
    paused = false; pauseT = 0; drift = 0; syncDrift = false; lastVT = 0;
    completed = false;
  }
  /* playhead position on the scrubber track (0..1 over the active window);
     parks at 1 through hold and dissolve so the head doesn't rewind early */
  function progressOf(vt) {
    const local = (((vt % period) + period) % period) / period;
    return Math.min(1, local / activeFrac);
  }
  /* tick positions: every 10th SOURCE step of each stage, plus the boundary.
     Uses the captured step ids, so a trace with trimmed/strided frames places
     the tick at the first frame that reaches the decade. */
  function tickUs() {
    const ticks = [];
    for (let stage = 0; stage < 2; stage++) {
      const ids = stageStepIds[stage];
      if (!ids.length) continue;
      const total = stageTotals[stage] || ids.length;
      const frac = stage === 0 ? s1Frac : s2Frac;
      const base = stage === 0 ? 0 : s1Frac;
      for (let d = 10; d < total; d += 10) {
        const f = ids.findIndex((id) => id >= d);
        if (f < 0) continue;
        ticks.push({ u: (base + (f / ids.length) * frac) / activeFrac, major: false });
      }
    }
    if (stages[1] > 0) ticks.push({ u: s1Frac / activeFrac, major: true });
    return ticks;
  }

  let last = { stage: -1, frame: -1, step: -1 };
  function update(callerT) {
    if (syncDrift) { drift = callerT - pauseT; syncDrift = false; }
    const t = paused ? pauseT : callerT - drift;
    lastVT = t;
    const { P, Q } = phasesAt(t);
    stage1Mat.uniforms.uP.value = P;
    stage1Mat.uniforms.uTime.value = t;
    stage2Mat.uniforms.uQ.value = Q;
    stage2Mat.uniforms.uTime.value = t;
    const st = stateOf(P, Q);
    if (st.stage !== last.stage || st.frame !== last.frame) {
      last = st;
      if (real) {
        if (st.stage === 1) {
          setRealStep(0, st.frame);
          stage2Points.visible = false;
        } else {
          /* The final sparse structure remains as a fixed reference while
             Stage 2 evolves independently beside it. */
          setRealStep(0, stages[0] - 1);
          setRealStep(1, st.frame);
          stage2Points.visible = true;
        }
      } else {
        stage2Points.visible = st.stage === 2;
      }
      if (onStep) onStep(st);
    }
    /* Use virtual local time instead of the visible final-frame index. This is
       robust to a large dt crossing directly into hold, while scrubTo(1)'s
       deliberate 0.9999 clamp cannot complete a process accidentally. */
    if (!completed && t >= activeFrac * period) completed = true;
  }
  update(0);

  return {
    points: group, group, stage1Root, stage2Root, stage1Points, stage2Points,
    update, phasesAt,
    stage2PerVoxel, stage2Keep,
    /* scrubber contract */
    setPaused, scrubTo, tickUs, resetClock,
    get paused() { return paused; },
    get progress() { return progressOf(lastVT); },
    /* The floor progress strips need the player's virtual clock after pause,
       scrub and resume drift have been applied—not the caller's wall clock. */
    get phases() { return phasesAt(lastVT); },
    get completed() { return completed; },
    get state() { return last; },
    get isReal() { return real; }
  };
}

/* A stable scene-graph/player facade for traces that arrive after the world
   shell. Stations and DOM controls bind once to the facade; install() swaps
   only the two point-cloud implementations under permanent mount roots. This
   avoids rebuilding a station (and invalidating camera, LOD and QA handles)
   when a multi-megabyte evidence trace finishes downloading. */
export function createDeferredReconPlayer(options = {}) {
  const group = new THREE.Group();
  const stage1Root = new THREE.Group();
  const stage2Root = new THREE.Group();
  group.add(stage1Root, stage2Root);

  let current = null;
  let loadState = options.stepsPayload ? "ready" : "idle";
  let version = 0;

  function disposeObject(root) {
    root.traverse((obj) => {
      obj.geometry?.dispose?.();
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const material of materials) material?.dispose?.();
    });
  }

  function adopt(next) {
    if (current) {
      const oldStage1 = stage1Root.children[0] || null;
      const oldStage2 = stage2Root.children[0] || null;
      stage1Root.clear();
      stage2Root.clear();
      if (oldStage1) disposeObject(oldStage1);
      if (oldStage2) disposeObject(oldStage2);
    }
    next.group.remove(next.stage1Root, next.stage2Root);
    stage1Root.add(next.stage1Root);
    stage2Root.add(next.stage2Root);
    current = next;
    version += 1;
  }

  const realOnly = options.realOnly === true;
  /* Paper-evidence stations fail closed: their stable mount exists immediately,
     but it contains zero vertices until an exported trace is installed. */
  const initialOptions = realOnly && !options.stepsPayload
    ? { ...options, positions: new Float32Array(0) }
    : options;
  adopt(createReconPlayer(initialOptions));
  if (realOnly && !current.isReal) {
    current.stage1Points.visible = false;
    current.stage2Points.visible = false;
  }

  const facade = {
    points: group,
    group,
    stage1Root,
    stage2Root,
    markLoading() {
      if (!current.isReal) loadState = "loading";
    },
    install(stepsPayload) {
      if (!stepsPayload) {
        this.markUnavailable();
        return false;
      }
      const wasPaused = current.paused;
      const progress = current.progress;
      adopt(createReconPlayer({ ...options, stepsPayload }));
      loadState = "ready";
      if (wasPaused) current.scrubTo(progress);
      return true;
    },
    markUnavailable() {
      if (!current.isReal) loadState = "unavailable";
    },
    update(t) {
      if (!realOnly || current.isReal) current.update(t);
    },
    phasesAt(t) { return current.phasesAt(t); },
    setPaused(on) { current.setPaused(on); },
    scrubTo(u) { current.scrubTo(u); },
    tickUs() { return current.tickUs(); },
    resetClock() { current.resetClock(); },
    dispose() {
      const s1 = stage1Root.children[0] || null;
      const s2 = stage2Root.children[0] || null;
      stage1Root.clear();
      stage2Root.clear();
      if (s1) disposeObject(s1);
      if (s2) disposeObject(s2);
    },
    get stage1Points() { return current.stage1Points; },
    get stage2Points() { return current.stage2Points; },
    get stage2PerVoxel() { return current.stage2PerVoxel; },
    get stage2Keep() { return current.stage2Keep; },
    get paused() { return current.paused; },
    get progress() { return current.progress; },
    get phases() { return current.phases; },
    get completed() { return current.completed; },
    get state() { return current.state; },
    get isReal() { return current.isReal; },
    get ready() { return loadState === "ready" && current.isReal; },
    get loadState() { return loadState; },
    get version() { return version; }
  };
  return facade;
}
