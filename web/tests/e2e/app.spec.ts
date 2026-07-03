/** F11 browser E2E (완료 기준): token gate → create (job progress) →
 * lifecycle → settings edit → chat (stream / stop / approval / session
 * management / re-hydration) → gateway hot-swap → logs → remove (X-Confirm).
 * Scenarios run in order against one daemon (workers: 1). */

import { expect, test } from '@playwright/test'

const TOKEN = 'e2e-test-token'
const AGENT = 'e2e-agent'

test.describe.configure({ mode: 'serial' })

test('rejects a wrong token and locks the app (W3)', async ({ page }) => {
  await page.goto('/#token=wrong-token')
  await expect(page.getByTestId('token-gate-error')).toBeVisible()
})

test('accepts the fragment token and scrubs it from the URL (Q1=A)', async ({ page }) => {
  // redesign Q2=A: `/` lands on the dashboard
  await page.goto(`/#token=${TOKEN}`)
  await expect(page.getByTestId('dashboard-page')).toBeVisible()
  expect(page.url()).not.toContain(TOKEN)
  await expect(page.getByTestId('shell-connection-badge')).toContainText('connected')
  await page.getByTestId('nav-agents-link').click()
  await expect(page.getByTestId('agents-empty-note')).toBeVisible()
})

test('creates an agent through the form and watches the job to done (S-U4-1)', async ({ page }) => {
  await page.goto(`/agents#token=${TOKEN}`)
  await page.getByTestId('agents-create-toggle-button').click()
  await page.getByTestId('agent-create-name-input').fill(AGENT)
  await page.getByTestId('agent-create-advanced-toggle').click()
  await page.getByTestId('agent-create-persona-input').fill('You are the e2e test agent.')
  await page.getByTestId('agent-create-submit-button').click()

  const job = page.getByTestId('job-progress-card')
  await expect(job).toBeVisible()
  await expect(page.getByTestId('job-progress-state')).toHaveText('done', { timeout: 20_000 })
  await expect(page.getByTestId(`agents-row-${AGENT}-link`)).toBeVisible()
  await expect(page.getByTestId(`agents-row-${AGENT}-process-badge`)).toHaveText('running', {
    timeout: 15_000,
  })
})

test('client-side validation mirrors the server name rule (W4)', async ({ page }) => {
  await page.goto(`/agents#token=${TOKEN}`)
  await page.getByTestId('agents-create-toggle-button').click()
  await page.getByTestId('agent-create-name-input').fill('Invalid Name!')
  await page.getByTestId('agent-create-submit-button').click()
  await expect(page.getByTestId('agent-create-form')).toContainText('must match')
})

test('lifecycle: stop then start reflects via WS events (S-U4-2)', async ({ page }) => {
  await page.goto(`/agents/${AGENT}#token=${TOKEN}`)
  await expect(page.getByTestId('agent-detail-title')).toHaveText(AGENT)

  await page.getByTestId('agent-detail-stop-button').click()
  await expect(page.getByTestId('agent-detail-process-badge')).toHaveText(/stopped|not-running/, {
    timeout: 15_000,
  })
  await page.getByTestId('agent-detail-start-button').click()
  await expect(page.getByTestId('agent-detail-process-badge')).toHaveText('running', {
    timeout: 15_000,
  })
})

test('settings: soul edit posts the restart banner; approvals + toolsets save (F7/S6)', async ({
  page,
}) => {
  await page.goto(`/agents/${AGENT}#token=${TOKEN}`)
  await page.getByTestId('agent-detail-tab-settings').click()

  const soul = page.getByTestId('settings-soul-editor')
  await expect(soul).toHaveValue(/e2e test agent/, { timeout: 10_000 })
  await soul.fill('You are the e2e test agent. Edited.')
  await page.getByTestId('settings-soul-save-button').click()
  await expect(page.getByTestId('settings-restart-banner')).toBeVisible()

  await page.getByTestId('settings-toolsets-editor').fill('terminal\nweb')
  await page.getByTestId('settings-toolsets-save-button').click()
  await page.getByTestId('settings-approvals-select').selectOption('manual')
  await expect(page.getByTestId('settings-restart-banner')).toBeVisible()
})

test('logs tab renders snapshot + follow toggle (Q8=A)', async ({ page }) => {
  await page.goto(`/agents/${AGENT}#token=${TOKEN}`)
  await page.getByTestId('agent-detail-tab-logs').click()
  await page.getByTestId('logs-refresh-button').click()
  await expect(page.getByTestId('logs-output')).toBeVisible()
  await page.getByTestId('logs-follow-toggle').check()
  await expect(page.getByTestId('logs-follow-toggle')).toBeChecked()
})

