import { defineConfig, devices } from '@playwright/test';

// Smoke tests against a running phase 1 server (`cd server && DEMOVIEWER_ASSETS=../assets
// DEMOVIEWER_WEB=../web/dist demoviewer-server`), or the dev server with
// DEMOVIEWER_E2E_URL=http://127.0.0.1:5173. Specs skip unless DEMOVIEWER_E2E_DEMO is set.
//
// Chromium gets the GPU through ANGLE/Vulkan instead of SwiftShader, and an uncapped frame
// rate so `scene.stats.fps` measures what the page can draw, not the 60 Hz headless vsync. It is
// muted: the sound specs play cues, and a test never plays through the machine's speakers.
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  timeout: 120_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: process.env.DEMOVIEWER_E2E_URL ?? 'http://127.0.0.1:8095',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 2560, height: 1440 },
        deviceScaleFactor: 1,
        launchOptions: {
          args: [
            '--mute-audio',
            '--ignore-gpu-blocklist',
            '--enable-gpu',
            '--use-angle=vulkan',
            '--enable-features=Vulkan',
            '--disable-gpu-vsync',
            '--disable-frame-rate-limit',
          ],
        },
      },
    },
  ],
});
