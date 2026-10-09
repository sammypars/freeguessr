// App shell: accounts, routing, home and daily screens.
import { CONFIG, isConfigured } from "./config.js";
import { $, $$, esc, el, fmtScore, toast, openModal, closeModal, setBusy, friendlyError } from "./ui.js";
import { SOURCES, getSourceSetting, setSourceSetting, randomLocation, mapillaryReachable } from "./locations.js";

const app = $("#app");
let api = null, USERNAME_RE = null;
let session = null;
let profile = null;
let teardown = null;

// ---------------------------------------------------------------- accounts
const user = () => session?.user || null;

async function loadProfile() {
  profile = user() ? await api.profile(user().id).catch(() => null) : null;
  renderAccount();
}

function renderAccount() {
  const box = $("#account");
  if (!api) { box.innerHTML = ""; return; }
  box.innerHTML = user()
    ? `<button class="account-btn" id="account-btn"><span class="avatar">${esc((profile?.username || "?")[0].toUpperCase())}</span><span class="account-name">${esc(profile?.username || "Account")}</span></button>`
    : `<button class="btn btn-small btn-flag" id="login-btn">Log in</button>`;
  $("#login-btn")?.addEventListener("click", () => openAuth());
  $("#account-btn")?.addEventListener("click", openAccount);
}

function openAuth({ mode = "login", then } = {}) {
  const modal = openModal(`
    <div class="auth">
      <div class="tabs" role="tablist">
        <button role="tab" class="tab" data-tab="login">Log in</button>
        <button role="tab" class="tab" data-tab="signup">Create account</button>
      </div>
      <form id="auth-form" novalidate>
        <label>Username
          <input name="username" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="20" required />
        </label>
        <p class="hint" id="user-hint" hidden>3–20 letters, numbers or underscores. This is the name other players see.</p>
        <label>Password
          <input name="password" type="password" autocomplete="current-password" minlength="6" required />
        </label>
        <p class="hint" id="pass-hint" hidden>At least 6 characters.</p>
        <p class="form-error" id="auth-error" role="alert" hidden></p>
        <button class="btn btn-flag btn-block" id="auth-submit" type="submit">Log in</button>
      </form>
    </div>`);
  const form = $("#auth-form", modal);
  const submit = $("#auth-submit", modal);
  const errBox = $("#auth-error", modal);
  const setMode = (m) => {
    mode = m;
    $$(".tab", modal).forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === m)));
    submit.textContent = m === "login" ? "Log in" : "Create account";
    $("#user-hint", modal).hidden = $("#pass-hint", modal).hidden = m === "login";
    form.password.autocomplete = m === "login" ? "current-password" : "new-password";
    errBox.hidden = true;
  };
  $$(".tab", modal).forEach((t) => t.addEventListener("click", () => setMode(t.dataset.tab)));
  setMode(mode);
  form.username.focus();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.hidden = true;
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) {
      errBox.textContent = "Enter a username and password.";
      errBox.hidden = false;
      return;
    }
    if (mode === "signup" && !USERNAME_RE.test(username)) {
      errBox.textContent = "Usernames are 3–20 letters, numbers or underscores.";
      errBox.hidden = false;
      return;
    }
    setBusy(submit, true, mode === "login" ? "Logging in…" : "Creating account…");
    try {
      session = mode === "login" ? await api.logIn(username, password) : await api.signUp(username, password);
      await loadProfile();
      closeModal();
      toast(mode === "login" ? `Welcome back, ${profile?.username || username}` : `Account created. Welcome, ${profile?.username || username}`);
      then?.();
    } catch (err) {
      errBox.textContent = friendlyError(err);
      errBox.hidden = false;
      setBusy(submit, false);
    }
  });
}

function requireAuth(then) {
  if (user()) return then();
  openAuth({ then });
}

async function openAccount() {
  if (user()) profile = (await api.profile(user().id).catch(() => null)) || profile;
  const p = profile || {};
  const modal = openModal(`
    <h2>${esc(p.username || "Your account")}</h2>
    <dl class="stats">
      <div><dt>Games finished</dt><dd>${fmtScore(p.games_played)}</dd></div>
      <div><dt>Best 5-round score</dt><dd>${fmtScore(p.best_score)}</dd></div>
      <div><dt>Duel record</dt><dd>${fmtScore(p.duel_wins)}–${fmtScore(p.duel_losses)}</dd></div>
    </dl>
    <button class="btn btn-ghost btn-block" id="logout">Log out</button>`);
  $("#logout", modal).onclick = async () => {
    await api.logOut();
    session = null;
    profile = null;
    closeModal();
    renderAccount();
    toast("Logged out");
    location.hash = "#/";
    route();
  };
}

