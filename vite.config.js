import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const API_TARGET = env.API_PROXY_TARGET || process.env.API_PROXY_TARGET || 'http://localhost:8787';
  const openaiModel = env.OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-5-nano';

  return {
    define: {
      'process.env.OPENAI_MODEL': JSON.stringify(openaiModel),
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: API_TARGET,
          changeOrigin: true,
        },
      },
    },
  };
});
