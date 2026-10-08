// Street-level viewer. Two backends behind one interface:
//  - Mapillary images (numeric ids)        → MapillaryJS
//  - Panoramax images ("px-<uuid>" ids)    → Photo Sphere Viewer for 360°
//                                             photos, a plain zoomable image
//                                             for flat ones
// Each backend is created once and reused every round, so switching rounds
// never re-initialises WebGL.
import { CONFIG } from "./config.js";

const PX_ITEM = (id) => `https://api.panoramax.xyz/api/search?ids=${encodeURIComponent(id)}`;
const PSV_CSS = "https://cdn.jsdelivr.net/npm/@photo-sphere-viewer/core@5.15.1/index.css";
const MLY_VERSION = "4.1.2";

let root = null;          // the #pano element the layers live in
let layers = null;        // { mly, psv, flat, nav, credit }
let startImageId = null;
let allowMoveNow = true;
let renderToken = 0;      // bumps on every image change so stale loads are ignored

// ---------------------------------------------------------------- layers
function ensureLayers(container) {
  if (root === container && layers) return layers;
  destroyViewer();
  root = container;
  container.innerHTML = `
    <div class="pano-layer layer-mly" hidden></div>
    <div class="pano-layer layer-psv" hidden></div>
    <div class="pano-layer layer-flat" hidden><img alt="Street photo" draggable="false" /></div>
    <div class="px-nav" hidden>
      <button type="button" class="px-step" data-step="prev" aria-label="Step back along the street">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button type="button" class="px-step" data-step="next" aria-label="Step forward along the street">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <p class="px-credit" hidden>Photo: <a href="https://panoramax.fr" target="_blank" rel="noopener">Panoramax</a> contributors, CC BY-SA</p>`;
  layers = {
    mly: container.querySelector(".layer-mly"),
    psv: container.querySelector(".layer-psv"),
    flat: container.querySelector(".layer-flat"),
    nav: container.querySelector(".px-nav"),
    credit: container.querySelector(".px-credit"),
  };
  layers.nav.addEventListener("click", (e) => {
    const b = e.target.closest("[data-step]");
    if (b && !b.disabled) stepPanoramax(b.dataset.step);
  });
  setupFlatZoom(layers.flat);
  return layers;
}

function show(which) {
  for (const k of ["mly", "psv", "flat"]) layers[k].hidden = k !== which;
  const px = which !== "mly";
  layers.credit.hidden = !px;
  layers.nav.hidden = !px || !allowMoveNow;
}

// ---------------------------------------------------------------- Mapillary
let mlyLib = null;
let mly = null;

function loadMapillary() {
  if (window.mapillary) return Promise.resolve(window.mapillary);
  if (mlyLib) return mlyLib;
  mlyLib = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `https://unpkg.com/mapillary-js@${MLY_VERSION}/dist/mapillary.css`;
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = `https://unpkg.com/mapillary-js@${MLY_VERSION}/dist/mapillary.js`;
    s.async = true;
    s.onload = () => resolve(window.mapillary);
    s.onerror = () => { mlyLib = null; reject(new Error("Couldn't load the street viewer.")); };
    document.head.appendChild(s);
  });
  return mlyLib;
}

function setMlyMovement(allowMove) {
  for (const name of ["direction", "sequence", "keyboard"]) {
    try {
      if (allowMove) mly.activateComponent(name);
      else mly.deactivateComponent(name);
    } catch { /* component not present in this build */ }
  }
}

// Mapillary's photos are served from Facebook's image servers (fbcdn.net),
// which many school and office networks block. Check one small photo first
// so players get a clear explanation instead of an endless spinner.
const BLOCKED_MSG = "This round uses a Mapillary photo, and Mapillary photos can't load on this network (they come from Facebook's servers, which it blocks). Ask the host to set Street photos to Panoramax, or switch to another Wi-Fi.";
let mlyPhotosOk = null;

