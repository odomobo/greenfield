import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // served by the gateway at /
  base: './',
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 8080,
    strictPort: true,
  },
})
