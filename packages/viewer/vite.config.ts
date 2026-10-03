import { defineConfig } from 'vite'

export default defineConfig({
  // served by the gateway under /desktop/
  base: './',
  server: {
    host: 'localhost',
    port: 8080,
    strictPort: true,
  },
})
