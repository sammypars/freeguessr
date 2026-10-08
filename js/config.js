// FreeGuessr settings. All three keys below are designed to be public
// (they ship to every browser), so it is safe to commit them.
// See README.md for where to find each one.
export const CONFIG = {
  // Supabase → Project Settings → API → Project URL
  SUPABASE_URL: "",
  // Supabase → Project Settings → API → "anon" / publishable key
  SUPABASE_ANON_KEY: "",
  // mapillary.com/dashboard/developers → your app → "Client Token" (starts with MLY|)
  MAPILLARY_TOKEN: "",

  // Players sign in with a username. Supabase needs an email under the hood,
  // so we make one up as <username>@<this domain>. It must be a real domain
  // (Supabase checks it exists); no mail is ever sent to it.
  AUTH_EMAIL_DOMAIN: "sammypars.github.io",
};

export const isConfigured = () =>
  Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY && CONFIG.MAPILLARY_TOKEN);
