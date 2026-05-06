import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_ALLOWED_HOSTS — comma-separated list of hostnames the dev server will
// accept (e.g. "anvil.example.com"). "all" disables the host check entirely.
// Only relevant for `npm run dev` (the production image uses nginx).
const allowedHostsEnv = process.env.VITE_ALLOWED_HOSTS?.trim() ?? 'all';
const allowedHosts: true | string[] =
  allowedHostsEnv === 'all'
    ? true
    : allowedHostsEnv.split(',').map((s: string) => s.trim()).filter(Boolean);

// VITE_API_PROXY_TARGET — where the dev-server's /api proxy forwards to.
// Defaults to localhost:4000 (the API running on the same host). Override
// when running the API in a container or on another machine.
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    allowedHosts,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api/, ''),
      },
    },
  },
});
