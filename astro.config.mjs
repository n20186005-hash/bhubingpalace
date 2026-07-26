import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://bhubingpalace.com',
  output: 'static',
  i18n: {
    defaultLocale: 'th',
    locales: ['zh', 'en', 'my', 'shn', 'mnw', 'ja', 'ko', 'th'],
    routing: {
      prefixDefaultLocale: true,
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
