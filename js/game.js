// The game screen: lobby → rounds → results → final standings.
// The database is the source of truth; this screen re-reads it whenever
// Realtime reports a change (and every few seconds as a safety net), then
// works out which view to show from that state.
import { api } from "./api.js";
import { $, $$, esc, el, fmtScore, fmtDistance, fmtClock, toast, setBusy, copyText, friendlyError, openModal, closeModal } from "./ui.js";
import { showPano, backToStart, resizeViewer, preloadViewer, destroyViewer } from "./viewer.js";
import { createGuessMap, createResultMap, colorFor } from "./maps.js";
import { nextLocation, prefetchLocation, SOURCES, getSourceSetting, setSourceSetting } from "./locations.js";

const MAX_HEALTH = 6000;
const MODE_NAME = { solo: "Solo", party: "Party room", duel: "Duel", daily: "Daily challenge" };
const TIME_OPTIONS = [[0, "No limit"], [30, "30 seconds"], [60, "1 minute"], [90, "90 seconds"], [120, "2 minutes"], [180, "3 minutes"], [300, "5 minutes"]];
const DUEL_TIME_OPTIONS = TIME_OPTIONS.filter(([s]) => s >= 30);
const ROUND_OPTIONS = [3, 5, 7, 10, 15, 20];

export function mountGame(root, gameId, { me, goHome }) {
  root.innerHTML = `
    <div class="game-screen" data-view="loading">
      <div class="pano" id="pano" aria-label="Street view"></div>
      <div class="pano-veil" id="veil"><div class="veil-inner"><span class="spinner big" aria-hidden="true"></span><p id="veil-text">Loading…</p></div></div>

      <div class="hud">
        <div class="hud-left">
          <button class="hud-btn" id="exit" aria-label="Leave game"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <div class="hud-stats">
            <div class="stat"><span class="stat-k">Round</span><span class="stat-v" id="hud-round">–</span></div>
            <div class="stat" id="hud-score-wrap"><span class="stat-k">Score</span><span class="stat-v" id="hud-score">0</span></div>
            <div class="stat stat-timer" id="hud-timer-wrap" hidden><span class="stat-k">Time</span><span class="stat-v" id="hud-timer">0:00</span></div>
          </div>
        </div>
        <div class="hud-duel" id="hud-duel" hidden></div>
        <ol class="hud-players" id="hud-players" hidden></ol>
      </div>

      <button class="back-start" id="back-start" title="Return to where you started">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.6H20l-5 3.6 1.9 5.8L12 14.4 7.1 18l1.9-5.8-5-3.6h6.2z" fill="currentColor"/></svg>
        <span>Back to start</span>
      </button>

      <section class="dock" id="dock" aria-label="Guess map">
        <div class="dock-map" id="guessmap"></div>
        <div class="dock-bar">
          <button class="dock-close" id="dock-close" aria-label="Close map">Close</button>
          <button class="btn btn-flag dock-guess" id="guess" disabled>Place your pin on the map</button>
        </div>
      </section>
      <button class="map-fab" id="map-fab" aria-controls="dock">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z M9 4v13.5 M15 6.5V20" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>
        Map
      </button>

      <div class="overlay" id="overlay" hidden></div>
    </div>`;

  const screen = $(".game-screen", root);
  const overlay = $("#overlay", root);
  const dock = $("#dock", root);
  const veil = $("#veil", root);
  const guessBtn = $("#guess", root);

  let game = null, players = [], round = null;
  let clockOffset = 0;
  let viewKey = "";
  let pin = null;
  let destroyed = false;
  let guessMap = null;
  let starting = false, guessing = false;
  let lastEndAttempt = 0;
  let seenFinalResult = false;
  let startError = null;
  let resultCache = new Map();
  let summaryCache = null;
  let resultMap = null;
  let advanceTimer = null;
  let refreshQueued = null;
  let refreshing = false, refreshAgain = false;
  const disposers = [];

  const now = () => Date.now() + clockOffset;
  const meP = () => players.find((p) => p.user_id === me.id);
  const isHost = () => game && game.host_id === me.id;
  const colorIndex = (uid) => Math.max(0, players.findIndex((p) => p.user_id === uid));

  // ---------- data ----------
  async function refresh() {
    if (destroyed) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      const data = await api.loadGame(gameId);
      if (destroyed) return;
      game = data.game; players = data.players;
      round = data.round && game && data.round.round_no === game.current_round ? data.round : (game?.current_round ? round : null);
      render();
    } catch (e) {
      if (!destroyed) toast(friendlyError(e), "error");
    } finally {
      refreshing = false;
      if (refreshAgain) { refreshAgain = false; refresh(); }
    }
  }
  const queueRefresh = () => {
    clearTimeout(refreshQueued);
    refreshQueued = setTimeout(refresh, 120);
  };

  // ---------- view selection ----------
  function computeKey() {
    if (!game) return "missing";
    if (game.status === "lobby") {
      if ((game.mode === "solo" || game.mode === "daily") && isHost()) return startError ? "startfail" : "starting";
      return "lobby";
    }
    if (game.status === "finished") {
      if (!seenFinalResult && round?.ended_at) return `result:${round.round_no}`;
      return "final";
    }
    if (!round) return "starting";
    if (round.ended_at) return `result:${round.round_no}`;
    return (meP()?.guessed_round ?? 0) >= round.round_no ? `waiting:${round.round_no}` : `play:${round.round_no}`;
  }

  function render() {
    const key = computeKey();
    screen.dataset.mode = game?.mode || "";
    updateHud();
    if (key !== viewKey) {
      const prev = viewKey;
      viewKey = key;
      enterView(key, prev);
    } else {
      updateLive();
    }
  }

  function enterView(key, prev) {
    clearTimeout(advanceTimer);
    const [name, n] = key.split(":");
    screen.dataset.view = name;
    if (name !== "result" && name !== "final" && resultMap) { resultMap.remove(); resultMap = null; }

    if (name === "missing") return showMissing();
    if (name === "lobby") return showLobby();
    if (name === "starting") return showStarting();
    if (name === "startfail") return showStartFail();
    if (name === "play") return showPlay(+n, prev);
    if (name === "waiting") return showWaiting();
    if (name === "result") return showResult(+n);
    if (name === "final") return showFinal();
  }

  function updateLive() {
    if (viewKey === "lobby") renderLobbyRoster();
    if (viewKey.startsWith("waiting")) renderWaiting();
  }

  // ---------- HUD ----------
  function updateHud() {
    if (!game) return;
    const mine = meP();
    const total = game.mode === "duel" ? "" : ` / ${game.total_rounds}`;
    $("#hud-round", root).textContent = game.current_round ? `${game.current_round}${total}` : "–";
    $("#hud-score", root).textContent = fmtScore(mine?.total_score);
    $("#hud-score-wrap", root).hidden = game.mode === "duel";

    const duel = $("#hud-duel", root);
    duel.hidden = game.mode !== "duel" || players.length < 2;
    if (!duel.hidden) duel.innerHTML = duelBars();

    const list = $("#hud-players", root);
    list.hidden = game.mode !== "party";
    if (!list.hidden) {
      const rn = round && !round.ended_at ? round.round_no : -1;
      list.innerHTML = [...players]
        .sort((a, b) => b.total_score - a.total_score)
        .map((p) => `<li class="${p.guessed_round >= rn && rn > 0 ? "done" : ""}">
            <span class="dot" style="background:${colorFor(colorIndex(p.user_id))}"></span>
            <span class="pname">${esc(p.username)}${p.user_id === me.id ? " (you)" : ""}</span>
            <span class="pscore">${fmtScore(p.total_score)}</span>
            <span class="pcheck" aria-label="${p.guessed_round >= rn ? "guessed" : ""}">${p.guessed_round >= rn && rn > 0 ? "✓" : ""}</span>
          </li>`).join("");
    }
  }

  function duelBars(damageByUser = {}) {
    const ordered = [...players].sort((a, b) => (a.user_id === me.id ? -1 : b.user_id === me.id ? 1 : 0));
    const mult = round && Number(round.multiplier) > 1 ? `<span class="mult">×${Number(round.multiplier)} damage</span>` : "";
    return ordered.map((p, i) => `
      <div class="hp ${i ? "hp-right" : ""}">
        <div class="hp-top"><span class="hp-name">${esc(p.username)}${p.user_id === me.id ? " (you)" : ""}</span><span class="hp-num">${fmtScore(p.health)}</span></div>
        <div class="hp-bar"><div class="hp-fill" style="width:${(100 * p.health) / MAX_HEALTH}%;background:${colorFor(colorIndex(p.user_id))}"></div></div>
        ${damageByUser[p.user_id] ? `<span class="hp-dmg">−${fmtScore(damageByUser[p.user_id])} health</span>` : ""}
      </div>`).join(`<div class="hp-vs">${mult || "vs"}</div>`);
  }

  // ---------- timer ----------
  function tick() {
    const wrap = $("#hud-timer-wrap", root);
    if (!round || round.ended_at || !round.deadline || !game || game.status !== "playing") {
      wrap.hidden = true;
      return;
    }
    const left = (new Date(round.deadline).getTime() - now()) / 1000;
    wrap.hidden = false;
    wrap.classList.toggle("urgent", left <= 10);
    $("#hud-timer", root).textContent = fmtClock(left);
    if (left <= 0) onTimeUp();
  }

  async function onTimeUp() {
    if (Date.now() - lastEndAttempt < 1500) return;
    lastEndAttempt = Date.now();
    const guessed = (meP()?.guessed_round ?? 0) >= round.round_no;
    if (!guessed && pin && !guessing) return submitGuess(); // auto-submit a placed pin
    try {
      await api.rpc("end_round", { p_game: gameId, p_round: round.round_no, p_force: false });
      queueRefresh();
    } catch (e) {
      if (!/still in progress/i.test(e.message)) queueRefresh();
    }
  }

  // ---------- views ----------
  function showOverlay(html, cls = "") {
    overlay.className = `overlay ${cls}`;
    overlay.innerHTML = html;
    overlay.hidden = false;
    return overlay;
  }
  function hideOverlay() {
    overlay.hidden = true;
    overlay.innerHTML = "";
  }

  function showMissing() {
    veil.hidden = true;
    showOverlay(`
      <div class="card card-narrow">
        <h2>This game isn't available</h2>
        <p class="muted">It may have been closed by the host, or you haven't joined it. Ask for the room code and join from the home page.</p>
        <button class="btn btn-flag" data-act="home">Back to home</button>
      </div>`, "overlay-center");
  }

  function showStarting() {
    hideOverlay();
    veil.hidden = false;
    $("#veil-text", root).textContent = game?.mode === "daily" ? "Loading today's first place…" : "Finding somewhere to drop you…";
    preloadViewer();
    if (game?.status === "lobby" && isHost()) startRound(1);
  }

  function showStartFail() {
    veil.hidden = true;
    showOverlay(`<div class="card card-narrow"><h2>Couldn't start the round</h2><p class="muted">${esc(startError)}</p>
      <div class="row-actions"><button class="btn btn-ghost" data-act="home">Back to home</button><button class="btn btn-flag" id="retry">Try again</button></div></div>`, "overlay-center");
    $("#retry", overlay).onclick = () => { startError = null; render(); };
  }

  // Lobby
  function settingsSummary() {
    const t = TIME_OPTIONS.find(([s]) => s === game.time_limit)?.[1] || `${game.time_limit} seconds`;
    const move = game.move_mode === "move" ? "Moving allowed" : "No moving";
    if (game.mode === "duel") return `${t} per round · ${move}`;
    return `${game.total_rounds} rounds · ${t} per round · ${move}`;
  }

  function showLobby() {
    veil.hidden = true;
    preloadViewer();
    if (isHost() && game.mode !== "daily") prefetchLocation();
    const link = `${location.origin}${location.pathname}#/join/${game.code}`;
    const host = isHost();
    const settings = host ? `
      <div class="settings-grid">
        ${game.mode === "duel" ? "" : `<label>Rounds<select id="set-rounds">${ROUND_OPTIONS.map((r) => `<option value="${r}" ${r === game.total_rounds ? "selected" : ""}>${r}</option>`).join("")}</select></label>`}
        <label>Time per round<select id="set-time">${(game.mode === "duel" ? DUEL_TIME_OPTIONS : TIME_OPTIONS).map(([s, l]) => `<option value="${s}" ${s === game.time_limit ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Movement<select id="set-move"><option value="move" ${game.move_mode === "move" ? "selected" : ""}>Moving allowed</option><option value="nomove" ${game.move_mode === "nomove" ? "selected" : ""}>No moving</option></select></label>
        <label>Street photos<select id="set-source">${Object.entries(SOURCES).map(([v, l]) => `<option value="${v}" ${v === getSourceSetting() ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <p class="hint">Playing on a school network? Pick Panoramax so everyone's photos load.</p>
      </div>` : `<p class="settings-ro" id="settings-ro">${esc(settingsSummary())}</p>`;

    showOverlay(`
      <div class="card lobby">
        <div class="lobby-head">
          <h2>${MODE_NAME[game.mode]}</h2>
          <p class="muted">${game.mode === "duel"
            ? "Both players guess the same place. Whoever is farther away loses health equal to the score gap. First to zero loses."
            : "Everyone guesses the same places at the same time. Highest total after the last round wins."}</p>
        </div>
        <div class="invite">
          <div class="code-block">
            <span class="code-label">Room code</span>
            <button class="room-code" id="copy-code" title="Copy code">${esc(game.code)}</button>
          </div>
          <button class="btn btn-ghost" id="copy-link">Copy invite link</button>
        </div>
        <div class="lobby-cols">
          <div>
            <h3 id="roster-title">Players</h3>
            <ul class="roster" id="roster"></ul>
          </div>
          <div>
            <h3>Settings</h3>
            ${settings}
          </div>
        </div>
        <div class="lobby-actions">
          <button class="btn btn-ghost" data-act="leave">${host ? "Close room" : "Leave room"}</button>
          ${host ? `<button class="btn btn-flag" id="start">Start game</button>` : `<p class="muted waiting-host">Waiting for the host to start…</p>`}
        </div>
      </div>`, "overlay-center overlay-scroll");

    renderLobbyRoster();
    $("#copy-code", overlay).onclick = () => copyText(game.code).then(() => toast("Room code copied"));
    $("#copy-link", overlay).onclick = () => copyText(link).then(() => toast("Invite link copied"));
    if (host) {
      const save = async () => {
        try {
          await api.rpc("update_settings", {
            p_game: gameId,
            p_rounds: +($("#set-rounds", overlay)?.value || game.total_rounds),
            p_time_limit: +$("#set-time", overlay).value,
            p_move_mode: $("#set-move", overlay).value,
          });
          queueRefresh();
        } catch (e) { toast(friendlyError(e), "error"); }
      };
      $$("select:not(#set-source)", overlay).forEach((s) => s.addEventListener("change", save));
      $("#set-source", overlay).addEventListener("change", (e) => { setSourceSetting(e.target.value); prefetchLocation(); });
      $("#start", overlay).onclick = (e) => startRound(1, e.currentTarget);
    }
  }

  function renderLobbyRoster() {
    const ul = $("#roster", overlay);
    if (!ul) return;
    ul.innerHTML = players.map((p) => `
      <li><span class="dot" style="background:${colorFor(colorIndex(p.user_id))}"></span>${esc(p.username)}
      ${p.user_id === game.host_id ? `<span class="tag">Host</span>` : ""}${p.user_id === me.id ? `<span class="tag tag-you">You</span>` : ""}</li>`).join("")
      + (game.mode === "duel" && players.length < 2 ? `<li class="empty-slot">Waiting for an opponent…</li>` : "");
    const cap = game.mode === "duel" ? 2 : 16;
    $("#roster-title", overlay).textContent = `Players (${players.length}/${cap})`;
    const start = $("#start", overlay);
    if (start && !starting) {
      const needOpp = game.mode === "duel" && players.length < 2;
      start.disabled = needOpp;
      start.textContent = needOpp ? "Waiting for an opponent" : "Start game";
    }
    const ro = $("#settings-ro", overlay);
    if (ro) ro.textContent = settingsSummary();
  }

  // Playing
  async function showPlay(n, prev) {
    hideOverlay();
    pin = null;
    guessBtn.disabled = true;
    guessBtn.textContent = "Place your pin on the map";
    dock.classList.remove("open");
    ensureGuessMap();
    guessMap.clear();
    $("#back-start", root).hidden = game.move_mode !== "move";

    // Show the veil only when coming from another screen; keep the old image
    // under it until the new one is ready so there's never a blank flash.
    veil.hidden = false;
    $("#veil-text", root).textContent = `Round ${n}`;
    try {
      await showPano($("#pano", root), round.image_id, { allowMove: game.move_mode === "move" });
    } catch (e) {
      if (destroyed || viewKey !== `play:${n}`) return;
      // Keep the message on screen (the guess map still works on top of it).
      $(".spinner", veil)?.setAttribute("hidden", "");
      $("#veil-text", root).textContent = friendlyError(e);
      veil.classList.add("veil-error");
      return;
    }
    if (destroyed || viewKey !== `play:${n}`) return;
    $(".spinner", veil)?.removeAttribute("hidden");
    veil.classList.remove("veil-error");
    veil.hidden = true;
    resizeViewer();
    guessMap.invalidate();
    if (isHost() && game.mode !== "daily" && n < game.total_rounds) prefetchLocation();
  }

  function ensureGuessMap() {
    if (guessMap) return;
    guessMap = createGuessMap($("#guessmap", root), (ll) => {
      pin = ll;
      if (!guessing) {
        guessBtn.disabled = false;
        guessBtn.textContent = "Guess";
      }
    });
    // Keep the map sized correctly as the dock grows and shrinks.
    const ro = new ResizeObserver(() => guessMap?.invalidate());
    ro.observe($("#guessmap", root));
    disposers.push(() => ro.disconnect());
  }

  async function submitGuess() {
    if (!pin || guessing || !round || round.ended_at) return;
    guessing = true;
    setBusy(guessBtn, true, "Locking in…");
    try {
      await api.rpc("submit_guess", { p_game: gameId, p_round: round.round_no, p_lat: pin.lat, p_lng: pin.lng });
      dock.classList.remove("open");
    } catch (e) {
      if (/Time is up/i.test(e.message)) {
        toast("Time ran out before your guess arrived.", "error");
        lastEndAttempt = 0;
      } else if (!/already guessed/i.test(e.message)) {
        toast(friendlyError(e), "error");
      }
    } finally {
      guessing = false;
      setBusy(guessBtn, false);
      await refresh();
    }
  }

  function showWaiting() {
    veil.hidden = true;
    dock.classList.remove("open");
    showOverlay(`<div class="card card-narrow waiting" id="waiting"></div>`, "overlay-bottom");
    renderWaiting();
  }

  function renderWaiting() {
    const box = $("#waiting", overlay);
    if (!box || !round) return;
    const left = players.filter((p) => p.guessed_round < round.round_no);
    const names = left.map((p) => esc(p.username));
    const forceBtn = isHost() && game.mode === "party" && left.length
      ? `<button class="btn btn-ghost btn-small" id="force-end">End round now</button>` : "";
    box.innerHTML = `
      <p class="waiting-title">Guess locked in</p>
      <p class="muted">${left.length ? `Waiting for ${names.length <= 3 ? names.join(", ") : `${names.length} players`}…` : "Scoring the round…"}</p>
      ${forceBtn}`;
    const f = $("#force-end", box);
    if (f) f.onclick = async () => {
      setBusy(f, true, "Ending…");
      try { await api.rpc("end_round", { p_game: gameId, p_round: round.round_no, p_force: true }); queueRefresh(); }
      catch (e) { toast(friendlyError(e), "error"); setBusy(f, false); }
    };
  }

  // Round results
  async function getResult(n) {
    if (!resultCache.has(n)) resultCache.set(n, api.rpc("get_round_result", { p_game: gameId, p_round: n }));
    try { return await resultCache.get(n); }
    catch (e) { resultCache.delete(n); throw e; }
  }

  async function showResult(n) {
    veil.hidden = true;
    dock.classList.remove("open");
    showOverlay(`<div class="result-loading"><span class="spinner big" aria-hidden="true"></span></div>`, "overlay-full");
    let res;
    try { res = await getResult(n); }
    catch (e) { toast(friendlyError(e), "error"); setTimeout(queueRefresh, 1500); return; }
    if (destroyed || viewKey !== `result:${n}`) return;

    const mine = res.guesses.find((g) => g.user_id === me.id);
    const isLast = game.status === "finished";
    const pct = Math.round(((mine?.score || 0) / 5000) * 100);
    const damage = Object.fromEntries(res.guesses.filter((g) => g.damage).map((g) => [g.user_id, g.damage]));

    let detail = "";
    if (game.mode === "party") {
      const totals = Object.fromEntries(players.map((p) => [p.user_id, p.total_score]));
      detail = `<table class="standings">
        <thead><tr><th>Player</th><th>Distance</th><th>Round</th><th>Total</th></tr></thead>
        <tbody>${res.guesses.map((g) => `<tr class="${g.user_id === me.id ? "me" : ""}">
          <td><span class="dot" style="background:${colorFor(colorIndex(g.user_id))}"></span>${esc(g.username)}</td>
          <td>${fmtDistance(g.distance_km)}</td><td>${fmtScore(g.score)}</td><td>${fmtScore(totals[g.user_id])}</td></tr>`).join("")}
        </tbody></table>`;
    } else if (game.mode === "duel") {
      const opp = res.guesses.find((g) => g.user_id !== me.id);
      detail = `<div class="duel-result">${duelBars(damage)}</div>
        <p class="muted duel-line">${opp ? `${esc(opp.username)}: ${fmtDistance(opp.distance_km)} · ${fmtScore(opp.score)} pts` : ""}
        ${Number(res.multiplier) > 1 ? ` · ×${Number(res.multiplier)} damage this round` : ""}</p>`;
    }

    const host = isHost();
    const nextLabel = isLast ? "See final results" : "Next round";
    const canAdvance = isLast || host;
    showOverlay(`
      <div class="result">
        <div class="result-map" id="result-map"></div>
        <div class="result-panel">
          <div class="result-score">
            <div>
              <p class="big-score">${fmtScore(mine?.score)}<span> points</span></p>
              <p class="muted">${mine?.lat == null ? "You didn't guess in time." : `Your guess was <strong>${fmtDistance(mine.distance_km)}</strong> from the flag.`}</p>
              ${game.mode === "solo" || game.mode === "daily" ? `<p class="muted">Round ${n} of ${game.total_rounds} · ${fmtScore(meP()?.total_score)} points so far</p>` : ""}
            </div>
            <div class="scorebar" role="img" aria-label="${pct}% of the maximum 5,000 points"><div style="width:${pct}%"></div></div>
          </div>
          ${detail}
          <div class="result-actions">
            ${canAdvance ? `<button class="btn btn-flag" id="next">${nextLabel}</button>` : `<p class="muted" id="wait-next">Waiting for ${esc(players.find((p) => p.user_id === game.host_id)?.username || "the host")} to start the next round…</p>`}
            ${!canAdvance ? `<button class="btn btn-ghost" id="rescue" hidden>Start next round</button>` : ""}
            ${game.mode === "duel" && !isLast ? `<p class="muted" id="auto-next"></p>` : ""}
          </div>
        </div>
      </div>`, "overlay-full");

    resultMap = createResultMap($("#result-map", overlay), [{
      answer: res.answer,
      guesses: res.guesses.map((g) => ({ ...g, colorIndex: colorIndex(g.user_id) })),
    }]);

    const next = $("#next", overlay);
    if (next) {
      next.onclick = () => {
        if (isLast) { seenFinalResult = true; render(); }
        else startRound(n + 1, next);
      };
      next.focus();
    }
    const rescue = $("#rescue", overlay);
    if (rescue) {
      setTimeout(() => { if (viewKey === `result:${n}`) rescue.hidden = false; }, 21000);
      rescue.onclick = () => startRound(n + 1, rescue);
    }
    // Duels roll on automatically.
    if (game.mode === "duel" && !isLast && host) {
      let s = 8;
      const label = $("#auto-next", overlay);
      const step = () => {
        if (viewKey !== `result:${n}`) return;
        if (s <= 0) return startRound(n + 1, next);
        label.textContent = `Next round in ${s}…`;
        s -= 1;
        advanceTimer = setTimeout(step, 1000);
      };
      step();
    }
  }

  async function startRound(n, btn) {
    if (starting) return;
    starting = true;
    setBusy(btn, true, "Finding a place…");
    try {
      const loc = game.mode === "daily" ? { image_id: "0", lat: 0, lng: 0 } : await nextLocation();
      await api.rpc("start_round", { p_game: gameId, p_round: n, p_image_id: loc.image_id, p_lat: loc.lat, p_lng: loc.lng });
    } catch (e) {
      if (!/Waiting for the host/i.test(e.message)) toast(friendlyError(e), "error", 6000);
      if (n === 1 && game?.status === "lobby" && (game.mode === "solo" || game.mode === "daily")) {
        startError = friendlyError(e);
        starting = false;
        render();
        return;
      }
    } finally {
      starting = false;
      setBusy(btn, false);
    }
    await refresh();
  }

  // Final standings
  async function showFinal() {
    veil.hidden = true;
    dock.classList.remove("open");
    showOverlay(`<div class="result-loading"><span class="spinner big" aria-hidden="true"></span></div>`, "overlay-full");
    try {
      summaryCache = summaryCache || (await api.rpc("get_game_summary", { p_game: gameId }));
    } catch (e) { toast(friendlyError(e), "error"); return; }
    if (destroyed || viewKey !== "final") return;
    const s = summaryCache;
    const mine = s.players.find((p) => p.user_id === me.id);
    const maxScore = s.rounds.length * 5000;

    let headline, sub;
    if (game.mode === "duel") {
      const won = game.winner_id === me.id;
      headline = game.winner_id ? (won ? "You won the duel" : "You lost the duel") : "It's a draw";
      sub = `${s.rounds.length} rounds played.`;
    } else if (game.mode === "party") {
      const winner = s.players[0];
      headline = winner.user_id === me.id ? "You won the room" : `${esc(winner.username)} wins`;
      sub = `You scored ${fmtScore(mine?.total_score)} of ${fmtScore(maxScore)} possible points.`;
    } else {
      headline = `${fmtScore(mine?.total_score)} points`;
      sub = `out of ${fmtScore(maxScore)} possible across ${s.rounds.length} rounds.`;
    }

    const roundRows = s.rounds.map((r) => {
      const g = r.guesses.find((x) => x.user_id === me.id);
      return `<tr><td>${r.round_no}</td><td>${fmtDistance(g?.distance_km)}</td><td>${fmtScore(g?.score)}</td></tr>`;
    }).join("");
    const standings = game.mode === "party" || game.mode === "duel"
      ? `<h3>Standings</h3><ol class="final-standings">${s.players.map((p) => `<li class="${p.user_id === me.id ? "me" : ""}"><span class="dot" style="background:${colorFor(colorIndex(p.user_id))}"></span><span class="pname">${esc(p.username)}</span><span>${game.mode === "duel" ? `${fmtScore(p.health)} health` : `${fmtScore(p.total_score)} pts`}</span></li>`).join("")}</ol>`
      : "";

    showOverlay(`
      <div class="result final">
        <div class="result-map" id="result-map"></div>
        <div class="result-panel">
          <div class="final-head"><h2>${headline}</h2><p class="muted">${sub}</p></div>
          ${standings}
          <h3>Your rounds</h3>
          <table class="standings compact"><thead><tr><th>Round</th><th>Distance</th><th>Points</th></tr></thead><tbody>${roundRows}</tbody></table>
          <div class="result-actions">
            <button class="btn btn-ghost" data-act="home">Home</button>
            ${game.mode === "daily" ? `<a class="btn btn-flag" href="#/daily">See today's leaderboard</a>`
              : `<button class="btn btn-flag" id="again">${game.mode === "solo" ? "Play again" : "New room, same settings"}</button>`}
          </div>
        </div>
      </div>`, "overlay-full");

    resultMap = createResultMap($("#result-map", overlay), s.rounds.map((r) => ({
      answer: r.answer,
      label: String(r.round_no),
      guesses: r.guesses.filter((g) => game.mode === "solo" || game.mode === "daily" || g.user_id === me.id || game.mode === "duel")
        .map((g) => ({ ...g, colorIndex: colorIndex(g.user_id) })),
    })));

    const again = $("#again", overlay);
    if (again) again.onclick = async () => {
      setBusy(again, true, "Creating…");
      try {
        const id = await api.rpc("create_game", {
          p_mode: game.mode, p_rounds: game.total_rounds, p_time_limit: game.time_limit, p_move_mode: game.move_mode,
        });
        location.hash = `#/g/${id}`;
      } catch (e) { toast(friendlyError(e), "error"); setBusy(again, false); }
    };
  }

  // ---------- events ----------
  async function leave() {
    if (game?.status === "lobby") {
      try { await api.rpc("leave_game", { p_game: gameId }); } catch { /* best effort */ }
      return goHome();
    }
    if (game?.status === "playing" && game.mode !== "solo") {
      openModal(`<h2>Leave this game?</h2>
        <p class="muted">The game carries on without you. You can rejoin from the home page while it's running.</p>
        <div class="row-actions"><button class="btn btn-ghost" data-close>Stay</button><button class="btn btn-flag" id="confirm-leave">Leave</button></div>`);
      $("#confirm-leave").onclick = () => { closeModal(); goHome(); };
      return;
    }
    goHome();
  }

  screen.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "home") goHome();
    if (act === "leave") leave();
  });
  $("#exit", root).onclick = leave;
  $("#back-start", root).onclick = backToStart;
  guessBtn.onclick = submitGuess;
  $("#map-fab", root).onclick = () => { dock.classList.add("open"); guessMap?.invalidate(); };
  $("#dock-close", root).onclick = () => dock.classList.remove("open");

  // Desktop: the map grows while hovered and shrinks after the pointer leaves.
  let shrinkTimer;
  dock.addEventListener("pointerenter", () => { clearTimeout(shrinkTimer); dock.classList.add("expanded"); });
  dock.addEventListener("pointerleave", () => { shrinkTimer = setTimeout(() => dock.classList.remove("expanded"), 500); });

  const onKey = (e) => {
    if (e.target.closest("input, select, textarea") || document.querySelector(".modal")) return;
    if ((e.key === " " || e.key === "Enter") && viewKey.startsWith("play") && pin) { e.preventDefault(); submitGuess(); }
    else if ((e.key === " " || e.key === "Enter") && viewKey.startsWith("result")) { const b = $("#next", overlay); if (b && document.activeElement !== b) { e.preventDefault(); b.click(); } }
    else if (e.key.toLowerCase() === "m" && viewKey.startsWith("play")) dock.classList.toggle("open");
  };
  document.addEventListener("keydown", onKey);
  const onVis = () => { if (!document.hidden) refresh(); };
  document.addEventListener("visibilitychange", onVis);

  // ---------- lifecycle ----------
  (async () => {
    try { clockOffset = await api.clockOffset(); } catch { clockOffset = 0; }
    await refresh();
  })();
  const unsub = api.subscribe(gameId, queueRefresh, (status) => { if (status === "SUBSCRIBED") queueRefresh(); });
  const poll = setInterval(() => { if (game?.status !== "finished") refresh(); }, 4000);
  const ticker = setInterval(tick, 250);

  return function destroy() {
    destroyed = true;
    unsub();
    clearInterval(poll);
    clearInterval(ticker);
    clearTimeout(advanceTimer);
    clearTimeout(refreshQueued);
    clearTimeout(shrinkTimer);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onVis);
    disposers.forEach((d) => d());
    resultMap?.remove();
    guessMap?.map.remove();
    destroyViewer();
  };
}
