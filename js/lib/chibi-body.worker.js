/* chibi-body.worker.js — builds the one-piece calf body off the main thread.
   The page stays perfectly smooth while ~100 ms of SDF sampling runs here. */

import { buildCalfBodyData } from "./chibi-body-core.js";

self.onmessage = (e) => {
  const data = buildCalfBodyData(e.data && e.data.palette);
  self.postMessage(data, [
    data.positions.buffer,
    data.normal.buffer,
    data.color.buffer,
    data.skinIndex.buffer,
    data.skinWeight.buffer,
    data.index.buffer
  ]);
};
