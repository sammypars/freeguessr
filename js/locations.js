// Picks random street-level imagery.
//
// Two free sources:
//  - Mapillary: the most places, but its photos live on Facebook's servers
//    (fbcdn.net), which school and office networks often block.
//  - Panoramax: open 360° imagery hosted by OpenStreetMap groups. Thinner
//    coverage (strongest in France and the rest of Europe), but it loads on
//    networks that block Facebook.
// "Automatic" uses Mapillary when this browser can load its photos and
// Panoramax when it can't. Image ids from Panoramax are stored as "px-<uuid>".
//
// Strategy: choose a random area (weighted toward places each source covers
// well), ask the source for 360° images inside it, and pick one. Several areas
// are tried in parallel so a round is usually ready in about a second.
import { CONFIG } from "./config.js";

// [lat, lng, jitter in degrees]
const SEEDS = [
  // North America
  [47.61,-122.33,.3],[45.52,-122.68,.3],[44.05,-123.09,.3],[37.77,-122.42,.25],[34.05,-118.24,.4],[32.72,-117.16,.25],
  [36.17,-115.14,.2],[33.45,-112.07,.3],[39.74,-104.99,.3],[40.76,-111.89,.25],[35.08,-106.65,.2],[29.76,-95.37,.4],
  [32.78,-96.8,.4],[30.27,-97.74,.3],[29.95,-90.07,.2],[41.88,-87.63,.35],[44.98,-93.27,.3],[39.1,-94.58,.3],
  [38.63,-90.2,.3],[42.33,-83.05,.3],[39.96,-83,.25],[40.44,-79.99,.25],[39.95,-75.17,.3],[40.71,-74.01,.3],
  [42.36,-71.06,.3],[38.9,-77.04,.3],[35.23,-80.84,.3],[33.75,-84.39,.35],[36.16,-86.78,.3],[25.76,-80.19,.3],
  [28.54,-81.38,.3],[27.95,-82.46,.25],[43.65,-79.38,.35],[45.5,-73.57,.3],[46.81,-71.21,.2],[49.28,-123.12,.3],
  [51.05,-114.07,.3],[53.55,-113.49,.25],[49.9,-97.14,.2],[44.65,-63.58,.2],[61.22,-149.9,.15],[21.31,-157.86,.15],
  [19.43,-99.13,.35],[20.67,-103.35,.3],[25.69,-100.32,.3],[21.16,-86.85,.2],[9.93,-84.08,.2],[8.98,-79.52,.15],
  [14.63,-90.51,.15],[18.47,-69.89,.15],[18.0,-76.8,.15],
  // South America
  [-23.55,-46.63,.4],[-22.91,-43.17,.3],[-15.79,-47.88,.25],[-19.92,-43.94,.25],[-25.43,-49.27,.25],[-30.03,-51.23,.25],
  [-12.97,-38.5,.2],[-8.05,-34.88,.2],[-3.73,-38.53,.2],[-34.6,-58.38,.35],[-31.42,-64.18,.25],[-32.89,-68.84,.2],
  [-33.45,-70.67,.3],[-36.83,-73.05,.2],[-12.05,-77.04,.3],[-0.18,-78.47,.2],[4.71,-74.07,.3],[6.24,-75.58,.2],
  [10.48,-66.9,.15],[-34.9,-56.16,.2],[-25.26,-57.58,.15],[-16.5,-68.15,.15],
  // Europe
  [51.51,-0.13,.35],[53.48,-2.24,.3],[52.49,-1.89,.3],[55.95,-3.19,.25],[55.86,-4.25,.25],[51.45,-2.59,.25],
  [53.35,-6.26,.3],[54.6,-5.93,.2],[48.86,2.35,.35],[45.76,4.84,.3],[43.3,5.37,.25],[43.6,1.44,.25],[44.84,-0.58,.25],
  [47.22,-1.55,.25],[50.63,3.06,.25],[48.58,7.75,.2],[43.7,7.27,.2],[50.85,4.35,.25],[51.22,4.4,.2],[52.37,4.9,.25],
  [51.92,4.48,.25],[52.09,5.12,.2],[49.61,6.13,.15],[52.52,13.4,.35],[53.55,9.99,.3],[48.14,11.58,.3],[50.94,6.96,.3],
  [50.11,8.68,.3],[48.78,9.18,.25],[51.34,12.37,.25],[51.05,13.74,.25],[47.37,8.54,.25],[46.95,7.45,.2],[46.2,6.14,.2],
  [48.21,16.37,.3],[47.07,15.44,.2],[50.08,14.44,.3],[49.2,16.61,.2],[52.23,21.01,.3],[50.06,19.94,.25],[51.11,17.03,.25],
  [54.35,18.65,.2],[47.5,19.04,.3],[48.15,17.11,.2],[46.06,14.51,.2],[45.81,15.98,.2],[44.79,20.45,.25],[42.7,23.32,.25],
  [44.43,26.1,.3],[46.77,23.6,.2],[41.9,12.5,.3],[45.46,9.19,.3],[45.07,7.69,.25],[45.44,12.32,.2],[43.77,11.26,.25],
  [44.49,11.34,.2],[40.85,14.27,.25],[38.12,13.36,.2],[40.42,-3.7,.35],[41.39,2.17,.3],[39.47,-0.38,.25],[37.39,-5.98,.25],
  [43.26,-2.93,.2],[36.72,-4.42,.2],[38.72,-9.14,.25],[41.15,-8.61,.25],[37.98,23.73,.3],[40.64,22.94,.2],[35.34,25.13,.2],
  [55.68,12.57,.3],[57.71,11.97,.25],[59.33,18.07,.3],[59.91,10.75,.3],[60.39,5.32,.2],[60.17,24.94,.3],[61.5,23.76,.2],
  [64.15,-21.94,.15],[59.44,24.75,.2],[56.95,24.11,.2],[54.69,25.28,.2],[50.45,30.52,.3],[49.84,24.03,.2],[46.48,30.73,.2],
  [47.02,28.84,.15],[41.33,19.82,.15],[42.44,19.26,.15],[43.86,18.41,.15],[41.0,28.98,.35],[39.93,32.86,.25],[38.42,27.14,.25],
  [35.17,33.36,.15],[55.76,37.62,.35],[59.94,30.31,.3],
  // Africa & Middle East
  [-33.92,18.42,.3],[-26.2,28.05,.35],[-25.75,28.19,.25],[-29.86,31.02,.25],[-33.96,25.6,.2],[-1.29,36.82,.25],[-6.79,39.21,.2],
  [0.35,32.58,.2],[-1.95,30.06,.15],[5.6,-0.19,.2],[6.52,3.38,.3],[9.06,7.5,.2],[14.69,-17.44,.2],[5.36,-4.01,.2],
  [33.57,-7.59,.25],[34.02,-6.84,.2],[31.63,-8.01,.2],[36.81,10.18,.2],[30.04,31.24,.3],[-18.88,47.51,.15],[-17.83,31.05,.15],
  [-24.65,25.91,.15],[-22.56,17.08,.15],[-20.16,57.5,.15],[31.77,35.21,.15],[32.08,34.78,.2],[31.95,35.93,.15],[33.89,35.5,.15],
  [25.2,55.27,.3],[24.47,54.37,.2],[25.29,51.53,.2],[26.23,50.59,.15],[24.71,46.68,.3],[21.49,39.19,.25],[41.72,44.79,.15],
  [40.18,44.51,.15],[40.41,49.87,.15],
  // Asia
  [35.68,139.69,.35],[34.69,135.5,.3],[35.01,135.77,.25],[35.18,136.91,.25],[43.06,141.35,.25],[33.59,130.4,.25],[34.39,132.46,.2],
  [26.21,127.68,.15],[37.57,126.98,.35],[35.18,129.08,.25],[35.87,128.6,.2],[25.03,121.57,.3],[22.63,120.3,.25],[24.15,120.67,.2],
  [22.32,114.17,.2],[1.35,103.82,.15],[3.14,101.69,.3],[5.42,100.33,.2],[13.76,100.5,.35],[18.79,98.98,.2],[7.88,98.39,.15],
  [10.82,106.63,.3],[21.03,105.85,.25],[16.05,108.2,.2],[11.56,104.92,.2],[14.6,120.98,.3],[10.32,123.89,.2],[-6.21,106.85,.35],
  [-7.25,112.75,.25],[-8.65,115.22,.2],[-6.91,107.61,.2],[28.61,77.21,.35],[19.08,72.88,.3],[12.97,77.59,.3],[13.08,80.27,.3],
  [17.39,78.49,.3],[22.57,88.36,.3],[18.52,73.86,.25],[23.02,72.57,.25],[26.91,75.79,.2],[6.93,79.86,.2],[27.72,85.32,.15],
  [23.81,90.41,.2],[24.86,67.01,.2],[31.55,74.34,.2],[33.69,73.05,.15],[43.24,76.89,.2],[51.17,71.45,.15],[41.31,69.24,.2],
  [47.92,106.92,.15],[42.87,74.6,.15],
  // Oceania
  [-33.87,151.21,.35],[-37.81,144.96,.35],[-27.47,153.03,.3],[-31.95,115.86,.3],[-34.93,138.6,.25],[-35.28,149.13,.2],
  [-42.88,147.33,.2],[-12.46,130.84,.15],[-19.26,146.82,.15],[-28.0,153.43,.2],[-36.85,174.76,.3],[-41.29,174.78,.25],
  [-43.53,172.64,.25],[-45.87,170.5,.2],[-37.79,175.28,.2],[-17.73,168.32,.1],[-18.14,178.44,.1],
];

