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
let layers = null;        // { mly, psv, flat, arrows, credit }
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
    <div class="px-arrows" hidden><div class="px-ring"></div></div>
    <p class="px-credit" hidden>Photo: <a href="https://panoramax.fr" target="_blank" rel="noopener">Panoramax</a> contributors, CC BY-SA</p>`;
  layers = {
    mly: container.querySelector(".layer-mly"),
    psv: container.querySelector(".layer-psv"),
    flat: container.querySelector(".layer-flat"),
    arrows: container.querySelector(".px-arrows"),
    credit: container.querySelector(".px-credit"),
  };
  layers.arrows.addEventListener("click", (e) => {
    const b = e.target.closest(".px-arrow");
    if (b) stepTo(b.dataset.id);
  });
  setupFlatZoom(layers.flat);
  return layers;
}

function show(which) {
  for (const k of ["mly", "psv", "flat"]) layers[k].hidden = k !== which;
  const px = which !== "mly";
  layers.credit.hidden = !px;
  if (!px) layers.arrows.hidden = true;
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
  const ctrl = new AbortController();
  const giveUp = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`https://graph.mapillary.com/${encodeURIComponent(imageId)}?fields=thumb_256_url&access_token=${encodeURIComponent(CONFIG.MAPILLARY_TOKEN)}`, { signal: ctrl.signal });
    const url = r.ok ? (await r.json()).thumb_256_url : null;
    if (!url) return true; // can't tell; let the viewer try
    mlyPhotosOk = await loadsImage(url, 4000);
  } catch {
    mlyPhotosOk = false; // Mapillary itself is unreachable from here
  } finally {
    clearTimeout(giveUp);
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
// Movement works like Street View: arrows on the ground point to every nearby
// photo you can walk to (along this street and onto crossing streets), the
// view keeps facing the same compass direction after each step, and the
// photos around you load in advance so steps are near-instant.
const PX_NEAR = (lng, lat, d, pano) =>
  `https://api.panoramax.xyz/api/search?bbox=${lng - d},${lat - d * 0.7},${lng + d},${lat + d * 0.7}&limit=50${pano ? "&filter=field_of_view%3D360" : ""}`;
const STEP_FADE = { speed: 350, rotation: false, effect: "fade" };

let psvLib = null;
let psv = null;
let pxCurrent = null;   // { id, item, lat, lng, az, pano }
let pxMoves = [];       // [{ id, bearing, dist }]
let moving = false;
let arrowFrame = 0;
const pxItems = new Map();

function loadPsv() {
  if (psvLib) return psvLib;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = PSV_CSS;
  document.head.appendChild(css);
  psvLib = import("@photo-sphere-viewer/core").catch(() => {
    psvLib = null;
    throw new Error("Couldn't load the 360° viewer.");
  });
  return psvLib;
}

function pxItem(id) {
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
const azimuthOf = (item) => Number(item.properties?.["view:azimuth"]) || 0;
const linkId = (item, rel) => item.links?.find((l) => l.rel === rel)?.href?.split("/items/")[1]?.split(/[/?]/)[0] || null;
const bigScreen = () => Math.min(screen.width, screen.height) * (window.devicePixelRatio || 1) >= 900;
const RAD = Math.PI / 180;
const norm360 = (d) => ((d % 360) + 360) % 360;
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function metersBetween(lat1, lng1, lat2, lng2) {
  const x = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lng2 - lng1) * RAD) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(x)));
}
function bearingTo(lat1, lng1, lat2, lng2) {
  const y = Math.sin((lng2 - lng1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lng2 - lng1) * RAD);
  return norm360(Math.atan2(y, x) / RAD);
}

// Compass direction the player is facing, in degrees.
function viewHeading() {
  if (!pxCurrent) return 0;
  if (pxCurrent.pano && psv) return norm360(pxCurrent.az + psv.getPosition().yaw / RAD);
  return pxCurrent.az;
}

function inPlay() {
  const screen = root?.closest(".game-screen");
  return !screen || screen.dataset.view === "play";
}

