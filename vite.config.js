import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    proxy: {
      '/api': {
        target: `http://${process.env.SPELL_BACKEND_HOST || '127.0.0.1'}:${Number(process.env.SPELL_BACKEND_PORT || 8787)}`,
        changeOrigin: true,
      },
    },
  },
});
