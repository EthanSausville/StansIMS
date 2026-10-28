// Serves the static site from ./public, plus /config.js, which hands the
// browser the Supabase project URL and publishable (anon) key from the
// Worker's variables. Both values are public by design: the database is
// protected by sign-in and row-level security, not by hiding them.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/config.js') {
      const config = {
        supabaseUrl: env.SUPABASE_URL || env.VITE_SUPABASE_URL || '',
        supabaseKey: env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || '',
      };
      return new Response(`window.STANS_CONFIG = ${JSON.stringify(config)};\n`, {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
