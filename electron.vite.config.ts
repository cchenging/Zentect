import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@modules': resolve('src/modules')
      }
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['better-sqlite3', 'electron-log']
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@modules': resolve('src/modules')
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@modules': resolve('src/modules')
      }
    },
    server: {
      watch: {
        ignored: [
          '**/data/**',
          '**/logs/**',
          '**/cache/**',
          '**/*.sqlite',
          '**/*.sqlite-journal'
        ]
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        external: ['better-sqlite3']
      }
    },
    optimizeDeps: {
      exclude: ['better-sqlite3']
    }
  }
})
