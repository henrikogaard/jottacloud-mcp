import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test/ui",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1536, height: 1024 },
    colorScheme: "light",
  },
  webServer: {
    command: "npm run dev:ui -- --port 5173 --strictPort",
    url: "http://127.0.0.1:5173/qa.html",
    reuseExistingServer: !process.env.CI,
  },
});