const MLY_API = "https://graph.mapillary.com/images";
const PX_API = "https://api.panoramax.xyz/api/search";
const rand = (a, b) => a + Math.random() * (b - a);
const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

// ---------------------------------------------------------------- Mapillary
function mapillaryBox() {
  const [lat0, lng0, j] = pickOne(SEEDS);
  const lat = lat0 + rand(-j, j);
  const lng = lng0 + rand(-j, j) / Math.max(0.3, Math.cos((lat * Math.PI) / 180));
  const h = 0.02; // ~2 km box: small enough for Mapillary to answer quickly
  return [lng - h, lat - h, lng + h, lat + h].map((v) => +v.toFixed(5));
}

async function tryMapillary(bbox, panoOnly, signal) {
  const url = new URL(MLY_API);
  url.searchParams.set("access_token", CONFIG.MAPILLARY_TOKEN);
  url.searchParams.set("fields", "id,computed_geometry,geometry,is_pano");
  url.searchParams.set("bbox", bbox.join(","));
  url.searchParams.set("limit", "40");
  if (panoOnly) url.searchParams.set("is_pano", "true");
  const res = await fetch(url, { signal });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error("Mapillary rejected the access token in js/config.js."), { fatal: true });
  if (!res.ok) return null;
  const json = await res.json();
  const list = (json.data || []).filter((d) => (d.computed_geometry || d.geometry)?.coordinates);
  if (!list.length) return null;
  const pick = pickOne(list);
  const [lng, lat] = (pick.computed_geometry || pick.geometry).coordinates;
  return { image_id: String(pick.id), lat, lng };
}

