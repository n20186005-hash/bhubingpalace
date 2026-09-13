import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  site: 'https://bhubingpalace.com',
  // Pages are prerendered to static assets; live data (weather) is rendered
  // on-demand on Cloudflare Workers via server islands.
  output: 'static',
  adapter: cloudflare({
    imageService: 'compile',
  }),
  i18n: {
    defaultLocale: 'th',
    locales: ['th', 'ko', 'zh', 'en', 'ja', 'mnw', 'my', 'shn'],
    routing: {
      prefixDefaultLocale: true,
    },
  },
  // Single canonical URL shape: every route is served at a trailing-slash path
  // (`/en/`, `/fr`-style paths never exist), so `/en` and `/en/` stop competing.
  trailingSlash: 'always',
  build: {
    inlineStylesheets: 'auto',
  },
  vite: {
    plugins: [tailwindcss()],
    build: {
      cssMinify: 'lightningcss',
    },
  },
});
