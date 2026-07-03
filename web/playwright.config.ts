import { defineConfig } from '@playwright/test'

// F11 browser E2E against the real composed daemon over fake hermes
// (tests/e2e_support/fake_daemon.py). Build web_dist before running.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1, // one shared daemon — scenarios share registry state
  use: {
    baseURL: 'http://127.0.0.1:43285',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'uv run python -m tests.e2e_support.fake_daemon',
    cwd: '..',
    url: 'http://127.0.0.1:43285/healthz',
    reuseExistingServer: !process.env['CI'],
    timeout: 30_000,
  },
})