test('chat: type with no session — one is created automatically (CLI parity), streamed reply, server re-hydration (W7)', async ({
  page,
}) => {
  await page.goto(`/chat/${AGENT}#token=${TOKEN}`)
  // no session exists and none is created up front — the composer is live
  const composer = page.getByTestId('chat-composer-input')
  await expect(composer).toBeEnabled()

  await composer.fill('hello there')
  await page.getByTestId('chat-send-button').click()
  await expect(page.getByTestId('chat-transcript')).toContainText('Hello from fake agent.', {
    timeout: 15_000,
  })
  // the lazily created session is now in the sidebar
  await expect(page.getByTestId('chat-session-list').locator('li')).toHaveCount(1)
  // after the turn the transcript is re-hydrated from the session store:
  // reload and expect the same content straight from the server (W7)
  await page.reload()
  await expect(page.getByTestId('chat-transcript')).toContainText('hello there')
  await expect(page.getByTestId('chat-transcript')).toContainText('Hello from fake agent.', {
    timeout: 10_000,
  })
})

test('chat: stop interrupts a slow turn exactly once (PU4-2)', async ({ page }) => {
  await page.goto(`/chat/${AGENT}#token=${TOKEN}`)
  const composer = page.getByTestId('chat-composer-input')
  await expect(composer).toBeEnabled({ timeout: 10_000 })
  await composer.fill('slow burn please')
  await page.getByTestId('chat-send-button').click()

  await expect(page.getByTestId('chat-live-turn')).toContainText('tick0', { timeout: 10_000 })
  await page.getByTestId('chat-stop-button').click()
  await expect(page.getByTestId('chat-system-note').first()).toContainText('stopping', {
    timeout: 5_000,
  })
  // turn ends, composer comes back
  await expect(page.getByTestId('chat-send-button')).toBeVisible({ timeout: 15_000 })
})

test('chat: approval card resolves the run (F6)', async ({ page }) => {
  await page.goto(`/chat/${AGENT}#token=${TOKEN}`)
  const composer = page.getByTestId('chat-composer-input')
  await expect(composer).toBeEnabled({ timeout: 10_000 })
  await composer.fill('please approve this')
  await page.getByTestId('chat-send-button').click()

  await expect(page.getByTestId('chat-approval-card')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('chat-approval-once-button').click()
  await expect(page.getByTestId('chat-transcript')).toContainText('tool ran fine', {
    timeout: 15_000,
  })
})

test('chat: session rename and delete (Q5=B)', async ({ page }) => {
  await page.goto(`/chat/${AGENT}#token=${TOKEN}`)
  await page.getByTestId('chat-new-session-button').click()
  const sessionList = page.getByTestId('chat-session-list')
  await expect(sessionList.locator('li').first()).toBeVisible()

  // rename the newest (first) session
  await sessionList.locator('li').first().hover()
  await sessionList.locator('[data-testid$="-rename-button"]').first().click()
  await page.getByTestId('chat-rename-input').fill('renamed-e2e')
  await page.getByTestId('confirm-modal-confirm-button').click()
  await expect(sessionList).toContainText('renamed-e2e')

  // delete it
  await sessionList.locator('li').first().hover()
  await sessionList.locator('[data-testid$="-delete-button"]').first().click()
  await page.getByTestId('confirm-modal-confirm-button').click()
  await expect(sessionList).not.toContainText('renamed-e2e')
})

test('gateway: hot-swaps the upstream and shows traffic tables (F4)', async ({ page }) => {
  await page.goto(`/gateway#token=${TOKEN}`)
  const url = page.getByTestId('gateway-upstream-url-input')
  await expect(url).toHaveValue(/upstream\.test/)
  await url.fill('http://upstream-b.test/v1')
  await page.getByTestId('gateway-upstream-save-button').click()
  await expect(page.getByTestId('toast-area')).toContainText('upstream swapped')
  await expect(url).toHaveValue('http://upstream-b.test/v1')
  await expect(page.getByTestId('gateway-traffic-table')).toBeVisible()
})

test('system: deep status and job history render (Q2=A)', async ({ page }) => {
  await page.goto(`/system#token=${TOKEN}`)
  await expect(page.getByTestId('system-deep-status')).toContainText(AGENT)
  await expect(page.getByTestId('system-jobs-table')).toContainText('create')
})

test('remove: typed X-Confirm gate, job runs, list empties (W1)', async ({ page }) => {
  await page.goto(`/agents/${AGENT}#token=${TOKEN}`)
  await page.getByTestId('agent-detail-remove-button').click()

  const confirm = page.getByTestId('confirm-modal-confirm-button')
  await expect(confirm).toBeDisabled()
  await page.getByTestId('confirm-modal-name-input').fill('wrong-name')
  await expect(confirm).toBeDisabled()
  await page.getByTestId('confirm-modal-name-input').fill(AGENT)
  await confirm.click()

  // remove job runs and we land back on the empty agents list
  await expect(page.getByTestId('agents-empty-note')).toBeVisible({ timeout: 20_000 })
})
