/** Settings tab (F7/Q4=A): soul editor, skills toggles (optimistic with
 * revert — WPT-7), toolsets list editor (lossless round-trip — PU4-5),
 * approvals mode, token rotation. Every successful edit posts the
 * gateway-restart banner (S6). */

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { ApiError } from '../../api/client'
import { ConfirmModal } from '../../components/ConfirmModal'
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
  const [needsRestart, setNeedsRestart] = useState(false)
  const [rotateOpen, setRotateOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [soulRes, skillsRes, toolsetsRes, approvalsRes] = await Promise.all([
        client.getSoul(props.agent),
        client.getSkills(props.agent),
        client.getToolsets(props.agent),
        client.getApprovals(props.agent),
      ])
      setSoul(soulRes.content)
      setSkills(skillsRes.skills)
      setToolsetsText(renderToolsetsText(toolsetsRes.toolsets))
      setApprovals(approvalsRes.mode)
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

  return (
    <div className="space-y-5">
      {needsRestart && (
        <div
          data-testid="settings-restart-banner"
          className="flex items-center justify-between rounded border border-warn/50 bg-warn/10 px-3 py-2 text-sm"
        >
          <span>Changes saved — the agent gateway must restart to pick them up (S6).</span>
          <button
            data-testid="settings-restart-button"
            className="rounded bg-warn px-3 py-1 text-sm font-medium text-white"
            onClick={() => void restart()}
          >
            Restart now
          </button>
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Persona (SOUL.md)</h2>
        <textarea
          data-testid="settings-soul-editor"
          rows={10}
          className="w-full rounded border border-edge bg-panel p-3 font-mono text-sm"
          value={soul}
          onChange={(e) => {
            setSoul(e.target.value)
            setSoulDirty(true)
          }}
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="text-xs text-ink-dim">{utf8Bytes(soul)} bytes / 512KB</span>
          <button
            data-testid="settings-soul-save-button"
            disabled={!soulDirty}
            className="rounded bg-accent-strong px-3 py-1 text-sm font-medium text-white disabled:opacity-40"
            onClick={() => void saveSoul()}
          >
            Save persona
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Skills</h2>
        {skills.length === 0 ? (
          <p className="text-sm text-ink-dim">No skills found for this profile.</p>
        ) : (
          <ul className="divide-y divide-edge rounded border border-edge bg-panel">
            {skills.map((skill) => (
              <li key={skill.name} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="font-mono">{skill.name}</span>
                <button
                  data-testid={`settings-skill-${skill.name}-toggle`}
                  role="switch"
                  aria-checked={skill.enabled}
                  onClick={() => void toggleSkill(skill)}
                  className={`rounded-full px-3 py-0.5 text-xs font-medium ${
                    skill.enabled ? 'bg-ok/20 text-ok' : 'bg-ink-dim/15 text-ink-dim'
                  }`}
                >
                  {skill.enabled ? 'enabled' : 'disabled'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Toolsets (api_server platform)</h2>
        <textarea
          data-testid="settings-toolsets-editor"
          rows={4}
          placeholder="one toolset per line"
          className="w-full rounded border border-edge bg-panel p-3 font-mono text-sm"
          value={toolsetsText}
          onChange={(e) => {
            setToolsetsText(e.target.value)
            setToolsetsDirty(true)
          }}
        />
        <div className="mt-1 flex justify-end">
          <button
            data-testid="settings-toolsets-save-button"
            disabled={!toolsetsDirty}
            className="rounded bg-accent-strong px-3 py-1 text-sm font-medium text-white disabled:opacity-40"
            onClick={() => void saveToolsets()}
          >
            Save toolsets
          </button>
        </div>
      </section>

      <section className="flex items-center justify-between rounded border border-edge bg-panel px-3 py-2">
        <div>
          <h2 className="text-sm font-semibold">Approvals mode</h2>
          <p className="text-xs text-ink-dim">
            tool-approval policy rendered into the managed config
          </p>
        </div>
        <select
          data-testid="settings-approvals-select"
          className="rounded border border-edge bg-surface px-2 py-1 text-sm"
          value={approvals}
          onChange={(e) => void saveApprovals(e.target.value as ApprovalsMode)}
        >
          <option value="off">off (unattended)</option>
          <option value="smart">smart</option>
          <option value="manual">manual</option>
        </select>
      </section>

      <section className="flex items-center justify-between rounded border border-edge bg-panel px-3 py-2">
        <div>
          <h2 className="text-sm font-semibold">Gateway token</h2>
          <p className="text-xs text-ink-dim">
            rotate re-issues the proxy credential into the profile .env — the plaintext is never
            displayed (S3)
          </p>
        </div>
        <button
          data-testid="settings-token-rotate-button"
          className="rounded border border-edge px-3 py-1 text-sm hover:bg-surface"
          onClick={() => setRotateOpen(true)}
        >
          Rotate token
        </button>
      </section>

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
