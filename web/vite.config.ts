import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The phase 1 server (`cd server && DEMOVIEWER_ASSETS=../assets cargo run --release
// -p demoviewer-server`) answers the API and the assets during `npm run dev`.
const server = 'http://127.0.0.1:8095';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': server,
      '/maps': server,
      '/players': server,
      '/weapons': server,
      '/viewmodels': server,
      '/effects': server,
      '/sounds': server,
    },
  },
  test: {
    // Component tests are .tsx and pick a DOM per file (`// @vitest-environment jsdom`); the
    // rest run in node.
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    // After vitest's own summary, what was skipped for want of local data (a real match's pack,
    // the built assets) and the variable that gives it.
    reporters: ['default', './test/helpers/skipped-reporter.ts'],
  },
});
