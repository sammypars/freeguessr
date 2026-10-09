// Everything that talks to Supabase lives here.
import { CONFIG, isConfigured } from "./config.js";
import { loadScript } from "./load.js";

// supabase-js lives in vendor/ (hosted with the site, so web filters that
// block code CDNs can't break it). index.html normally loads it; load it here
// too in case a cached older page didn't.
if (!window.supabase?.createClient && isConfigured()) {
  await loadScript(new URL("../vendor/supabase.js", import.meta.url), "Couldn't load the game's server library. Reload the page.");
}
const createClient = (...args) => window.supabase.createClient(...args);

const sb = isConfigured()
  ? createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
  : null;

const emailFor = (username) => `${username.trim().toLowerCase()}@${CONFIG.AUTH_EMAIL_DOMAIN}`;
export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export const api = {
  rpc,

  async session() {
    const { data } = await sb.auth.getSession();
    return data.session;
  },

  onAuth(cb) {
    sb.auth.onAuthStateChange((_event, session) => cb(session));
  },

  async signUp(username, password) {
    username = username.trim();
    if (!USERNAME_RE.test(username)) throw new Error("Usernames are 3–20 letters, numbers or underscores.");
    if (password.length < 6) throw new Error("Passwords need at least 6 characters.");
    const free = await rpc("username_available", { p_username: username });
    if (!free) throw new Error("That username is taken.");
    const { data, error } = await sb.auth.signUp({
      email: emailFor(username),
      password,
      options: { data: { username } },
    });
    if (error) throw new Error(error.message);
    if (!data.session) {
      throw new Error('Account created, but Supabase is asking for email confirmation. Turn off "Confirm email" in Supabase → Authentication → Sign In / Providers → Email, then log in.');
    }
    return data.session;
  },

  async logIn(username, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email: emailFor(username), password });
    if (error) throw new Error(error.message);
    return data.session;
  },

  async logOut() {
    await sb.auth.signOut();
  },

  async profile(userId) {
    const { data, error } = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },

  // Milliseconds to add to Date.now() to get the database clock.
  async clockOffset() {
    const t0 = Date.now();
    const server = await rpc("server_now");
    const t1 = Date.now();
    return new Date(server).getTime() - (t0 + t1) / 2;
  },

  async loadGame(id) {
    const [g, p, r] = await Promise.all([
      sb.from("games").select("*").eq("id", id).maybeSingle(),
      sb.from("game_players").select("*").eq("game_id", id).order("joined_at"),
      sb.from("rounds").select("*").eq("game_id", id).order("round_no", { ascending: false }).limit(1),
    ]);
    for (const res of [g, p, r]) if (res.error) throw new Error(res.error.message);
    return { game: g.data, players: p.data || [], round: r.data?.[0] || null };
  },

  // Calls onChange(table, row) whenever the game, its roster or its rounds change.
  subscribe(gameId, onChange, onStatus) {
    const ch = sb
      .channel(`game-${gameId}-${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "games", filter: `id=eq.${gameId}` },
        (e) => onChange("games", e.new, e.eventType))
      .on("postgres_changes", { event: "*", schema: "public", table: "game_players", filter: `game_id=eq.${gameId}` },
        (e) => onChange("game_players", e.eventType === "DELETE" ? e.old : e.new, e.eventType))
      .on("postgres_changes", { event: "*", schema: "public", table: "rounds", filter: `game_id=eq.${gameId}` },
        (e) => onChange("rounds", e.new, e.eventType))
      .subscribe((status) => onStatus?.(status));
    return () => sb.removeChannel(ch);
  },

  leaderboard(day = null) {
    return rpc("get_daily_leaderboard", { p_day: day });
  },
};

export const backendReady = () => Boolean(sb);
