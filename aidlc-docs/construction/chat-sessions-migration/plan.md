# Code Generation Plan — per-agent Chat → sessions/chat/stream

**Stage**: CONSTRUCTION — Code Generation (Part 1: Planning)
**Date**: 2026-07-05
**Scope**: `web/src/` 만. 백엔드/Caduceus proxy/hermes **무변경**.
**근거**: requirements.md (Q1=A, Q2=A, Q3=A, **Q4=B**, Q5=A). 서버 계약·클라 갭 §3 실측 완료.

## 전환 매핑 (runs → sessions)

| 현행 (runs, data-only SSE) | 신규 (sessions/chat/stream, named SSE) | 리듀서/동작 |
|---|---|---|
| `startRun`+`streamRunEvents` (2-콜) | `streamSessionChat` (1-콜 POST→SSE) | — |
| `historyFromMessages` 주입 | (없음 — hermes 네이티브 재생) | 제거 |
| run_id = startRun 반환 | run_id = `run.started` 이벤트 | `runIdRef` |
| `message.delta` | `assistant.delta` | `appendText` |
| `reasoning.available`(실은 reply) | `assistant.completed.content` / `run.completed` | `fallbackText` |
| (라이브 reasoning 없음) | `tool.progress{_thinking}` | **`appendReasoning`(신설, Q4=B)** |
| `tool.started` `{tool}` | `tool.started` `{tool_name}` | `startTool` |
| `tool.completed` `{tool,error,duration}` | `tool.completed` / `tool.failed` `{tool_name}` | `completeTool` |
| `approval.request` `{preview}` | `approval.request` `{command(redacted),choices,run_id}` | prompt/auto_deny |
| `run.completed` `{output}` | `assistant.completed`+`run.completed`(+usage) | final content + `stream_end` |
| `run.failed`/`run.cancelled` | `error` / (stop→interrupt) | note |
| (—) | `run.started`/`message.started`/`done` | 생명주기 |

## 단계 (S1..S10)

- [x] **S1 — `api/client.ts`: `agentApiStream` POST+body 지원.** 시그니처를 `(agent, subpath, opts?: {method?, json?, signal?})`로 일반화(내부 `raw`는 이미 `json`/`stream` 지원). 기존 GET 호출부는 streamRunEvents 제거로 사라지므로 신규 시그니처만 사용.
- [x] **S2 — `api/agentApi.ts`: `streamSessionChat` 신설 + runs 헬퍼 제거.** `streamSessionChat(client, agent, sessionId, message, onEvent, signal)` — `POST api/sessions/{id}/chat/stream` `{message}`, `createSseParser`로 **named 이벤트**(`sse.event` 이름) 파싱해 `{kind, payload}` 방출. `SessionStreamEvent` 타입. **제거(Q2=A)**: `startRun`, `streamRunEvents`, `RunStreamEvent`(per-agent 미사용 확인 후). `stopRun`/`sendApproval`/`fetchMessages`/세션 CRUD는 **유지**.
- [x] **S3 — `lib/liveTurn.ts`: `reasoning` 세그먼트 + `appendReasoning`(Q4=B).** `LiveSegment`에 `{kind:'reasoning'; text}` 추가. `appendReasoning(turn, text)` — 후행 reasoning 세그먼트에 coalesce(순수·total, `appendText` 패턴). `turnHasText`/`fallbackText` 불변(텍스트만 카운트).
- [x] **S4 — `lib/transcript.ts`: `historyFromMessages` 정리.** 턴 주입 전용이라 Q2=A로 미사용화 → 다른 사용처 없으면 제거(표시용 transcript 렌더 함수는 유지). 사용처 grep로 확인 후 결정.
- [x] **S5 — `pages/chat/ChatView.tsx`: 턴 흐름 재작성.** `startTurn`에서 `fetchMessages`+`historyFromMessages`+`startRun` 제거 → `streamSessionChat` 1-콜. `consumeStream`를 named 이벤트 매핑(위 표)으로 교체: `run.started`→`runIdRef`, `assistant.delta`→appendText, `tool.progress{_thinking}`→appendReasoning, `tool.started`→startTool, `tool.completed`/`tool.failed`→completeTool, `approval.request`→prompt(summary=command/description), `assistant.completed`/`run.completed`→fallbackText+usage, `error`→note, `done`/`run.completed`→`stream_end`. stop/approval 핸들러는 `runIdRef` 기반 그대로. 턴 종료 W7 재수화(`hydrate`)+`refreshSessions` 유지. usage=`run.completed.usage`.
- [x] **S6 — `ChatView.tsx` `LiveTurnBlock`: reasoning 세그먼트 렌더.** `reasoning` 세그먼트를 thinking 카드로 렌더(transcript의 reasoning 접힘 카드 스타일 재사용, `redact()` 적용). text/tool/reasoning 이벤트 순서대로 표시.
- [x] **S7 — `lib/types.ts`: 타입 정리.** `SessionStreamEvent` 등 신규 타입, 미사용 Run 관련 타입 정리. `SessionMessage`/`SessionInfo` 유지.
- [x] **S8 — 단위 테스트(vitest).** `liveTurn`: `appendReasoning` PBT(coalesce·순수·total). `streamSessionChat`: named 이벤트 파싱→`{kind,payload}` 매핑 테스트. `chatMachine` 불변 확인. `startRun`/`streamRunEvents` 참조 테스트 갱신/제거.
- [x] **S9 — E2E(Playwright).** 채팅 플로우 스펙을 sessions 엔드포인트로 갱신: 텍스트 턴 스트리밍, **라이브 thinking 표시**, 승인 카드→once, mid-turn stop, 세션 재접속 하이드레이션. `/v1/runs`를 스텁하던 목을 `/api/sessions/{id}/chat/stream`(+ `/v1/runs/{id}/approval|stop` 유지)로 조정.
- [x] **S10 — 검증 + 요약.** web `tsc`/`eslint`/`vitest`/`build`(→`caduceus/web_dist` 갱신) + Playwright E2E 그린. 재시작된 패치 게이트웨이(test 계열)로 수동 스모크(승인 트리거 tool→approval.request 카드·once·stop·라이브 reasoning). `code-summary.md` 작성. 보안/복원력 확장 컴플라이언스 요약.

## 비목표 / 가드
- 멀티모달 이미지 입력(Q3=A 후속), 룸 설계(runs 유지) — 이번 스코프 밖.
- **CLI `caduceus chat <agent>` — 이번 스코프 밖(후속 사이클).** 방향 확정(requirements §6.1): 별도 구현 없이 **web과 동일한 sessions 백엔드 재사용**, session id optional(미지정=최근 세션 resume, 없으면 자동 생성), new-session 옵션.
- 렌더 회귀 금지: 직전 `chat-streaming-order`/`chat-transcript-rendering` 규칙 보존.
- 보안 불변식: redaction은 서버(hermes)에서 수행, 클라는 표시+`redact()` 이중 안전만.

## 완료 기준
- per-agent chat이 sessions/chat/stream 1-콜로 턴 수행, 네이티브 히스토리 충실도, 라이브 thinking 표시, 승인/중단 동작(run.started run_id로 `/v1/runs` 재사용), 재수화 정합. 전 검증 그린.
