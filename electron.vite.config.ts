import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite' // ⚡ Tailwind v4 Vite 插件替代 PostCSS 管道，CSS 编译更快

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@modules': resolve('src/modules'),
        '@shared': resolve('src/shared')
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
        '@modules': resolve('src/modules'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@modules': resolve('src/modules'),
        '@shared': resolve('src/shared')
      }
    },
    // ⚡⚡ 启动性能优化（关键）：
    //    1. cacheDir 显式固定到 node_modules/.vite，避免被外部脚本误清
    //    2. server.fs.strict=false 让 vite 不校验文件白名单，省去大量 stat 调用
    //    3. server.watch.usePolling=false Windows 默认 polling 会拖慢编译
    //    4. server.host='localhost' 避免 DNS 解析延迟
    cacheDir: resolve('node_modules/.vite'),
    server: {
      host: 'localhost',
      // 🔧 端口从 5173 改为 8173：Windows Hyper-V/WSL2 动态保留端口范围 5152-5251
      //    覆盖了 5173 导致 EACCES 权限拒绝。8173 远离保留范围，避免冲突。
      //    strictPort: false：端口被占时自动递增（8174/8175...），避免 TIME_WAIT 残留导致启动失败
      port: 8173,
      strictPort: false,
      fs: {
        strict: false
      },
      watch: {
        usePolling: false,
        interval: 1000,
        binaryInterval: 1500,
        ignored: [
          // ⚡ 补全排除 Python 虚拟环境与临时文件，防止 Watcher 监听几十万个 Python 库文件卡死 CPU
          '**/.venv/**',
          '**/venv/**',
          '**/data/**',
          '**/logs/**',
          '**/cache/**',
          '**/*.sqlite',
          '**/*.sqlite-journal',
          '**/out/**',
          '**/dist/**',
          '**/.verify-py312/**',
          '**/resources/**',
          '**/.git/**',
          '**/node_modules/.pnpm/**'
        ]
      },
      // ❌ 删除了 preTransformRequests: false！
      // 恢复 Vite 默认的并发预编译（Pre-transform），把单线程串行加载还原为百线程并发加载！
      warmup: {
        clientFiles: []
      }
    },
    plugins: [
      tailwindcss(),
      react(),
      // 🔍 启动诊断：记录所有 HTTP 请求，定位前端是否请求了 main.tsx
      {
        name: 'request-logger',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = req.url || ''
            // 只记录关键请求（排除 HMR websocket 和 .vite/deps）
            if (!url.startsWith('/@') && !url.includes('node_modules/.vite/deps')) {
              const ts = new Date().toISOString().substring(11, 23)
              console.log(`[REQ ${ts}] ${req.method} ${url}`)
            }
            next()
          })
        }
      }
    ],
    build: {
      rollupOptions: {
        external: ['better-sqlite3']
      }
    },
    // ⚡⚡ 预打包策略：
    optimizeDeps: {
      exclude: ['better-sqlite3', 'sharp', '@electron-toolkit/preload'],
      include: [
        // React 核心栈
        'react',
        'react-dom',
        'react-dom/client',
        'react-router-dom',
        'react-hot-toast',
        // 状态管理
        'zustand',
        // UI 库
        'lucide-react',
        'clsx',
        'tailwind-merge',
        'class-variance-authority',
        // Radix UI（首屏 AppSidebar / TitleBar / AuthModal 等同步链路会用）
        '@radix-ui/react-dialog',
        '@radix-ui/react-dropdown-menu',
        '@radix-ui/react-popover',
        '@radix-ui/react-select',
        '@radix-ui/react-slot',
        '@radix-ui/react-avatar',
        '@radix-ui/react-checkbox',
        '@radix-ui/react-slider',
        // 数据/工具
        'date-fns',
        'fast-deep-equal',
        'uuid',
        'zod'
      ],
      esbuildOptions: {
        target: 'es2022',
        logLevel: 'error'
      }
    }
  }
})