// ---------------------------------------------------------------- home
function contourSvg() {
  // Topographic rings around a few "summits". Generated once, drawn as static SVG.
  const peaks = [[0.78, 0.32, 1], [0.95, 0.85, 0.75], [0.12, 0.92, 0.6]];
  const W = 1200, H = 800;
  let paths = "";
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [px, py, scale] of peaks) {
    const phase = [rnd() * 6, rnd() * 6, rnd() * 6];
    for (let k = 1; k <= 14; k++) {
      const r0 = k * 34 * scale;
      let d = "";
      for (let i = 0; i <= 96; i++) {
        const t = (i / 96) * Math.PI * 2;
        const wob = 1 + 0.16 * Math.sin(3 * t + phase[0] + k * 0.15) + 0.09 * Math.sin(5 * t + phase[1]) + 0.05 * Math.sin(9 * t + phase[2] + k * 0.3);
        const x = px * W + Math.cos(t) * r0 * wob * 1.25;
        const y = py * H + Math.sin(t) * r0 * wob;
        d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      paths += `<path d="${d}Z" class="${k % 5 === 0 ? "index" : ""}"/>`;
    }
  }
  return `<svg class="contours" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g>${paths}</g></svg>`;
}

const MODES = [
  { id: "solo", name: "Solo", sym: `<circle cx="16" cy="16" r="7" fill="currentColor"/>`,
    desc: "Five places, your pace. Set a timer if you want pressure.", cta: "Play solo" },
  { id: "party", name: "Party room", sym: `<circle cx="9" cy="12" r="5" fill="currentColor"/><circle cx="23" cy="12" r="5" fill="currentColor"/><circle cx="16" cy="23" r="5" fill="currentColor"/>`,
    desc: "Up to 16 friends guess the same places at once. Send them the room code.", cta: "Create a room" },
  { id: "duel", name: "Duel", sym: `<path d="M5 27L27 5M5 5l22 22" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>`,
    desc: "One opponent, 6,000 health each. The farther guess takes the damage.", cta: "Start a duel" },
  { id: "daily", name: "Daily challenge", sym: `<circle cx="16" cy="16" r="6" fill="currentColor"/><path d="M16 2v5M16 25v5M2 16h5M25 16h5M6 6l3.5 3.5M22.5 22.5L26 26M26 6l-3.5 3.5M9.5 22.5L6 26" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>`,
    desc: "The same five places for everyone today. One try, one leaderboard.", cta: "Play today's" },
];

async function renderHome() {
  document.body.className = "page-home";
  app.innerHTML = `
    <section class="hero">
      ${contourSvg()}
      <div class="hero-inner">
        <div class="hero-copy">
          <h1>Where on Earth<br/>are you?</h1>
          <p class="lede">You're dropped on a real street somewhere in the world. Look around, read the signs, then put a pin on the map. The closer you are, the more points you get.</p>
        </div>
        <div class="legend" role="list" aria-label="Ways to play">
          ${MODES.map((m) => `
            <div class="legend-row" role="listitem">
              <svg class="legend-sym sym-${m.id}" viewBox="0 0 32 32" aria-hidden="true">${m.sym}</svg>
              <div class="legend-text"><h2>${m.name}</h2><p>${m.desc}</p></div>
              <button class="btn ${m.id === "solo" ? "btn-flag" : "btn-ghost"}" data-mode="${m.id}">${m.cta}</button>
            </div>`).join("")}
          <form class="join" id="join-form">
            <label for="join-code">Got a room code?</label>
            <div class="join-row">
              <input id="join-code" name="code" placeholder="ABC123" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" />
              <button class="btn btn-ghost" type="submit">Join</button>
            </div>
          </form>
          <div id="active-games"></div>
          <p class="check-link"><a href="#/check">Street view not loading? Run a connection check</a></p>
        </div>
      </div>
    </section>`;

  $$("[data-mode]", app).forEach((b) => b.addEventListener("click", () => startMode(b.dataset.mode, b)));
  $("#join-form", app).addEventListener("submit", (e) => {
    e.preventDefault();
    const code = e.target.code.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return toast("Room codes are 6 letters and numbers.", "error");
    location.hash = `#/join/${code}`;
  });
  if (user()) renderActiveGames();
}

