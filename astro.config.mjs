import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://fujitaxi-minamisoma.com',
  compressHTML: true,
  build: {
    inlineStylesheets: 'auto',
  },
  vite: {
    build: {
      cssMinify: true,
    },
  },
});