// ---------------------------------------------------------------- Panoramax
// Areas to search, as [minLng, minLat, maxLng, maxLat]: a box around every
// city seed above (so rounds spread around the world), plus a coarse grid
// over Europe, where Panoramax has the most countryside imagery. A random
// sub-box inside each area keeps repeat visits from landing on the same street.
const PX_AREAS = (() => {
  const areas = [];
  for (const [lat, lng] of SEEDS) areas.push([lng - 1.5, lat - 1.2, lng + 1.5, lat + 1.2]);
  for (let lng = -10; lng < 30; lng += 5) for (let lat = 36; lat < 60; lat += 4) areas.push([lng, lat, lng + 5, lat + 4]);
  return areas;
})();
function panoramaxBox() {
  const [x0, y0, x1, y1] = pickOne(PX_AREAS);
  const w = (x1 - x0) * 0.5, h = (y1 - y0) * 0.5;
  const x = rand(x0, x1 - w), y = rand(y0, y1 - h);
  return [x, y, x + w, y + h].map((v) => +v.toFixed(4));
}

async function tryPanoramax(bbox, panoOnly, signal) {
  const url = new URL(PX_API);
  url.searchParams.set("bbox", bbox.join(","));
  url.searchParams.set("limit", "60");
  if (panoOnly) url.searchParams.set("filter", "field_of_view=360");
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const json = await res.json();
  const list = (json.features || []).filter((f) => f.geometry?.coordinates && f.assets?.sd?.href);
  if (!list.length) return null;
  const pick = pickOne(list);
  const [lng, lat] = pick.geometry.coordinates;
  return { image_id: `px-${pick.id}`, lat, lng, preload: pick.assets.sd.href };
}

