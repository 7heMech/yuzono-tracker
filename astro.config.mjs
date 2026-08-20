import { defineConfig, fontProviders } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import svelte from '@astrojs/svelte';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    // Keep local D1/KV state on disk between `astro dev` runs so the seeded
    // source catalogue and test reports survive a restart.
    persistState: true,
  }),
  integrations: [svelte()],
  prefetch: { prefetchAll: true, defaultStrategy: 'viewport' },
  devToolbar: { enabled: false },

  // Self-hosted via Workers Assets — no runtime request to Google. This
  // audience is privacy-sensitive and the site ships a strict CSP.
  fonts: [
    {
      provider: fontProviders.google(),
      name: 'IBM Plex Sans',
      cssVariable: '--font-ui-family',
      weights: [400, 500, 600],
      styles: ['normal'],
      subsets: ['latin', 'latin-ext'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
    {
      provider: fontProviders.google(),
      name: 'IBM Plex Mono',
      cssVariable: '--font-data-family',
      weights: [400, 500, 600],
      styles: ['normal'],
      subsets: ['latin'],
      fallbacks: ['ui-monospace', 'monospace'],
    },
  ],
});
