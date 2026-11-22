import { defineConfig } from 'vite'

// GLASSES_BASE=/glasses/ when building for the hosted site (the landing page owns "/").
export default defineConfig({
  base: process.env.GLASSES_BASE ?? '/',
  server: { host: true, port: 5173 },
  build: { target: 'esnext', outDir: process.env.GLASSES_OUT ?? 'dist' },
})
