import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'
import { fileURLToPath, URL } from 'node:url'

const brandedElectronModule = fileURLToPath(
  new URL('./scripts/electron-dev-path.cjs', import.meta.url)
)
const startBrandedElectron = ({ startup }) =>
  startup(['.'], undefined, brandedElectronModule)

export default defineConfig(({ command }) => {
  const isDev = command === 'serve'

  return {
    base: './',
    plugins: [
      vue(),
      tailwindcss(),
      electron({
        main: {
          entry: 'electron/main.js',
          onstart: startBrandedElectron,
          vite: {
            build: {
              outDir: 'dist-electron',
              sourcemap: isDev,
              minify: !isDev,
              rollupOptions: { external: ['electron'] },
            },
          },
        },
        preload: {
          input: 'electron/preload.js',
          onstart(args) {
            if (process.electronApp) args.reload()
            else startBrandedElectron(args)
          },
          vite: {
            build: {
              outDir: 'dist-electron',
              sourcemap: isDev ? 'inline' : false,
              minify: !isDev,
              rollupOptions: {
                external: ['electron'],
                output: {
                  entryFileNames: '[name].cjs',
                  format: 'cjs',
                },
              },
            },
          },
        },
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    clearScreen: false,
  }
})
