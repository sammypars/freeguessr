// FreeGuessr settings. All three keys below are designed to be public
// (they ship to every browser), so it is safe to commit them.
// See README.md for where to find each one.
export const CONFIG = {
  // Supabase → Project Settings → API → Project URL
  SUPABASE_URL: "https://ytpntumuvbwghhpcucah.supabase.co",
  // Supabase → Project Settings → API → "anon" / publishable key
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl0cG50dW11dmJ3Z2hocGN1Y2FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0NzAzNTAsImV4cCI6MjEwNzA0NjM1MH0.RdK-nocg8kkQrpd05cR3SPzTKNl4TC3s_A-dlrDIK8c",
  // mapillary.com/dashboard/developers → your app → "Client Token" (starts with MLY|)
  MAPILLARY_TOKEN: "MLY|29285126044512160|97b073e77b16810cc110ee48aa5c314f",

  // Players sign in with a username. Supabase needs an email under the hood,
  // so we make one up as <username>@<this domain>. It must be a real domain
  // (Supabase checks it exists); no mail is ever sent to it.
  AUTH_EMAIL_DOMAIN: "sammypars.github.io",
};

export const isConfigured = () =>
  Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY && CONFIG.MAPILLARY_TOKEN);
