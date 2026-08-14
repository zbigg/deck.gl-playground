import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // gh-pages serves the app from /<repo>/, mydevil from the domain root — a
  // relative base works for both, so only the gh-pages build overrides it.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  server: { host: true },
  // Sandbox with OSS sources — always ship source maps for devtools debugging.
  build: { sourcemap: true }
});