async function renderActiveGames() {
  try {
    const games = await api.rpc("my_active_games");
    const box = $("#active-games", app);
    if (!box || !games?.length) return;
    box.innerHTML = `<h3 class="active-title">Games in progress</h3><ul class="active-list">${games.map((g) => `
      <li><a href="#/g/${g.id}"><span>${esc({ solo: "Solo", party: "Party room", duel: "Duel" }[g.mode])}${g.code ? ` ${esc(g.code)}` : ""}</span>
      <span class="muted">${g.status === "lobby" ? "In lobby" : `Round ${g.current_round}${g.mode === "duel" ? "" : ` of ${g.total_rounds}`}`}</span></a></li>`).join("")}</ul>`;
  } catch { /* not important */ }
}

function startMode(mode, btn) {
  if (mode === "daily") { location.hash = "#/daily"; return; }
  requireAuth(async () => {
    if (mode === "solo") return openSoloSettings();
    setBusy(btn, true, "Creating…");
    try {
      const id = await api.rpc("create_game", {
        p_mode: mode, p_rounds: 5, p_time_limit: mode === "duel" ? 60 : 90, p_move_mode: "move",
      });
      location.hash = `#/g/${id}`;
    } catch (e) {
      toast(friendlyError(e), "error");
      setBusy(btn, false);
    }
  });
}

function openSoloSettings() {
  const modal = openModal(`
    <h2>Solo game</h2>
    <form id="solo-form" class="settings-grid">
      <label>Rounds<select name="rounds">${[3, 5, 7, 10].map((r) => `<option ${r === 5 ? "selected" : ""}>${r}</option>`).join("")}</select></label>
      <label>Time per round<select name="time"><option value="0" selected>No limit</option><option value="30">30 seconds</option><option value="60">1 minute</option><option value="120">2 minutes</option></select></label>
      <label>Movement<select name="move"><option value="move">Moving allowed</option><option value="nomove">No moving</option></select></label>
      <label>Street photos<select name="source">${Object.entries(SOURCES).map(([v, l]) => `<option value="${v}" ${v === getSourceSetting() ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <button class="btn btn-flag btn-block" type="submit">Start game</button>
    </form>`);
  const form = $("#solo-form", modal);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = $("button[type=submit]", form);
    setBusy(b, true, "Starting…");
    setSourceSetting(form.source.value);
    try {
      const id = await api.rpc("create_game", {
        p_mode: "solo", p_rounds: +form.rounds.value, p_time_limit: +form.time.value, p_move_mode: form.move.value,
      });
      closeModal();
      location.hash = `#/g/${id}`;
    } catch (err) {
      toast(friendlyError(err), "error");
      setBusy(b, false);
    }
  });
}

