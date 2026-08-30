import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { dedupe: ['pixi.js'] },
});
