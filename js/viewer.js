// Street-level viewer (MapillaryJS). One viewer is created and reused for
// every round so switching rounds never re-initialises WebGL.
import { CONFIG } from "./config.js";

const VERSION = "4.1.2";
let libPromise = null;
let viewer = null;
let startImageId = null;

function loadLib() {
  if (window.mapillary) return Promise.resolve(window.mapillary);
  if (libPromise) return libPromise;
  libPromise = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `https://unpkg.com/mapillary-js@${VERSION}/dist/mapillary.css`;
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = `https://unpkg.com/mapillary-js@${VERSION}/dist/mapillary.js`;
    s.async = true;
    s.onload = () => resolve(window.mapillary);
    s.onerror = () => { libPromise = null; reject(new Error("Couldn't load the street viewer.")); };
    document.head.appendChild(s);
  });
  return libPromise;
}

// Start downloading the viewer early (e.g. while in a lobby).
export const preloadViewer = () => loadLib().catch(() => {});

function setMovement(allowMove) {
  for (const name of ["direction", "sequence", "keyboard"]) {
    try {
      if (allowMove) viewer.activateComponent(name);
      else viewer.deactivateComponent(name);
    } catch { /* component not present in this build */ }
  }
}

export async function showPano(container, imageId, { allowMove = true } = {}) {
  const mapillary = await loadLib();
  startImageId = imageId;
  if (!viewer || viewer.getContainer() !== container) {
    viewer?.remove();
    viewer = new mapillary.Viewer({
      accessToken: CONFIG.MAPILLARY_TOKEN,
      container,
      imageId,
      component: { cover: false, bearing: true, zoom: true },
      trackResize: true,
    });
    setMovement(allowMove);
    await new Promise((resolve, reject) => {
      const done = () => { viewer.off("image", done); resolve(); };
      viewer.on("image", done);
      setTimeout(() => reject(new Error("The street view took too long to load.")), 20000);
    });
    return;
  }
  setMovement(allowMove);
  await viewer.moveTo(imageId);
}

export function backToStart() {
  if (viewer && startImageId) viewer.moveTo(startImageId).catch(() => {});
}

export function resizeViewer() {
  try { viewer?.resize(); } catch { /* ignore */ }
}

export function destroyViewer() {
  try { viewer?.remove(); } catch { /* ignore */ }
  viewer = null;
}
