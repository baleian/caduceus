# Code Generation Plan — CLI `caduceus chat` → sessions/chat/stream

**Stage**: CONSTRUCTION — Code Generation (Part 1: Planning)
**Date**: 2026-07-06
**Scope**: `caduceus/cli/chat.py` + `tests/unit/test_cli_chat.py` + `tests/integration/test_cli_daemon_e2e.py`.
**+ 별도 커밋(Q2=A)**: `web/src/pages/chat/ChatView.tsx` hydrate-outage 수정.
`cli/client.py`·`cli/sse.py`·`cli/main.py`·`resolve_session` **무변경**.
**근거**: requirements.md (Q1=B3, Q2=A, Q3=A).

## 전환 매핑 (runs → sessions)

| 현행 (runs, data-only) | 신규 (sessions/chat/stream, named) | 동작 |
|---|---|---|
| `GET /messages` + `_history` → conversation_history | (없음 — 네이티브 재생) | 제거 |
| `POST v1/runs` → run_id | `POST api/sessions/{id}/chat/stream {message}` | 1-콜 |
| run_id = POST 응답 | run_id = `run.started` 이벤트 | `self._run_id` |
| `GET v1/runs/{id}/events` (data-only) | 같은 POST 스트림 (named) | `event.event` |
| `message.delta` | `assistant.delta` | delta 출력 |
| `reasoning.available` | `tool.progress{_thinking}` | **무시(Q1=B3)** |
| `tool.started`/`tool.completed{error}` | `tool.started`/`tool.completed`·`tool.failed` | ⚙ / ✓✗ (error=kind) |
| `approval.request{preview}` | `approval.request{command,choices,run_id}` | prompt/auto_deny |
| `run.completed{output}` | `assistant.completed{content}` + `run.completed` | 최종 content fallback |
| `run.failed`/`run.cancelled` | `error` / (stop) | 에러/중단 |

## 단계

- [x] **S1 — `chat.py _turn`**: 사전 `_messages_raw`/`_history`/`POST v1/runs`/`_turn_baseline` 제거. `self._run_id=None`·`self._pending_stop=False` 초기화 후 `_consume_stream(session_id, user_message)` 호출. `_render_tool_failures`·예외/`finally state=idle` 유지.
- [x] **S2 — `chat.py _consume_stream(session_id, message)`**: `agent_api_stream(agent, "POST", f"api/sessions/{id}/chat/stream", json={"message": message})` 스트림 → `iter_sse` → `_dispatch(event.event, event.data)`. `KeyboardInterrupt`→`_interrupt()`. 종료 시 `stream_end` 전이.
- [x] **S3 — `chat.py _dispatch(kind, data)`**: named 매핑. `run.started`→`self._run_id` 캡처(+`_pending_stop`이면 즉시 stop). `assistant.delta`→delta 출력·`_turn_text` 누적. `tool.started`→⚙+기록. `tool.completed`/`tool.failed`→`_record_tool_completed`(error=`kind=='tool.failed'`)+✓/✗. `approval.request`→prompt/auto_deny(run_id=payload 또는 self._run_id). `assistant.completed`→delta 없었으면 content 출력(fallback), 있었으면 개행. `error`→CliError 렌더. `tool.progress`(reasoning)·`message.started`·`run.completed`·`done`→무시.
- [x] **S4 — `chat.py _interrupt()` / `_send_approval` / `_prompt_approval`**: `_interrupt`는 인자 없이 `self._run_id` 사용 — `send_stop`시 run_id 있으면 stop, 없으면 `self._pending_stop=True`(run.started에서 발화), note는 항상. `auto_deny`→`_send_approval(self._run_id,"deny")`. `_prompt_approval` summary=`command`/`description`/`tool_name` 우선순위.
- [x] **S5 — `chat.py` 정리(Q3=A)**: `_history` 제거. `_render_tool_failures`는 baseline 대신 **세션 스토어의 마지막 `len(completed)`개 tool 메시지와 페어링**(happy-path 사전 GET 제거 → 실패 있을 때만 1회 GET). 불일치 가드 유지.
- [x] **S6 — `tests/unit/test_cli_chat.py`**: `sse()`를 **named 프레임**(`event: name\ndata: …`)으로. 하네스에 `POST /agents/bob/api/api/sessions/{id}/chat/stream`→스트림 라우트. 각 테스트 이벤트명·`run.started`(run_id)·approval/stop·tool 실패 상세 갱신. `test_resume_passes_history_to_runs`→**`{message}` 바디 검증**(conversation_history 제거)으로 대체. reasoning 미표시 검증 추가.
- [x] **S7 — `tests/integration/test_cli_daemon_e2e.py`**: 인라인 fake hermes에 `POST .../chat/stream`(named SSE: run.started/assistant.delta/tool.*/assistant.completed/run.completed/done) 추가, 기존 `/v1/runs` 대신 사용하도록 chat 테스트 갱신.
- [x] **S8 — (별도 커밋, Q2=A) `web/src/pages/chat/ChatView.tsx` hydrate-outage 수정**: `submit()` catch에서 `toast('error', …)`(영속 표면) + `setInput(text)`(입력 복원) 추가 → 부분 장애 시 finally hydrate가 라이브 버퍼를 비워도 피드백·메시지 생존. hydrate 로직 무변경.
- [x] **S9 — 검증 + 요약**: `ruff`/`mypy`(strict)/`pytest`(cli unit+integration) 그린. S8: web `tsc`/`eslint`/`vitest`/`build`(web_dist)/`e2e` 그린. 재설치 게이트웨이로 `caduceus chat test` 수동 스모크(스트리밍/stop/approval/tool 실패). `code-summary.md`.

## 비목표 / 가드
- `resolve_session`·`--session`/`--new`·`cli/client.py`·`cli/sse.py` 무변경(이미 충족).
- reasoning 표시 안 함(Q1=B3). 멀티모달·룸 무관.
- CLI 커밋과 웹 hydrate 수정 커밋 **분리**.

## 완료 기준
- `caduceus chat`이 sessions/chat/stream 1-콜로 턴 수행(네이티브 히스토리), run.started run_id로 stop/approval, tool 실패 상세 유지, reasoning 미표시. 웹 hydrate 수정 별도 커밋. 전 검증 그린.
