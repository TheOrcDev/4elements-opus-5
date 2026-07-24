import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    // Honour PORT when the launcher assigns one, otherwise fall back to Vite's default.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: false,
  },
  build: {
    target: 'es2020',
  },
});
