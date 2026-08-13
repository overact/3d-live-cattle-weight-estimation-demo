/* Full-resolution case views are only useful at the capture, segmentation,
   and single-view reconstruction exhibits. Keep the gate and later stations
   free of those decodes until a relevant station is requested. */
export function needsFullSourceTextures(station) {
  return Number.isInteger(station) && station >= 1 && station <= 3;
}
