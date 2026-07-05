# Requirements — per-agent Chat UI를 sessions/chat/stream 으로 마이그레이션 (U4 Web UI)

**Stage**: CONSTRUCTION — 점진 개선 (적응형, 경량 사이클)
**Date**: 2026-07-05
**Scope(잠정)**: `web/src/` — `pages/chat/ChatView.tsx`, `api/agentApi.ts`, `api/client.ts`, `lib/types.ts`, (조건부) `lib/transcript.ts`, 관련 vitest/E2E.
백엔드/Caduceus proxy/hermes **무변경**(전송 방식만 클라이언트에서 교체; 서버 계약은 이미 존재).
**의존**: hermes ≥ 0.18(패치 브랜치 `feat/session-chat-stream-approval-stop`, PR #58856) — `/api/sessions/{id}/chat/stream`에 approval/stop 이식됨. 로컬 재설치·스파이크 검증 완료(2026-07-05).

## 1. 배경 / Intent

오늘의 per-agent chat(`ChatView.tsx`)은 hermes **runs API**로 턴을 돈다:

```text
매 턴:  GET  api/sessions/{id}/messages         # 히스토리 하이드레이트
        historyFromMessages(raw) → {role,content}[]   # 클라가 conversation_history 조립
        POST v1/runs {input, session_id, conversation_history}  → run_id
        GET  v1/runs/{run_id}/events              # data-only SSE 소비
        (approval) POST v1/runs/{run_id}/approval   (stop) POST v1/runs/{run_id}/stop
```

이 방식의 한계(실측 — 앞선 조사/스파이크):
- **맥락 손실**: runs는 caller가 `conversation_history`를 `{role,content}` 문자열로만 주입 → **tool 호출/결과·reasoning·이미지가 재주입 안 됨**(클라가 못 담음). hermes 세션에는 이 모두가 영속(`reasoning`/`tool_calls`/role=tool 결과)돼 있는데도 모델은 매 턴 그중 content만 다시 본다.
- **클라이언트 조립 부담**: 매 턴 메시지 재조회 + 히스토리 재구성(`transcript.ts`).
- **2-콜 왕복**: POST runs → GET events.

**sessions/chat/stream**(hermes 네이티브)은 1 에이전트:1 세션에서 이를 전부 해소한다:
- 세션 스토어에서 **네이티브로 그 세션의 전체 대화를 재생**(tool 결과·tool_calls·reasoning·이미지 포함) → 클라 조립 불요, 완전 충실도.
- **1-콜**: `POST api/sessions/{id}/chat/stream`이 곧바로 SSE.
- approval/stop은 이제(우리 패치) run.started의 `run_id`로 **동일한 `/v1/runs/{id}/approval|stop`** 재사용.

⇒ per-agent chat을 sessions/chat/stream으로 전환하면 맥락 충실도↑, 클라 단순화, 우리 PR #58856을 실제 제품에서 검증.

## 2. 미래 Main Chat 룸과의 관계 (직교 — 중요)

`ten` 브랜치 설계(`main-chat-room/requirements-refinement.md`)의 **멀티에이전트 룸**은 의도적으로 **runs + Caduceus 주입(C1)** 을 쓴다: 하나의 룸을 N 에이전트에 멀티플렉스하고 Caduceus가 정본(SOT)을 소유하며 맥락을 100% 통제해야 하므로, 세션 네이티브 하이드레이션은 **부적합**(스파이크로 "세션 스토어는 run 맥락에 자동 주입 안 됨"이 룸의 장점으로 확정 — Q2=A).

**이번 마이그레이션은 그 룸과 직교하다:**
- per-agent chat = **1:1**, 세션 네이티브 하이드레이션이 정답 → sessions/chat/stream.
- 룸 = **1:N**, Caduceus 통제 주입 → runs 유지.
- 두 전송이 공존한다(의도된 이원화). per-agent chat 전환은 룸 설계를 훼손하지 않으며, 오히려 sessions+approval/stop 패치를 선행 검증한다.

(단 "per-agent chat도 runs로 통일 유지" 또는 "룸 전송 재검토"를 원한다면 §6 Q1에서 방향을 바꿀 수 있음.)

## 3. 서버 계약 (실측 — `gateway/platforms/api_server.py`, 재설치 브랜치)

**요청**: `POST /api/sessions/{session_id}/chat/stream`
- body: `{ "message": <str | 멀티모달 content> }` (또는 `input`) — **이미지 등 멀티모달 네이티브 수용**.
- 선택: `system_message`/`instructions`(ephemeral, append), 헤더 `X-Hermes-Session-Key`.
- 인증: relay가 서버측 `Authorization: Bearer <agent key>` 부착(기존 불변식).

**응답**: `text/event-stream`, **named SSE 이벤트**(`event: <name>\ndata: <json>`):

| event | payload 핵심 | 클라 용도 |
|---|---|---|
| `run.started` | `run_id`, `session_id`, `user_message` | **run_id 확보**(approval/stop 대상) |
| `message.started` | `message.{id,role}` | assistant 메시지 골격 시작 |
| `assistant.delta` | `message_id`, `delta` | 텍스트 스트리밍 (구 `message.delta`) |
| `tool.progress` | `tool_name`(`_thinking`=reasoning), `delta` | reasoning/진행 표시 (구 `reasoning.available`) |
| `tool.started` / `tool.completed` / `tool.failed` | `tool_name`, `preview`, `args` | tool 카드 |
| `approval.request` | `command`(redacted), `choices:[once,session,always,deny]`, `run_id` | 승인 카드 |
| `assistant.completed` | `content`(최종, media→data URL), `interrupted` | 최종 content 확정 |
| `run.completed` | `messages`(turn transcript), `usage` | 턴 종료·usage 갱신 |
| `error` | `message`(redacted) | 오류 |
| `done` | — | 스트림 종료 신호 |

**클라이언트 갭**: `web/src/api/client.ts`의 `agentApiStream`이 **GET 고정·body 없음** → sessions/chat/stream은 **POST+JSON body**로 SSE를 여므로 이 헬퍼 확장 필요. SSE 파서(`lib/sse.ts`)는 이미 `event:` 이름을 캡처하므로 runs의 data-only → **named 이벤트**로 소비 방식 전환 가능.

## 4. 기능 요구사항 (FR)

- **FR-1 전송 교체**: `startTurn`이 `startRun`+`streamRunEvents`(2-콜) 대신 `POST api/sessions/{id}/chat/stream` 1-콜로 SSE를 연다.
- **FR-2 히스토리 조립 제거**: 턴 실행 시 `fetchMessages`→`historyFromMessages`(conversation_history) 조립을 **제거**한다. 맥락은 hermes가 세션에서 네이티브 재생. (기존 세션 히스토리 **표시용** 하이드레이트는 유지 — §4 FR-7.)
- **FR-3 named 이벤트 소비**: SSE `event:` 이름으로 분기. 매핑 — `assistant.delta`→텍스트, `tool.progress(_thinking)`→reasoning, `tool.started/completed/failed`→tool 카드, `assistant.completed`→최종 content, `run.completed`→턴 종료+usage, `error`/`done`.
- **FR-4 run_id 소스 전환**: `runIdRef`를 `startRun` 반환값이 아니라 **`run.started` 이벤트**에서 채운다. approval/stop은 그 run_id로 기존 `/v1/runs/{id}/approval|stop` 그대로 호출(엔드포인트 무변경).
- **FR-5 상태기계 보존**: `chatMachine.ts`의 상태/이벤트 어휘(idle/streaming/stopping/awaiting_approval; approval_request/stream_end 등)는 **불변**. `stream_end`는 `done`/`run.completed`에서 파생. 승인 선택지 `[once,session,always,deny]` 동일.
- **FR-6 usage 갱신**: 턴 usage를 `run.completed.usage`에서 취득(현행 refreshSessions 흐름과 정합).
- **FR-7 표시 하이드레이션 유지**: 세션 열람/재접속 시 과거 메시지 표시는 기존 `fetchMessages`+transcript 렌더 유지(턴 주입용이 아니라 표시용). 라이브 턴 렌더 순서(직전 `chat-streaming-order` 개선)·transcript 렌더 규칙은 회귀 없이 보존.
- **FR-8 오류/중단 패리티**: 스트림 컷→idle 복구, stop→중단, 승인 거부/자동거부(stopping 중) 동작을 현행과 동등하게 유지.
- **FR-9 라이브 thinking 표시 (Q4=B 확정)**: sessions 스트림의 `tool.progress(tool_name=_thinking, delta)`를 **라이브 턴에 reasoning으로 반영**한다. 직전 `chat-streaming-order`(라이브 세그먼트 순서)·`chat-transcript-rendering`(reasoning 접힘 카드) 렌더 규칙과 정합되게 — reasoning delta를 순서 세그먼트로 누적해 라이브 렌더, 턴 종료 후 재수화 transcript와 시각적 연속. `redact()` 적용(기존 reasoning 표시 규칙 유지).

## 5. 비기능 / 제약

- **보안(확장 Enabled)**: per-agent 키·업스트림 키는 서버에만(relay 불변식 유지). 승인 command redaction은 **서버(hermes)에서 이미 수행**(`_redact_approval_command`, 우리 패치가 SSE egress 전 redact) — 클라는 표시만.
- **복원력(확장 Enabled)**: 스트림 컷/에이전트 다운 시 UI는 idle로 안전 복구(기존 U4-REL-2 유지). 세션 데이터는 hermes 소유이므로 보존.
- **회귀 없음**: web tsc/eslint/vitest/build + Playwright E2E 그린 유지. 특히 chat 관련 E2E(승인·중단·transcript·streaming order) 갱신·통과.
- **범위 규율**: 백엔드/hermes/proxy 무변경. 멀티모달·라이브 thinking 등은 §6 질문으로 포함/보류 결정.

## 6. 확정된 결정 (APPROVED 2026-07-05)

`requirements-questions.md` 답변 반영:
- **Q1 = A** — per-agent chat만 sessions/chat/stream 전환. 룸 설계는 runs 유지(직교, 두 전송 공존).
- **Q2 = A** — per-agent chat 경로에서 미사용된 `startRun`/`streamRunEvents`/턴용 `conversation_history` 조립 **제거**(표시용 `fetchMessages`/transcript 유지).
- **Q3 = A** — 전송 마이그레이션만. 멀티모달 이미지 입력은 후속 사이클.
- **Q4 = B** — **라이브 thinking 표시 포함**(FR-9). `tool.progress(_thinking)`를 라이브 턴에 반영.
- **Q5 = A** — 게이트웨이 3개(test/test2/test3) **재시작 완료**(신규 PID, healthy — 패치 코드 라이브).

## 6.1 후속 스코프 — CLI `caduceus chat <agent>` (이번 사이클 밖)

이번 사이클은 **웹만**. CLI는 후속 사이클에서 전환하되 방향 확정(2026-07-05):
- **별도 구현 금지 — web과 동일한 백엔드(`api/sessions/{id}/chat/stream`) 재사용.** `chat.py`의 자체 runs 흐름(POST v1/runs + conversation_history 조립 + GET events)을 걷어내고 web과 같은 sessions 전송을 탄다.
- **세션 옵션**: session id는 **optional**. 미지정 시 해당 agent의 **최근 세션으로 즉시 resume**(기존 세션 없으면 자동 생성). **new session 시작 여부도 옵션**(예: `--new-session`).
→ 후속 사이클에서 CLI 전용 plan(S11~)으로 상세화.

## 7. 검증 계획 (초안)

- 단위: 새 `streamSessionChat` 이벤트 매핑 리듀서(vitest) — named 이벤트→UI 상태. `chatMachine` 불변 확인.
- E2E(Playwright): 텍스트 턴 스트리밍, 승인 카드→once, mid-turn stop, 세션 재접속 하이드레이션.
- 수동/실기동: 재설치된 패치 게이트웨이(cad-test 계열, agent 재시작 필요)에서 승인 트리거 tool로 approval.request 카드·stop 확인.
