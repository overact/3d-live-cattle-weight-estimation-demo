export function createRenderLifecycle({ renderer, frame, documentRef = document }) {
  let wantsRendering = false;
  let rendering = false;
  let suspended = false;
  let disposed = false;

  function sync() {
    const nextRendering = wantsRendering && !suspended && !disposed && !documentRef.hidden;
    if (nextRendering === rendering) return;
    renderer.setAnimationLoop(nextRendering ? frame : null);
    rendering = nextRendering;
  }

  function onVisibilityChange() {
    sync();
  }

  function start() {
    if (disposed || wantsRendering) return;
    wantsRendering = true;
    sync();
  }

  function stop() {
    if (!wantsRendering && !rendering && !suspended) return;
    wantsRendering = false;
    suspended = false;
    sync();
  }

  function suspend() {
    if (disposed || suspended || !wantsRendering) return;
    suspended = true;
    sync();
  }

  function resume() {
    if (disposed || !suspended) return;
    suspended = false;
    sync();
  }

  function dispose() {
    if (disposed) return;
    stop();
    disposed = true;
    documentRef.removeEventListener("visibilitychange", onVisibilityChange);
  }

  documentRef.addEventListener("visibilitychange", onVisibilityChange);

  return {
    start,
    stop,
    suspend,
    resume,
    dispose,
    get isRunning() {
      return rendering;
    }
  };
}

export function handleRenderPageHide({ event, lifecycle, onFinalUnload }) {
  if (event.persisted) {
    lifecycle?.suspend();
    return;
  }
  onFinalUnload();
  lifecycle?.dispose();
}

export function handleRenderPageShow({ event, lifecycle }) {
  if (event.persisted) lifecycle?.resume();
}
