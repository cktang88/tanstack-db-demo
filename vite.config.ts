import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

const API_URL = process.env.API_URL ?? 'http://localhost:3001'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: API_URL, changeOrigin: true } },
  },
  preview: {
    port: 4173,
    proxy: { '/api': { target: API_URL, changeOrigin: true } },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: ['tests/server/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['tests/client/**/*.test.{ts,tsx}'],
          setupFiles: ['./tests/client/setup.ts'],
        },
      },
    ],
  },
  lint: {
    ignorePatterns: ['dist/**', 'data/**', 'playwright-report/**', 'test-results/**'],
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    ignorePatterns: ['dist/**', 'data/**', 'pnpm-lock.yaml'],
    singleQuote: true,
    semi: false,
    printWidth: 130,
  },
})
