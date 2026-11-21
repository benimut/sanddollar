import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'path';

const basePath = process.env.VITE_BASE_PATH || '/';

/** 由 package.json 安全讀取建置期應用程式版本號 */
function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, './package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // 讀取失敗時退回預設版本字串
  }
  return '1.0.0';
}

/** 擷取建置當下之 Git Commit 7 碼短碼（優先使用 CI 注入之 GITHUB_SHA） */
function readGitShortSha(): string {
  const envSha = (process.env.GITHUB_SHA || '').trim();
  if (/^[0-9a-f]{7,40}$/i.test(envSha)) {
    return envSha.slice(0, 7);
  }
  try {
    const out = execSync('git rev-parse --short=7 HEAD', {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
    if (/^[0-9a-f]{7,40}$/i.test(out)) {
      return out.slice(0, 7);
    }
  } catch {
    // 非 Git 工作目錄環境下安全略過
  }
  return '';
}

const baseVersion = readPackageVersion();
const gitShortSha = readGitShortSha();
const appVersion = gitShortSha ? `${baseVersion} (${gitShortSha})` : baseVersion;

// https://vitejs.dev/config/
export default defineConfig({
  base: basePath,
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png'],
      workbox: {
        // 排除後端 API 與 Cloudflare Access 驗證端點，避免 Service Worker 攔截登入或辨識請求
        navigateFallbackDenylist: [/^\/api\//, /^\/cdn-cgi\//],
      },
      manifest: {
        name: 'Sand Dollar',
        short_name: 'Sand Dollar',
        description: '手機記帳應用程式 (PWA)，支援發票掃描、回饋登記與海外消費',
        theme_color: '#0d9488',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: basePath,
        scope: basePath,
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      }
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  // @ts-expect-error vitest 配置
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['tests/unit/**/*.{test,spec}.ts'],
    fileParallelism: false,
  }
});