async function showPanoramax(id, token, { heading = null } = {}) {
  const item = await pxItem(id);
  if (token !== renderToken) return;
  const sd = item.assets?.sd?.href;
  const hd = item.assets?.hd?.href;
  if (!sd && !hd) throw new Error("That Panoramax photo is missing its image.");
  const [lng, lat] = item.geometry.coordinates;
  const next = { id, item, lat, lng, az: azimuthOf(item), pano: is360(item) };
  const step = heading !== null;

  if (next.pano) {
    const { Viewer, EquirectangularAdapter } = await loadPsv();
    if (token !== renderToken) return;
    show("psv");
    if (!psv) {
      psv = new Viewer({
        container: layers.psv,
        // Ignore pose data embedded in some photos so every photo's centre is
        // its camera heading; that keeps the facing direction steady between steps.
        adapter: EquirectangularAdapter.withConfig({ useXmpData: false }),
        navbar: false,
        loadingTxt: "",
        defaultZoomLvl: 20,
        minFov: 25,
        maxFov: 100,
        touchmoveTwoFingers: false,
        mousewheelCtrlKey: false,
        moveInertia: 0.9,
        keyboard: "always",
        keyboardActions: {
          ArrowLeft: "ROTATE_LEFT", ArrowRight: "ROTATE_RIGHT", a: "ROTATE_LEFT", d: "ROTATE_RIGHT", A: "ROTATE_LEFT", D: "ROTATE_RIGHT",
          PageUp: "ROTATE_UP", PageDown: "ROTATE_DOWN", "+": "ZOOM_IN", "=": "ZOOM_IN", "-": "ZOOM_OUT",
          ArrowUp: () => walk(0), w: () => walk(0), W: () => walk(0),
          ArrowDown: () => walk(180), s: () => walk(180), S: () => walk(180),
        },
      });
      psv.addEventListener("position-updated", scheduleArrows);
      psv.addEventListener("click", ({ data }) => {
        // Clicking the road (below the horizon) walks toward that spot.
        if (!allowMoveNow || data.rightclick || data.pitch > -0.12 || !pxCurrent?.pano) return;
        walkToward(norm360(pxCurrent.az + data.yaw / RAD), 50);
      });
    }
    const pos = step
      ? { position: { yaw: (heading - next.az) * RAD, pitch: psv.getPosition().pitch }, zoom: psv.getZoomLevel() }
      : { position: { yaw: 0, pitch: 0 }, zoom: 20 };
    try {
      await psv.setPanorama(sd || hd, { transition: step && layers.psv.hidden === false ? STEP_FADE : false, showLoader: !step, ...pos });
    } catch {
      throw new Error("Couldn't load this Panoramax photo. Check your connection and try again.");
    }
    if (token !== renderToken) return;
    pxCurrent = next;
    // Sharpen in the background once the quick version is up. Download first
    // and only swap if the player is still on this photo.
    if (hd && sd && bigScreen()) {
      loadsImage(hd, 30000, true).then((ok) => {
        if (!ok || token !== renderToken || !psv || moving) return;
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
    resetFlatZoom(layers.flat);
    pxCurrent = next;
  }
  pxMoves = [];
  renderArrows();
  findMoves(token);
}

// Works out where you can walk from the current photo.
async function findMoves(token) {
  const cur = pxCurrent;
  if (!cur || !allowMoveNow) return;
  const seqIds = ["next", "prev"].map((r) => linkId(cur.item, r)).filter(Boolean);
  const [seq, near] = await Promise.all([
    Promise.all(seqIds.map((id) => pxItem(id).catch(() => null))),
    fetch(PX_NEAR(cur.lng, cur.lat, 0.0006, cur.pano))
      .then((r) => (r.ok ? r.json() : { features: [] }))
      .then((j) => j.features || [])
      .catch(() => []),
  ]);
  if (token !== renderToken) return;

  const seen = new Set([cur.id]);
  const cands = [];
  const add = (f, fromSequence) => {
    if (!f || seen.has(f.id) || !f.geometry?.coordinates || !(f.assets?.sd || f.assets?.hd)) return;
    seen.add(f.id);
    if (!pxItems.has(f.id)) pxItems.set(f.id, Promise.resolve(f));
    const [lng, lat] = f.geometry.coordinates;
    const dist = metersBetween(cur.lat, cur.lng, lat, lng);
    if (dist < 1.5 || dist > (fromSequence ? 150 : 45)) return;
    cands.push({ id: f.id, f, dist, bearing: bearingTo(cur.lat, cur.lng, lat, lng), seq: fromSequence });
  };
  seq.forEach((f) => add(f, true));
  near.forEach((f) => add(f, false));

  // One arrow per direction: the nearest photo wins, the same street is preferred.
  cands.sort((a, b) => a.dist * (a.seq ? 0.6 : 1) - b.dist * (b.seq ? 0.6 : 1));
  const moves = [];
  for (const c of cands) {
    if (moves.length >= 6) break;
    if (moves.every((m) => angleDiff(m.bearing, c.bearing) >= 35)) moves.push(c);
  }
  pxMoves = moves;
  renderArrows();
  // Load the closest few photos now so stepping is instant.
  for (const m of moves.slice(0, 4)) {
    const url = m.f.assets.sd?.href || m.f.assets.hd?.href;
    if (url) fetch(url, { mode: "cors" }).catch(() => {});
  }
}

// Walk toward a compass heading (relative=true: relative to where you face).
function walk(relative) {
  walkToward(norm360(viewHeading() + relative), 70);
}
function walkToward(heading, tolerance) {
  if (!pxMoves.length) return;
  let best = null;
  for (const m of pxMoves) {
    const d = angleDiff(m.bearing, heading);
    if (d <= tolerance && (!best || d < best.d || (d === best.d && m.dist < best.m.dist))) best = { m, d };
  }
  if (best) stepTo(best.m.id);
}

async function stepTo(id, { heading = viewHeading() } = {}) {
  if (!allowMoveNow || moving || !inPlay()) return;
  moving = true;
  layers.arrows.classList.add("busy");
  const token = ++renderToken;
  try {
    await showPanoramax(id, token, { heading });
  } catch {
    /* keep the current photo */
  } finally {
    moving = false;
    layers.arrows.classList.remove("busy");
  }
}

function scheduleArrows() {
  if (arrowFrame) return;
  arrowFrame = requestAnimationFrame(() => { arrowFrame = 0; renderArrows(); });
}

function renderArrows() {
  if (!layers) return;
  const ring = layers.arrows;
  const photoShown = !layers.psv.hidden || !layers.flat.hidden;
  const showIt = Boolean(allowMoveNow && pxCurrent && pxMoves.length && photoShown);
  ring.hidden = !showIt;
  if (!showIt) return;
  const h = viewHeading();
  const wanted = pxMoves.map((m) => m.id).join(",");
  if (ring.dataset.ids !== wanted) {
    ring.dataset.ids = wanted;
    ring.querySelector(".px-ring").innerHTML = pxMoves.map((m) => `
      <button type="button" class="px-arrow" data-id="${m.id}" aria-label="Walk ${Math.round(m.dist)} metres this way">
        <svg viewBox="0 0 40 40" aria-hidden="true"><path d="M8 27 L20 13 L32 27" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`).join("");
  }
  for (const b of ring.querySelectorAll(".px-arrow")) {
    const m = pxMoves.find((x) => x.id === b.dataset.id);
    const rel = ((m.bearing - h + 540) % 360) - 180; // -180..180, 0 = straight ahead
    b.style.transform = `translate(-50%, -50%) rotate(${rel}deg) translateY(-104px)`;
    b.classList.toggle("ahead", Math.abs(rel) < 35);
  }
}

// Flat (non-360) photos: wheel zoom, drag to pan, double-click to zoom.
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
function loadsImage(url, ms, cors = false) {
  return new Promise((resolve) => {
    const img = new Image();
    if (cors) img.crossOrigin = "anonymous";
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
  pxMoves = [];
  moving = false;
  if (imageId.startsWith("px-")) return showPanoramax(imageId.slice(3), token);
  return showMapillary(imageId, token);
}

export function backToStart() {
  if (!startImageId || !layers) return;
  if (startImageId.startsWith("px-")) {
    if (moving) return;
    const token = ++renderToken;
    moving = true;
    showPanoramax(startImageId.slice(3), token).catch(() => {}).finally(() => { moving = false; });
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
  pxMoves = [];
  layers = null;
  root = null;
}