async function checkMapillaryPhotos(imageId) {
  if (mlyPhotosOk !== null) return mlyPhotosOk;
  try {
    const r = await fetch(`https://graph.mapillary.com/${encodeURIComponent(imageId)}?fields=thumb_256_url&access_token=${encodeURIComponent(CONFIG.MAPILLARY_TOKEN)}`);
    const url = r.ok ? (await r.json()).thumb_256_url : null;
    if (!url) return true; // can't tell; let the viewer try
    mlyPhotosOk = await loadsImage(url, 10000);
  } catch {
    mlyPhotosOk = false; // Mapillary itself is unreachable from here
  }
  return mlyPhotosOk;
}

async function showMapillary(imageId, token) {
  const [lib, ok] = await Promise.all([loadMapillary(), checkMapillaryPhotos(imageId)]);
  if (!ok) throw new Error(BLOCKED_MSG);
  if (token !== renderToken) return;
  show("mly");
  if (!mly) {
    mly = new lib.Viewer({
      accessToken: CONFIG.MAPILLARY_TOKEN,
      container: layers.mly,
      imageId,
      component: { cover: false, bearing: true, zoom: true },
      trackResize: true,
    });
    setMlyMovement(allowMoveNow);
    await new Promise((resolve, reject) => {
      const done = () => { mly.off("image", done); resolve(); };
      mly.on("image", done);
      setTimeout(() => reject(new Error("The street view took too long to load.")), 20000);
    });
    return;
  }
  setMlyMovement(allowMoveNow);
  mly.resize();
  await mly.moveTo(imageId);
}

// ---------------------------------------------------------------- Panoramax
let psvLib = null;
let psv = null;
let pxCurrent = null; // { id, item }
const pxItems = new Map();

function loadPsv() {
  if (psvLib) return psvLib;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = PSV_CSS;
  document.head.appendChild(css);
  psvLib = import("@photo-sphere-viewer/core").catch((e) => {
    psvLib = null;
    throw new Error("Couldn't load the 360° viewer.");
  });
  return psvLib;
}

async function pxItem(id) {
  if (pxItems.has(id)) return pxItems.get(id);
  const p = fetch(PX_ITEM(id))
    .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
    .then((j) => {
      const f = j.features?.[0];
      if (!f) throw new Error();
      return f;
    })
    .catch(() => {
      pxItems.delete(id);
      throw new Error("Couldn't reach Panoramax to load this photo. Check your connection and try again.");
    });
  pxItems.set(id, p);
  return p;
}

const is360 = (item) => Number(item.properties?.["pers:interior_orientation"]?.field_of_view) >= 359;
const linkId = (item, rel) => item.links?.find((l) => l.rel === rel)?.href?.split("/items/")[1]?.split(/[/?]/)[0] || null;
const bigScreen = () => Math.min(screen.width, screen.height) * (window.devicePixelRatio || 1) >= 900;

async function showPanoramax(id, token, { keepView = false } = {}) {
  const item = await pxItem(id);
  if (token !== renderToken) return;
  pxCurrent = { id, item };
  const sd = item.assets?.sd?.href;
  const hd = item.assets?.hd?.href;
  if (!sd && !hd) throw new Error("That Panoramax photo is missing its image.");

  if (is360(item)) {
    const { Viewer } = await loadPsv();
    if (token !== renderToken) return;
    show("psv");
    if (!psv) {
      psv = new Viewer({
        container: layers.psv,
        navbar: false,
        loadingTxt: "",
        defaultZoomLvl: 20,
        minFov: 25,
        maxFov: 100,
        touchmoveTwoFingers: false,
        mousewheelCtrlKey: false,
        keyboard: "always",
      });
    }
    const view = keepView ? { position: psv.getPosition(), zoom: psv.getZoomLevel() } : { position: { yaw: 0, pitch: 0 }, zoom: 20 };
    try {
      await psv.setPanorama(sd || hd, { transition: false, showLoader: true, ...view });
    } catch {
      throw new Error("Couldn't load this Panoramax photo. Check your connection and try again.");
    }
    // Sharpen in the background once the quick version is up.
    // Download it first and only swap if the player is still on this photo,
    // so a slow download can never overwrite a newer image.
    if (hd && sd && bigScreen()) {
      loadsImage(hd, 30000).then((ok) => {
        if (!ok || token !== renderToken || !psv) return;
        psv.setPanorama(hd, { transition: false, showLoader: false, position: psv.getPosition(), zoom: psv.getZoomLevel() }).catch(() => {});
      });
    }
  } else {
    const img = layers.flat.querySelector("img");
    const src = (bigScreen() && hd) || sd || hd;
    if (!(await loadsImage(src, 20000))) throw new Error("Couldn't load this Panoramax photo. Check your connection and try again.");
    if (token !== renderToken) return;
    show("flat");
    img.src = src;
    if (!keepView) resetFlatZoom(layers.flat);
  }
  updateNav();
}

