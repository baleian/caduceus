/** Settings tab (F7/Q4=A): soul editor, skills toggles (optimistic with
 * revert — WPT-7), toolsets list editor (lossless round-trip — PU4-5),
 * approvals mode, token rotation. Every successful edit posts the
 * gateway-restart banner (S6). */

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { ApiError } from '../../api/client'
import { ConfirmModal } from '../../components/ConfirmModal'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { INPUT_CLASS, INPUT_MONO_CLASS } from '../../components/ui/Field'
import { Switch } from '../../components/ui/Switch'
import { MAX_SOUL_BYTES, parseToolsetsText, renderToolsetsText, utf8Bytes } from '../../lib/forms'
import type { ApprovalsMode } from '../../lib/types'
import { useApp } from '../../state/AppStore'

interface Skill {
  name: string
  enabled: boolean
}

export function SettingsTab(props: { agent: string }): ReactNode {
  const { client, toast } = useApp()
  const [soul, setSoul] = useState('')
  const [soulDirty, setSoulDirty] = useState(false)
  const [skills, setSkills] = useState<Skill[]>([])
  const [toolsetsText, setToolsetsText] = useState('')
  const [toolsetsDirty, setToolsetsDirty] = useState(false)
  const [approvals, setApprovals] = useState<ApprovalsMode>('off')
  const [allowPrivateUrls, setAllowPrivateUrls] = useState(false)
  const [needsRestart, setNeedsRestart] = useState(false)
  const [rotateOpen, setRotateOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [soulRes, skillsRes, toolsetsRes, approvalsRes, allowRes] = await Promise.all([
        client.getSoul(props.agent),
        client.getSkills(props.agent),
        client.getToolsets(props.agent),
        client.getApprovals(props.agent),
        client.getAllowPrivateUrls(props.agent),
      ])
      setSoul(soulRes.content)
      setSkills(skillsRes.skills)
      setToolsetsText(renderToolsetsText(toolsetsRes.toolsets))
      setApprovals(approvalsRes.mode)
      setAllowPrivateUrls(allowRes.allow_private_urls)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.message : 'failed to load settings')
    }
  }, [client, props.agent])

  useEffect(() => {
    void load()
  }, [load])

  function editApplied(): void {
    setNeedsRestart(true)
  }

  async function saveSoul(): Promise<void> {
    if (utf8Bytes(soul) > MAX_SOUL_BYTES) {
      toast('error', 'soul exceeds the 512KB editor cap')
      return
    }
    try {
      await client.putSoul(props.agent, soul)
      setSoulDirty(false)
      editApplied()
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'soul save failed')
    }
  }

  async function toggleSkill(skill: Skill): Promise<void> {
    // optimistic single-field toggle; revert on failure (WPT-7)
    setSkills((list) =>
      list.map((s) => (s.name === skill.name ? { ...s, enabled: !s.enabled } : s)),
    )
    try {
      await client.toggleSkill(props.agent, skill.name, !skill.enabled)
      editApplied()
    } catch (error) {
      setSkills((list) =>
        list.map((s) => (s.name === skill.name ? { ...s, enabled: skill.enabled } : s)),
      )
      toast('error', error instanceof ApiError ? error.message : 'skill toggle failed')
    }
  }

  async function saveToolsets(): Promise<void> {
    try {
      await client.putToolsets(props.agent, parseToolsetsText(toolsetsText))
      setToolsetsText(renderToolsetsText(parseToolsetsText(toolsetsText))) // canonical fixpoint
      setToolsetsDirty(false)
      editApplied()
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'toolsets save failed')
    }
  }

  async function saveApprovals(mode: ApprovalsMode): Promise<void> {
    const previous = approvals
    setApprovals(mode)
    try {
      await client.putApprovals(props.agent, mode)
      editApplied()
    } catch (error) {
      setApprovals(previous)
      toast('error', error instanceof ApiError ? error.message : 'approvals save failed')
    }
  }

  async function saveAllowPrivateUrls(allow: boolean): Promise<void> {
    const previous = allowPrivateUrls
    setAllowPrivateUrls(allow) // optimistic (WPT-7); revert on failure
    try {
      await client.putAllowPrivateUrls(props.agent, allow)
      editApplied()
    } catch (error) {
      setAllowPrivateUrls(previous)
      toast('error', error instanceof ApiError ? error.message : 'private-URL policy save failed')
    }
  }

  async function rotate(): Promise<void> {
    setRotateOpen(false)
    try {
      await client.rotateToken(props.agent)
      toast('info', 'gateway token rotated — restart the agent gateway to apply')
      editApplied()
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'token rotation failed')
    }
  }

  async function restart(): Promise<void> {
    try {
      await client.stopAgent(props.agent)
      await client.startAgent(props.agent)
      setNeedsRestart(false)
      toast('info', 'gateway restart requested')
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'restart failed')
    }
  }

  if (loadError) {
    return <p className="text-sm text-bad">{loadError}</p>
  }

  const enabledCount = skills.filter((s) => s.enabled).length

  return (
    <div className="space-y-4">
      {needsRestart && (
        <div
          data-testid="settings-restart-banner"
          className="flex items-center justify-between rounded-xl border border-warn/50 bg-warn/10 px-4 py-2.5 text-sm"
        >
          <span>Changes saved — the agent gateway must restart to pick them up (S6).</span>
          <button
            data-testid="settings-restart-button"
            className="rounded-lg bg-warn px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
            onClick={() => void restart()}
          >
            Restart now
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Persona (SOUL.md)"
            subtitle={`${utf8Bytes(soul)} bytes / 512KB`}
            actions={
              <Button
                testId="settings-soul-save-button"
                disabled={!soulDirty}
                onClick={() => void saveSoul()}
              >
                Save persona
              </Button>
            }
          />
          <textarea
            data-testid="settings-soul-editor"
            rows={8}
            className={INPUT_MONO_CLASS}
            value={soul}
            onChange={(e) => {
              setSoul(e.target.value)
              setSoulDirty(true)
            }}
          />
        </Card>

        <Card>
          <CardHeader
            title="Toolsets"
            subtitle="api_server platform — one toolset per line"
            actions={
              <Button
                testId="settings-toolsets-save-button"
                disabled={!toolsetsDirty}
                onClick={() => void saveToolsets()}
              >
                Save toolsets
              </Button>
            }
          />
          <textarea
            data-testid="settings-toolsets-editor"
            rows={6}
            placeholder="one toolset per line"
            className={INPUT_MONO_CLASS}
            value={toolsetsText}
            onChange={(e) => {
              setToolsetsText(e.target.value)
              setToolsetsDirty(true)
            }}
          />
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Skills"
          subtitle={
            skills.length === 0 ? undefined : `${enabledCount} of ${skills.length} enabled`
          }
        />
        {skills.length === 0 ? (
          <p className="text-sm text-ink-dim">No skills found for this profile.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {skills.map((skill) => (
              <div
                key={skill.name}
                className="flex items-center justify-between gap-2 rounded-lg border border-edge bg-panel-2 px-3 py-2"
              >
                <span className="min-w-0 truncate font-mono text-xs">{skill.name}</span>
                <Switch
                  testId={`settings-skill-${skill.name}-toggle`}
                  checked={skill.enabled}
                  onChange={() => void toggleSkill(skill)}
                  aria-label={`toggle ${skill.name}`}
                />
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card padded={false}>
        <div className="divide-y divide-edge">
          <PolicyRow
            title="Approvals mode"
            description="tool-approval policy rendered into the managed config"
          >
            <select
              data-testid="settings-approvals-select"
              className={`${INPUT_CLASS} w-auto`}
              value={approvals}
              onChange={(e) => void saveApprovals(e.target.value as ApprovalsMode)}
            >
              <option value="off">off (unattended)</option>
              <option value="smart">smart</option>
              <option value="manual">manual</option>
            </select>
          </PolicyRow>

          <PolicyRow
            title="Browser private URLs"
            description="let the browser tool reach localhost / private addresses (SSRF opt-in)"
          >
            <Switch
              testId="settings-allow-private-urls-toggle"
              aria-label="Browser private URLs"
              checked={allowPrivateUrls}
              onColor="ok"
              size="md"
              onChange={(next) => void saveAllowPrivateUrls(next)}
              label={allowPrivateUrls ? 'allowed' : 'blocked'}
            />
          </PolicyRow>

          <PolicyRow
            title="Gateway token"
            description="rotate re-issues the proxy credential into the profile .env — the plaintext is never displayed (S3)"
          >
            <Button
              variant="outline"
              testId="settings-token-rotate-button"
              onClick={() => setRotateOpen(true)}
            >
              Rotate token
            </Button>
          </PolicyRow>
        </div>
      </Card>

      <ConfirmModal
        open={rotateOpen}
        title="Rotate gateway token"
        body="The old token stops working immediately; the agent gateway must restart to load the new one."
        confirmLabel="Rotate"
        onConfirm={() => void rotate()}
        onCancel={() => setRotateOpen(false)}
      />
    </div>
  )
}

function PolicyRow(props: { title: string; description: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-3">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{props.title}</h3>
        <p className="mt-0.5 text-xs text-ink-dim">{props.description}</p>
      </div>
      <div className="shrink-0">{props.children}</div>
    </div>
  )
}
