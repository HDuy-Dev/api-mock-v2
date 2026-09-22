// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test',
  testMatch: /.*\.spec\.js/,
  timeout: 30_000,
  workers: 1, // every test launches its own Chromium profile; keep resource use predictable
  fullyParallel: false,
  reporter: [['list']],
});
