# Requirements — CLI `caduceus chat <agent>`를 sessions/chat/stream 으로 마이그레이션 (U3 CLI)

**Stage**: CONSTRUCTION — 점진 개선 (적응형, 경량)
**Date**: 2026-07-06
**Scope**: `caduceus/cli/chat.py` + `tests/unit/test_cli_chat.py` + `tests/integration/test_cli_daemon_e2e.py`.
`cli/client.py`·`cli/sse.py`·`cli/main.py` **무변경**(이미 필요한 기능 보유).
**의존**: hermes ≥ 0.18(패치 브랜치 / PR #58856) — `/api/sessions/{id}/chat/stream` approval/stop. 이미 재설치·검증됨. 직전 사이클 `chat-sessions-migration`(web, 커밋 79df412)의 CLI 대응.

## 1. 배경 / Intent

직전 사이클에서 **웹** per-agent chat을 sessions/chat/stream으로 옮겼다. CLI(`caduceus chat`)는 아직 runs 방식이다(별도 파이썬 코드). 사용자 방침(직전 사이클 §6.1): **CLI도 별도 구현 없이 web과 동일한 sessions 백엔드를 재사용**한다.

현행 CLI 턴(`chat.py`):
```text
매 턴:  GET  api/sessions/{id}/messages           # _messages_raw
        _history(raw) → conversation_history       # {role,content}만
        POST v1/runs {input, session_id, conversation_history} → run_id
        GET  v1/runs/{run_id}/events               # data-only SSE
        (stop) POST v1/runs/{run_id}/stop   (approval) .../approval
```
→ sessions/chat/stream(1-콜, named SSE, 서버 네이티브 히스토리 재생)로 전환. 웹과 동일한 이점(맥락 충실도·클라 조립 제거·1-콜) + 우리 approval/stop 패치.

## 2. 이미 충족된 요구 (구현 불요 — 재사용)

사용자 요구(session optional / 최근 세션 resume / 자동 생성 / new 옵션)는 **이미 구현돼 있다**:
- `chat.py: resolve_session(session_id, new)` — session_id 지정 시 검증 후 resume, 미지정+not new면 **최근 세션 resume**(`last_active/started_at` 정렬), 세션 없으면 **자동 생성**, `new`면 새 세션.
- `cli/main.py: chat(...)` — `--session <id>` / `--new` 플래그(**상호배타** 검증).
⇒ 이번 마이그레이션은 **세션 해석은 그대로 두고 전송만 교체**한다.

## 3. 이미 갖춘 인프라 (변경 불요)

- `cli/client.py: agent_api_stream(name, method, subpath, *, json=None)` — **POST+body 이미 지원**(현재 GET 호출을 POST+`{message}`로 바꾸기만).
- `cli/sse.py: iter_sse` — `SseEvent(event, data)`로 **named 이벤트(`event:` 이름) 이미 캡처**. 현행 `_dispatch`는 `payload["event"]`(data-only)를 읽지만, sessions에선 `event.event`를 kind로 넘기면 됨.

## 4. 기능 요구사항 (FR)

- **FR-1 전송 교체**: `_turn`이 `_messages_raw`+`_history`+`POST v1/runs`(2-콜) 대신 `POST api/sessions/{id}/chat/stream {message}` 1-콜 스트림을 연다.
- **FR-2 히스토리 조립 제거**: 턴 주입용 `_history` 및 `conversation_history` 제거. (단 `_messages_raw`는 `_render_tool_failures`가 세션 스토어에서 실패 상세를 재조회하는 데 **유지**.)
- **FR-3 named 이벤트 디스패치**: `_consume_stream`이 `iter_sse`의 `event.event`를 kind로 `_dispatch`에 전달. 매핑 — `assistant.delta`→delta, `tool.started`→⚙, `tool.completed`/`tool.failed`→✓/✗, `approval.request`→prompt/auto_deny, `assistant.completed`→최종 content fallback, `run.completed`→줄바꿈, `error`→에러. `run.started`→run_id 캡처. **`tool.progress{_thinking}`(reasoning)→미표시(Q1=B3)**: content가 뒤에 오는 reasoning보다 먼저 스트리밍되고 콘솔은 재배치 불가라 표시 시 직관성↓ → 무시.
- **FR-4 run_id 소스 전환**: 현행은 POST v1/runs 응답에서 run_id를 얻어 `_consume_stream(run_id)`로 넘긴다. sessions에선 run_id가 **`run.started` 이벤트**로 도착 → `_consume_stream`이 스트림 중 캡처해 stop/approval에 사용. **Stop/승인이 run_id 도착 전에 눌릴 수 있는 창**을 안전 처리(웹의 pendingStop과 동형 — run_id 도착 시 지연 stop 발화, 그 전엔 no-op 대신 대기).
- **FR-5 상태기계 보존**: `transition` 테이블(idle/streaming/stopping/awaiting_approval) 불변. `stream_end`는 스트림 종료에서. 승인 선택지 `once/session/always/deny` 동일.
- **FR-6 tool 실패 상세 보존**: `_render_tool_failures`(턴 후 세션 스토어 재조회로 ✗ 사유 표시)는 유지. tool 완료/실패 페어링은 `tool.completed`/`tool.failed` 이벤트에서 `error` 판정.
- **FR-7 파서/전송 무변경 재사용**: `iter_sse`·`agent_api_stream`은 그대로.

## 5. 비기능 / 제약

- **보안**: 렌더되는 필드(delta/reasoning/preview/command/content)는 기존대로 `redact()`. per-agent 키는 relay 서버측(불변). 승인 command redaction은 서버(hermes)에서도 수행.
- **복원력**: 스트림 컷/`KeyboardInterrupt`→idle 복구, stop 1회 보장(PU3-5), 세션 파괴 호출 부재 유지.
- **회귀 없음**: `pytest`(cli chat 유닛/통합) 그린. ruff/mypy strict 통과.
- **범위 규율**: web 코드·cli/client.py·cli/sse.py·cli/main.py 무변경.

## 6. 확정된 결정 (APPROVED 2026-07-06)

- **Q1 = B3** — CLI reasoning **미표시**(content만). sessions reasoning이 content 뒤에 도착 + 콘솔 재배치 불가.
- **Q2 = A** — 웹 hydrate-outage 버그 **동반 수정**(별도 커밋). `ChatView.tsx submit()` catch에서 실패를 **toast(영속 표면)로 표시 + 입력 메시지 복원(`setInput(text)`)** → 부분 장애 시 finally hydrate가 라이브 버퍼를 비워도 피드백·메시지가 살아남음. hydrate 로직 자체는 무변경(최소 수정).
- **Q3 = A** — 미사용 `_history` **제거**(+ test 갱신). `_messages_raw`는 `_render_tool_failures`용으로 유지.

## 7. 검증 계획 (초안)

- 유닛(`test_cli_chat.py`): `sse()` 헬퍼를 named 프레임으로, 하네스 라우트에 `POST .../chat/stream`, 이벤트명·run_id·approval/stop·tool 실패 상세·resume(→conversation_history 제거, `{message}` 바디) 갱신.
- 통합(`test_cli_daemon_e2e.py`): 인라인 fake hermes에 chat/stream(named SSE) 추가.
- 수동: 재설치된 패치 게이트웨이(test 계열)로 `caduceus chat test` 실 턴(스트리밍/stop/approval/reasoning).
