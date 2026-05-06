import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_ALLOWED_HOSTS — comma-separated list of hostnames the dev server will
// accept (e.g. "anvil.example.com,anvil.staging.example.com"). Set to "all"
// to disable the check entirely. Defaults to "all" because in production we
// expose this behind an Ingress whose routing already gates access.
const allowedHostsEnv = process.env.VITE_ALLOWED_HOSTS?.trim() ?? 'all';
const allowedHosts: true | string[] =
  allowedHostsEnv === 'all'
    ? true
    : allowedHostsEnv.split(',').map((s) => s.trim()).filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    allowedHosts,
  },
});