// ---------------------------------------------------------------- daily
async function renderDaily() {
  document.body.className = "page-daily";
  const today = new Date().toISOString().slice(0, 10);
  const pretty = new Date(`${today}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  app.innerHTML = `
    <section class="daily">
      <div class="daily-head">
        <h1>Daily challenge</h1>
        <p class="muted">${pretty} (UTC). Five places, the same for everyone, one attempt. A new set starts at midnight UTC.</p>
        <div id="daily-cta"><span class="spinner" aria-hidden="true"></span></div>
      </div>
      <div class="daily-board">
        <h2>Today's leaderboard</h2>
        <div id="board"><span class="spinner" aria-hidden="true"></span></div>
      </div>
    </section>`;

  api.leaderboard().then((rows) => {
    const board = $("#board", app);
    if (!board) return;
    board.innerHTML = rows?.length
      ? `<ol class="board">${rows.map((r) => `<li class="${profile && r.username === profile.username ? "me" : ""}"><span class="rank">${r.rank}</span><span class="pname">${esc(r.username)}</span><span class="pscore">${fmtScore(r.score)}</span></li>`).join("")}</ol>`
      : `<p class="muted">No finished runs yet today. Set the score to beat.</p>`;
  }).catch((e) => { const b = $("#board", app); if (b) b.innerHTML = `<p class="form-error">${esc(friendlyError(e))}</p>`; });

  const cta = $("#daily-cta", app);
  if (!user()) {
    cta.innerHTML = `<button class="btn btn-flag" id="daily-login">Log in to play</button>`;
    $("#daily-login", app).onclick = () => openAuth({ then: () => route() });
    return;
  }
  try {
    const st = await api.rpc("daily_status");
    if (!$("#daily-cta", app)) return;
    if (st.status === "finished") {
      cta.innerHTML = `<p class="daily-done">You scored <strong>${fmtScore(st.score)}</strong> today. Come back tomorrow for a new set.</p><a class="btn btn-ghost" href="#/g/${st.game_id}">Review your run</a>`;
    } else {
      cta.innerHTML = `<button class="btn btn-flag" id="daily-play">${st.game_id ? "Continue today's run" : "Play today's challenge"}</button>`;
      $("#daily-play", app).onclick = (e) => playDaily(e.currentTarget, st);
    }
  } catch (e) {
    cta.innerHTML = `<p class="form-error">${esc(friendlyError(e))}</p>`;
  }
}

async function playDaily(btn, st) {
  try {
    if (!st.seeded) {
      setBusy(btn, true, "Choosing today's places…");
      // Panoramax for the daily: it loads on every network, so everyone can play.
      const locs = await Promise.all(Array.from({ length: 5 }, () => randomLocation("panoramax")));
      await api.rpc("seed_daily", { p_locations: locs });
    }
    setBusy(btn, true, "Starting…");
    const id = await api.rpc("start_daily");
    location.hash = `#/g/${id}`;
  } catch (e) {
    toast(friendlyError(e), "error", 6000);
    setBusy(btn, false);
  }
}

// ---------------------------------------------------------------- join + game
async function renderJoin(code) {
  document.body.className = "page-join";
  app.innerHTML = `<section class="center-page"><div class="card card-narrow"><h2>Joining room ${esc(code)}</h2><p class="muted" id="join-msg">Log in to join this game.</p><div class="row-actions" id="join-actions"></div></div></section>`;
  const go = async () => {
    $("#join-msg", app).textContent = "Joining…";
    try {
      const id = await api.rpc("join_game", { p_code: code });
      location.replace(`#/g/${id}`);
    } catch (e) {
      $("#join-msg", app).textContent = friendlyError(e);
      $("#join-actions", app).innerHTML = `<a class="btn btn-ghost" href="#/">Back to home</a>`;
    }
  };
  if (user()) return go();
  $("#join-actions", app).innerHTML = `<button class="btn btn-flag" id="join-login">Log in or create an account</button>`;
  $("#join-login", app).onclick = () => openAuth({ then: go });
  openAuth({ then: go });
}

async function renderGame(id) {
  if (!user()) {
    document.body.className = "page-join";
    app.innerHTML = `<section class="center-page"><div class="card card-narrow"><h2>Log in to play</h2><p class="muted">You need an account to rejoin this game.</p><button class="btn btn-flag" id="g-login">Log in</button></div></section>`;
    $("#g-login", app).onclick = () => openAuth({ then: route });
    return;
  }
  document.body.className = "page-game";
  const { mountGame } = await import("./game.js");
  teardown = mountGame(app, id, { me: user(), goHome: () => { location.hash = "#/"; } });
}

// ---------------------------------------------------------------- setup
function renderSetup() {
  document.body.className = "page-setup";
  const missing = [
    !CONFIG.SUPABASE_URL && "SUPABASE_URL",
    !CONFIG.SUPABASE_ANON_KEY && "SUPABASE_ANON_KEY",
    !CONFIG.MAPILLARY_TOKEN && "MAPILLARY_TOKEN",
  ].filter(Boolean);
  app.innerHTML = `
    <section class="center-page">
      <div class="card setup">
        <h1>Almost ready</h1>
        <p>FreeGuessr needs three keys before anyone can play. Add them to <code>js/config.js</code>, commit, and reload.</p>
        <p>Still missing: ${missing.map((m) => `<code>${m}</code>`).join(", ")}</p>
        <p class="muted">Step-by-step instructions are in the README on GitHub.</p>
      </div>
    </section>`;
}