// ---------------------------------------------------------------- shared
async function search(tryFn, boxFn, { waves = 6, perWave = 4, panoWaves = 4 } = {}) {
  const ctrl = new AbortController();
  try {
    for (let wave = 0; wave < waves; wave++) {
      const panoOnly = wave < panoWaves;
      const attempts = Array.from({ length: perWave }, () =>
        tryFn(boxFn(), panoOnly, ctrl.signal).catch((e) => {
          if (e.fatal) throw e;
          return null;
        }),
      );
      const found = await firstHit(attempts);
      if (found) return found;
    }
    throw new Error("Couldn't find street imagery right now. Check your connection and try again.");
  } finally {
    ctrl.abort();
  }
}

// Resolves with the first non-null result, or null once all are null.
function firstHit(promises) {
  return new Promise((resolve, reject) => {
    let left = promises.length;
    for (const p of promises) {
      p.then((v) => {
        if (v) resolve(v);
        else if (--left === 0) resolve(null);
      }, reject);
    }
  });
}

// ---------------------------------------------------------------- source choice
const SETTING_KEY = "freeguessr.imagery";
export const SOURCES = {
  auto: "Automatic",
  mapillary: "Mapillary (most places)",
  panoramax: "Panoramax (works on school networks)",
};
export function getSourceSetting() {
  try { const v = localStorage.getItem(SETTING_KEY); return SOURCES[v] ? v : "auto"; } catch { return "auto"; }
}
export function setSourceSetting(v) {
  try { localStorage.setItem(SETTING_KEY, v); } catch { /* private mode */ }
  pending = null;
}

// Can this browser load Mapillary's photos? Checked once per page load by
// fetching one small photo.
let mlyReachable = null;
export function mapillaryReachable() {
  if (mlyReachable) return mlyReachable;
  mlyReachable = (async () => {
    // On a normal connection this whole check takes well under a second.
    // Blocking networks tend to hang rather than fail, so give up after 3s.
    const ctrl = new AbortController();
    const giveUp = setTimeout(() => ctrl.abort(), 3000);
    try {
      const url = `${MLY_API}?access_token=${encodeURIComponent(CONFIG.MAPILLARY_TOKEN)}&fields=thumb_256_url&bbox=2.34,48.85,2.36,48.86&limit=1`;
      const res = await fetch(url, { signal: ctrl.signal });
      const thumb = res.ok ? (await res.json()).data?.[0]?.thumb_256_url : null;
      if (!thumb) return false;
      return await new Promise((resolve) => {
        const img = new Image();
        // A 256px photo loads in well under a second on a normal connection;
        // blocked networks tend to hang instead of failing, so don't wait long.
        const t = setTimeout(() => resolve(false), 2500);
        img.onload = () => { clearTimeout(t); resolve(true); };
        img.onerror = () => { clearTimeout(t); resolve(false); };
        img.src = thumb;
      });
    } catch {
      return false;
    } finally {
      clearTimeout(giveUp);
    }
  })();
  return mlyReachable;
}

export async function chosenSource() {
  const s = getSourceSetting();
  if (s !== "auto") return s;
  return (await mapillaryReachable()) ? "mapillary" : "panoramax";
}

// Resolves with { image_id, lat, lng }.
export async function randomLocation(source) {
  source = source || (await chosenSource());
  if (source === "panoramax") return search(tryPanoramax, panoramaxBox, { waves: 6, perWave: 5, panoWaves: 5 });
  return search(tryMapillary, mapillaryBox);
}

// Keeps one location ready in the background so the next round starts instantly.
let pending = null;
export function prefetchLocation() {
  if (pending) return;
  pending = randomLocation()
    .then((loc) => {
      // Warm the browser cache with the photo so the next round opens instantly.
      if (loc?.preload) fetch(loc.preload, { mode: "cors" }).catch(() => {});
      return loc;
    })
    .catch(() => null);
}
export async function nextLocation() {
  const p = pending;
  pending = null;
  const ready = p ? await p : null;
  return ready || randomLocation();
}
