import { defineConfig } from 'astro/config';

export default defineConfig({
  integrations: [],
  site: process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://fujitaxi-minamisoma.com',
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
