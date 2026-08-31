import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/OpenAI/' : '/',
  resolve: { dedupe: ['pixi.js'] },
});