function updateNav() {
  if (!pxCurrent) return;
  for (const b of layers.nav.querySelectorAll("[data-step]")) {
    b.disabled = !linkId(pxCurrent.item, b.dataset.step);
  }
  // Warm the cache for the neighbours so stepping feels instant.
  for (const rel of ["next", "prev"]) {
    const n = linkId(pxCurrent.item, rel);
    if (n) pxItem(n).catch(() => {});
  }
}

async function stepPanoramax(rel) {
  if (!pxCurrent || !allowMoveNow) return;
  const nextId = linkId(pxCurrent.item, rel);
  if (!nextId) return;
  const token = ++renderToken;
  for (const b of layers.nav.querySelectorAll("button")) b.disabled = true;
  try {
    await showPanoramax(nextId, token, { keepView: true });
  } catch {
    if (token === renderToken) updateNav();
  }
}

// Flat (non-360) photos: wheel / pinch-free zoom and drag to pan.
function setupFlatZoom(el) {
  const img = el.querySelector("img");
  let s = 1, x = 0, y = 0, drag = null;
  const apply = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${s})`; };
  el._reset = () => { s = 1; x = 0; y = 0; apply(); };
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    s = Math.min(5, Math.max(1, s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (s === 1) { x = 0; y = 0; }
    apply();
  }, { passive: false });
  el.addEventListener("pointerdown", (e) => { if (s > 1) { drag = { px: e.clientX - x, py: e.clientY - y }; el.setPointerCapture(e.pointerId); } });
  el.addEventListener("pointermove", (e) => { if (drag) { x = e.clientX - drag.px; y = e.clientY - drag.py; apply(); } });
  el.addEventListener("pointerup", () => { drag = null; });
  el.addEventListener("dblclick", () => { s = s > 1 ? 1 : 2.5; if (s === 1) { x = 0; y = 0; } apply(); });
}
const resetFlatZoom = (el) => el._reset?.();

// ---------------------------------------------------------------- helpers
function loadsImage(url, ms) {
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve(false), ms);
    img.onload = () => { clearTimeout(t); resolve(true); };
    img.onerror = () => { clearTimeout(t); resolve(false); };
    img.src = url;
  });
}

// ---------------------------------------------------------------- public API
// Start downloading the viewers early (e.g. while in a lobby).
export const preloadViewer = () => Promise.allSettled([loadMapillary(), loadPsv()]);

export async function showPano(container, imageId, { allowMove = true } = {}) {
  ensureLayers(container);
  allowMoveNow = allowMove;
  startImageId = imageId;
  const token = ++renderToken;
  if (imageId.startsWith("px-")) return showPanoramax(imageId.slice(3), token);
  return showMapillary(imageId, token);
}

export function backToStart() {
  if (!startImageId || !layers) return;
  if (startImageId.startsWith("px-")) {
    const token = ++renderToken;
    showPanoramax(startImageId.slice(3), token).catch(() => {});
  } else if (mly) {
    mly.moveTo(startImageId).catch(() => {});
  }
}

export function resizeViewer() {
  try { mly?.resize(); } catch { /* ignore */ }
  try { psv?.autoSize(); } catch { /* ignore */ }
}

export function destroyViewer() {
  try { mly?.remove(); } catch { /* ignore */ }
  try { psv?.destroy(); } catch { /* ignore */ }
  mly = null;
  psv = null;
  pxCurrent = null;
  layers = null;
  root = null;
}
