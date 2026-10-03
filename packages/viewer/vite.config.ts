import { defineConfig } from 'vite'

export default defineConfig({
  // served by the gateway at /
  base: './',
  server: {
    host: 'localhost',
    port: 8080,
    strictPort: true,
  },
})
