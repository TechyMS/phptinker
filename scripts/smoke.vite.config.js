import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {alias: {'@': path.resolve('src')}},
  build: {outDir: 'smoke-dist', rolldownOptions: {input: 'scripts/monaco-smoke.html'}},
})
