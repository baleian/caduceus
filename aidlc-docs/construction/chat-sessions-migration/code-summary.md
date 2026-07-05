# Code Summary — per-agent Chat → sessions/chat/stream

**Stage**: CONSTRUCTION — Code Generation (Part 2) · **Date**: 2026-07-05
**Scope**: `web/` + E2E fake daemon. 백엔드/Caduceus proxy/hermes 소스 **무변경**.
**Diff**: 9 files, +307 / −118.

## 무엇이 바뀌었나

per-agent chat이 hermes **runs**(2-콜 + 클라 `conversation_history` 조립 + data-only SSE)에서
**sessions/chat/stream**(1-콜 POST→SSE, 서버 네이티브 히스토리 재생, named SSE)로 전환.
approval/stop은 `run.started`의 `run_id`로 기존 `/v1/runs/{id}/approval|stop` 재사용(hermes 패치 PR #58856).
라이브 reasoning 표시 신설(Q4=B).

## 파일별 변경

| 파일 | 변경 |
|---|---|
| `web/src/api/client.ts` | `agentApiStream(agent, subpath, {method?, json?, signal?})` — POST+body 지원(내부 `raw`가 이미 `json`/`stream` 처리). |
| `web/src/api/agentApi.ts` | **신설** `streamSessionChat(...)` — `POST api/sessions/{id}/chat/stream {message}`, `createSseParser`로 **named 이벤트**(`sse.event`) 파싱→`{kind,payload}`. `SessionStreamEvent` 타입. **제거**: `startRun`/`streamRunEvents`/`RunStreamEvent`. **유지**: `stopRun`/`sendApproval`/`fetchMessages`/세션 CRUD. |
| `web/src/lib/liveTurn.ts` | `LiveSegment`에 `{kind:'reasoning';text}` 추가 + `appendReasoning`(coalesce, 순수·total). `turnHasText`/`fallbackText`는 텍스트만 카운트(불변) → reasoning-only 턴에도 최종 content fallback 정상. |
| `web/src/lib/transcript.ts` | `historyFromMessages` 제거(턴 주입 전용, Q2=A). 표시용 `transcriptFromMessages` 유지. |
| `web/src/pages/chat/ChatView.tsx` | `startTurn`: `fetchMessages`+`historyFromMessages`+`startRun` 제거 → `consumeStream(sessionId, text)` 1-콜. `consumeStream`: named 이벤트 매핑(run.started→runIdRef, assistant.delta→appendText, tool.progress{_thinking}→appendReasoning, tool.started→startTool, tool.completed/failed→completeTool, approval.request→prompt(summary=command/description), assistant.completed→fallbackText, error→note). `LiveTurnBlock`: reasoning 세그먼트를 ∴ thinking 카드로 렌더. 턴 종료 W7 재수화+refreshSessions·stop/approval(runIdRef)·chatMachine 불변. |
| `tests/e2e_support/fake_daemon.py` | **신설** `POST /api/sessions/{id}/chat/stream` + `_session_events`(named SSE): run.started/message.started/assistant.delta/tool.progress{_thinking}/tool.*/approval.request/assistant.completed/run.completed/done. 스크립트 plain/slow/approve **+ think(reasoning)**. approval/stop은 기존 `self.runs[run_id]` 재사용(신규 컨트롤 라우트 불요). |
| `web/tests/property/liveTurn.test.ts` | `appendReasoning` PBT(coalesce·interleave·empty-ignore·reasoning≠reply text). |
| `web/tests/unit/streamSessionChat.test.ts` | **신설** — POST body/subpath + named 이벤트 매핑 + 비객체/garbled 프레임 drop + no-body. |
| `web/tests/e2e/app.spec.ts` | 신규 **라이브 reasoning 카드**(Q4=B) 테스트. 기존 streamed/stop/approval 테스트는 fake가 동일 스크립트를 chat/stream으로 제공하므로 무변경 통과. |

## 검증

- `tsc --noEmit` clean · `eslint --max-warnings 0` clean · `vite build` clean(**web_dist 갱신**)
- `vitest`: **109/110** — 유일 실패 `tests/property/tail.test.ts`는 **기존 flaky**(fast-check seed 의존, 동일 실행 3회 1승2패), 본 변경과 무관·미접촉. 본 변경 관련 테스트 **38/38** 결정적 통과.
- Playwright E2E: **16/16**(신규 Q4=B reasoning 포함, 마이그레이션된 streamed/stop/approval 통과).
- 사전 라이브 스파이크(2026-07-05): 실제 hermes 패치 게이트웨이에 대해 approval/stop end-to-end 실증(별도 기록).

## 적대적 리뷰(5차원 × refuter) 반영

`Workflow`로 correctness/regression/security/resilience/test-coverage 5개 리뷰어 + 각 발견 refuter 검증(15 에이전트). 확정 9건(반박 1건) → 마이그레이션이 유발/노출한 것 위주로 조치:

**수정 완료 (코드):**
- **Stop 레이스 (medium)** — run_id가 `run.started`(비동기)로만 채워져 첫 프레임 전 Stop 클릭 시 `send_stop && runId` 가드로 stopRun·note 둘 다 누락(runs 플로우 대비 신규 회귀). → `pendingStopRef` 추가: Stop 시 note는 항상 표시하고 run_id 미도착 시 지연, `run.started` 도착 즉시 stopRun 발화. finally에서 리셋.
- **라이브 hex 시크릿 노출 (medium, security)** — per-delta redact 후 coalesce → 델타 경계로 쪼개진 32+hex가 라이브 렌더에 노출(재수화 시에만 마스킹). reasoning 라이브 경로(Q4=B)가 이를 신규 노출. → `LiveTurnBlock`에서 **조립 세그먼트를 렌더 시 재-redact**(text `redact(seg.text, DELTA_LIMIT)`, reasoning `redact(seg.text)`) — transcript와 동일 방식. 경계-분할 시크릿도 마스킹.
- **`void sendApproval` 미처리 rejection (low)** — 3곳 `.catch` 누락. → `sendApprovalSafe(runId, choice)` 헬퍼(stopRun 규약대로 toast)로 통일.

**커버리지 보강 (E2E + fake):**
- `error` 이벤트 → 시스템 note('run failed') + idle 복구 (fake `boom` 스크립트).
- `tool.failed` → 라이브 카드 failed 상태(`data-state="failed"` 신설) (fake `toolfail` 스크립트).
- approval **deny** → `assistant.completed` fallback('tool denied') 양성 경로.

**문서화(보류 — 기존 이슈):** 부분 outage(POST 5xx·GET 정상) 시 finally `hydrate`의 `setTurn(EMPTY_TURN)`가 에러 note·userText를 덮어 피드백 상실. 마이그레이션 이전부터 존재(finally hydrate 불변), 별도 사이클에서 hydrate note-보존으로 처리 권장. **반박 1건**(run_id fallback 분기 커버리지)은 해피패스가 기존 stop E2E로 커버돼 무효.

## 확장(Resiliency/Security) 컴플라이언스

- **Security**: 승인 command redaction은 서버(hermes `_redact_approval_command`)에서 SSE egress 전 수행 + 클라 `redact()` 이중. 렌더되는 모든 SSE 필드(delta/reasoning/preview/command/content/error)는 `redact()` 통과. per-agent/업스트림 키는 relay 서버측 전용(불변). ✔
- **Resiliency**: 스트림 컷→`streamSessionChat`가 reader 오류를 삼키고 반환→`stream_end`→idle 복구(U4-REL-2). `error` 이벤트→note 후 정상 종료. stop→interrupt→스트림 종료→idle. `startTurn` finally에서 runIdRef/approval 리셋. ✔
- **Property-Based Testing**: liveTurn 리듀서(reasoning 포함) PBT 유지·확장. ✔

## 비목표(후속)
- 멀티모달 이미지 입력(Q3=A), CLI `caduceus chat`(Q1=A — web 백엔드 재사용 방향만 §6.1 기록), 룸 설계(runs 유지).