// ---------------------------------------------------------------- check page
// Tests every outside service the game uses, so a player on a filtered
// network can see exactly what's blocked.
async function renderCheck() {
  document.body.className = "page-check";
  const CHECKS = [
    { id: "browser", name: "Browser is new enough", fix: "Update Chrome, Edge, Safari or Firefox." },
    { id: "libs", name: "Game code loaded", fix: "Reload the page. If it still fails, this site's files are being blocked." },
    { id: "server", name: "Game server (Supabase)", fix: "supabase.co is blocked, so logins and rooms can't work on this network." },
    { id: "tiles", name: "Guess map (OpenStreetMap)", fix: "tile.openstreetmap.org is blocked, so the guess map will be blank." },
    { id: "webgl", name: "3D graphics (WebGL)", fix: "Not available, so 360° photos show as a flat strip you drag sideways. Everything else still works." },
    { id: "pxapi", name: "Panoramax search", fix: "api.panoramax.xyz is blocked, so Panoramax rounds can't start." },
    { id: "pxphotos", name: "Panoramax photos", fix: "Panoramax's photo servers are blocked, so Panoramax street views won't show." },
    { id: "mly", name: "Mapillary photos", fix: "Blocked (common on school networks). Set Street photos to Panoramax." },
  ];
  app.innerHTML = `
    <section class="check">
      <h1>Connection check</h1>
      <p class="muted">Tests everything FreeGuessr needs from this computer and network.</p>
      <ul class="check-list">${CHECKS.map((c) => `
        <li id="ck-${c.id}" class="ck pending"><span class="ck-mark" aria-hidden="true"></span>
          <div><p class="ck-name">${c.name}</p><p class="ck-detail muted">Checking…</p></div></li>`).join("")}
      </ul>
      <div id="ck-summary" class="ck-summary" hidden></div>
      <div class="row-actions"><a class="btn btn-ghost" href="./">Back to home</a><button class="btn btn-ghost" id="ck-copy" hidden>Copy results</button></div>
    </section>`;

  const withTimeout = (p, ms = 7000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);
  const img = (url, ms = 7000) => new Promise((resolve) => {
    const i = new Image(); const t = setTimeout(() => resolve(false), ms);
    i.onload = () => { clearTimeout(t); resolve(true); }; i.onerror = () => { clearTimeout(t); resolve(false); };
    i.src = url;
  });
  const results = {};
  const set = (id, ok, detail) => {
    results[id] = { ok, detail };
    const li = $(`#ck-${id}`, app);
    if (!li) return;
    li.className = `ck ${ok ? "ok" : "bad"}`;
    $(".ck-detail", li).textContent = ok ? (detail || "Working") : (detail || CHECKS.find((c) => c.id === id).fix);
  };

  const tests = {
    browser: async () => (HTMLScriptElement.supports?.("importmap") ? [true] : [false]),
    libs: async () => (window.L && window.supabase ? [true] : [false]),
    server: async () => {
      const r = await withTimeout(fetch(`${CONFIG.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: CONFIG.SUPABASE_ANON_KEY } }));
      return [r.ok];
    },
    tiles: async () => [await img(`https://tile.openstreetmap.org/2/1/1.png`)],
    webgl: async () => {
      let ok = false;
      try { const c = document.createElement("canvas"); ok = Boolean(c.getContext("webgl2") || c.getContext("webgl")); } catch { /* no */ }
      if (ok) { try { await withTimeout(import("@photo-sphere-viewer/core")); } catch { return [false, "3D graphics work, but the 360° viewer code didn't load. 360° photos will show as a flat strip."]; } }
      return [ok];
    },
    pxapi: async () => {
      const r = await withTimeout(fetch("https://api.panoramax.xyz/api/search?limit=10&bbox=2.33,48.85,2.36,48.87&filter=field_of_view%3D360"));
      if (!r.ok) return [false];
      results._pxFeatures = (await r.json()).features || [];
      return [true];
    },
    pxphotos: async () => {
      let feats = results._pxFeatures;
      if (!feats) { try { feats = (await (await withTimeout(fetch("https://api.panoramax.xyz/api/search?limit=10&bbox=2.33,48.85,2.36,48.87"))).json()).features; } catch { return [false, "Couldn't test: Panoramax search is blocked."]; } }
      const urls = [...new Map(feats.map((f) => f.assets?.thumb?.href || f.assets?.sd?.href).filter(Boolean).map((u) => [new URL(u).host, u])).values()];
      if (!urls.length) {
        try {
          const more = (await (await withTimeout(fetch("https://api.panoramax.xyz/api/search?limit=10&bbox=-0.15,51.49,-0.1,51.52"))).json()).features || [];
          more.forEach((f) => { const u = f.assets?.thumb?.href || f.assets?.sd?.href; if (u) urls.push(u); });
        } catch { /* fall through */ }
      }
      if (!urls.length) return [false, "Couldn't find a photo to test."];
      const ok = await Promise.all(urls.map((u) => img(u)));
      const blocked = urls.filter((_, i) => !ok[i]).map((u) => new URL(u).host);
      return blocked.length ? [false, `Blocked: ${blocked.join(", ")}. Panoramax street views won't show.`] : [true];
    },
    mly: async () => [await withTimeout(mapillaryReachable(), 9000).catch(() => false)],
  };
  // pxphotos uses pxapi's result, so run that pair in order; everything else in parallel.
  await Promise.all(Object.entries(tests).filter(([k]) => k !== "pxphotos").map(async ([id, fn]) => {
    try { const [ok, detail] = await fn(); set(id, ok, detail); } catch { set(id, false); }
    if (id === "pxapi") { try { const [ok, detail] = await tests.pxphotos(); set("pxphotos", ok, detail); } catch { set("pxphotos", false); } }
  }));

  const r = (k) => results[k]?.ok;
  const canPlay = r("browser") && r("libs") && r("server") && r("pxapi") && r("pxphotos");
  const summary = $("#ck-summary", app);
  summary.hidden = false;
  summary.className = `ck-summary ${canPlay || (r("libs") && r("server") && r("mly")) ? "good" : "bad"}`;
  summary.innerHTML = !r("libs") || !r("server")
    ? "<strong>FreeGuessr can't run here.</strong> The game's own files or its server are blocked on this computer or network."
    : r("mly")
      ? "<strong>You're good to go.</strong> Everything the game needs loads here."
      : canPlay
        ? "<strong>You can play.</strong> Mapillary is blocked here, so use <em>Street photos: Panoramax</em> (Automatic picks it for you)."
        : "<strong>Street views can't load here.</strong> Neither photo source gets through this network's filter. Try another Wi-Fi or a phone hotspot.";
  const copy = $("#ck-copy", app);
  copy.hidden = false;
  copy.onclick = () => {
    const text = CHECKS.map((c) => `${results[c.id]?.ok ? "OK  " : "FAIL"} ${c.name}${results[c.id]?.ok ? "" : ` — ${results[c.id]?.detail || c.fix}`}`).join("\n") + `\n${navigator.userAgent}`;
    navigator.clipboard?.writeText(text).then(() => toast("Results copied"), () => toast("Couldn't copy", "error"));
  };
}

// ---------------------------------------------------------------- router
async function route() {
  teardown?.();
  teardown = null;
  closeModal();
  const hash = location.hash.replace(/^#\/?/, "");
  const [section, arg] = hash.split("/");
  window.scrollTo(0, 0);
  try {
    if (section === "g" && arg) return await renderGame(arg);
    if (section === "join" && arg) return await renderJoin(arg.toUpperCase());
    if (section === "daily") return await renderDaily();
    if (section === "check") return await renderCheck();
    return await renderHome();
  } catch (e) {
    toast(friendlyError(e), "error");
  }
}

async function init() {
  // The check page must work even when the rest of the game can't start.
  if (location.hash.startsWith("#/check")) return renderCheck();
  if (!isConfigured()) return renderSetup();
  ({ api, USERNAME_RE } = await import("./api.js"));
  session = await api.session();
  await loadProfile();
  api.onAuth(async (s) => {
    const changed = (s?.user?.id || null) !== (session?.user?.id || null);
    session = s;
    if (changed) { await loadProfile(); }
  });
  window.addEventListener("hashchange", route);
  route();
  // Find out early whether this network can load Mapillary photos, so the
  // first round doesn't wait on the check.
  if (getSourceSetting() === "auto") setTimeout(() => mapillaryReachable(), 300);
}

init().catch((e) => {
  app.innerHTML = `<section class="center-page"><div class="card card-narrow"><h2>FreeGuessr couldn't start</h2><p class="muted">${esc(friendlyError(e))}</p><div class="row-actions"><a class="btn btn-ghost" href="#/check" onclick="setTimeout(() => location.reload(), 0)">Run a connection check</a><button class="btn btn-flag" onclick="location.reload()">Reload</button></div></div></section>`;
});
