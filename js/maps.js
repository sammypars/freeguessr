// Leaflet maps: the small guess map and the results maps.
/* global L */

const TILE_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

const PLAYER_COLORS = ["#F2B33D", "#4FB0D8", "#B98BE6", "#5FC48C", "#F08AA8", "#E8A06A", "#8FA6F2", "#C9D46A"];
export const colorFor = (i) => PLAYER_COLORS[i % PLAYER_COLORS.length];

function baseMap(el, opts = {}) {
  const map = L.map(el, {
    worldCopyJump: true,
    zoomControl: false,
    attributionControl: true,
    minZoom: 1,
    maxBounds: [[-89, -540], [89, 540]],
    maxBoundsViscosity: 0.6,
    preferCanvas: true,
    ...opts,
  }).setView([22, 8], 1);
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, subdomains: "abcd", maxZoom: 19, detectRetina: true }).addTo(map);
  L.control.zoom({ position: "topleft" }).addTo(map);
  map.attributionControl.setPrefix(false);
  return map;
}

function pinIcon(color, label = "") {
  return L.divIcon({
    className: "pin-icon",
    html: `<svg viewBox="0 0 30 40" width="30" height="40" aria-hidden="true"><path d="M15 1.5C7.5 1.5 2 7 2 14.2c0 9.3 13 24.3 13 24.3s13-15 13-24.3C28 7 22.5 1.5 15 1.5z" fill="${color}" stroke="#10293B" stroke-width="2"/><circle cx="15" cy="14" r="5" fill="#10293B"/></svg>${label ? `<span class="pin-label">${label}</span>` : ""}`,
    iconSize: [30, 40],
    iconAnchor: [15, 39],
  });
}

function flagIcon() {
  return L.divIcon({
    className: "pin-icon",
    html: `<svg viewBox="0 0 32 40" width="32" height="40" aria-hidden="true"><rect x="5" y="3" width="3" height="35" rx="1.5" fill="#10293B"/><path d="M8 4h19l-5 7 5 7H8z" fill="#E5533D" stroke="#10293B" stroke-width="2" stroke-linejoin="round"/></svg>`,
    iconSize: [32, 40],
    iconAnchor: [6, 38],
  });
}

// The guess map. onPick({lat, lng}) fires whenever the pin moves.
export function createGuessMap(el, onPick) {
  const map = baseMap(el);
  let marker = null;
  map.on("click", (e) => {
    const ll = e.latlng.wrap();
    if (!marker) marker = L.marker(e.latlng, { icon: pinIcon("#F2B33D"), keyboard: false }).addTo(map);
    else marker.setLatLng(e.latlng);
    onPick({ lat: ll.lat, lng: ll.lng });
  });
  return {
    map,
    clear() {
      if (marker) { marker.remove(); marker = null; }
      map.setView([22, 8], 1, { animate: false });
    },
    invalidate() { if (map._container?.isConnected && map._loaded) map.invalidateSize({ pan: false }); },
  };
}

// Shift a longitude by ±360 so a line to it takes the short way round.
function nearLng(lng, refLng) {
  while (lng - refLng > 180) lng -= 360;
  while (lng - refLng < -180) lng += 360;
  return lng;
}

// rounds: [{ answer: {lat,lng}, guesses: [{lat,lng,username,colorIndex}] , label }]
export function createResultMap(el, rounds) {
  const map = baseMap(el, { worldCopyJump: false });
  const pts = [];
  for (const r of rounds) {
    const a = [r.answer.lat, r.answer.lng];
    L.marker(a, { icon: flagIcon(), keyboard: false, zIndexOffset: 1000 }).addTo(map);
    pts.push(a);
    for (const g of r.guesses) {
      if (g.lat == null) continue;
      const p = [g.lat, nearLng(g.lng, r.answer.lng)];
      const color = colorFor(g.colorIndex ?? 0);
      L.polyline([a, p], { color: "#10293B", weight: 3, opacity: 0.85, dashArray: "2 7", lineCap: "round" }).addTo(map);
      L.marker(p, { icon: pinIcon(color, r.label ?? ""), keyboard: false, title: g.username }).addTo(map);
      pts.push(p);
    }
  }
  requestAnimationFrame(() => {
    if (!map._container?.isConnected || !map._loaded) return; // removed before first frame
    map.invalidateSize({ pan: false });
    if (pts.length === 1) map.setView(pts[0], 4, { animate: false });
    else if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 14, animate: false });
  });
  return map;
}
