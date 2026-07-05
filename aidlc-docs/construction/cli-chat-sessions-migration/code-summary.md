# Code Summary — CLI `caduceus chat` → sessions/chat/stream

**Stage**: CONSTRUCTION — Code Generation (Part 2) · **Date**: 2026-07-06
**Scope**: `caduceus/cli/chat.py` + CLI 유닛/통합 테스트. **별도 커밋**: web `ChatView.tsx` hydrate-outage 수정.
`cli/client.py`·`cli/sse.py`·`cli/main.py`·`resolve_session` **무변경**.

## 무엇이 바뀌었나

CLI 챗 턴이 hermes **runs**(`GET /messages`+`_history`→conversation_history + `POST v1/runs` + `GET /events` data-only SSE)에서 **`POST api/sessions/{id}/chat/stream {message}`**(1-콜, named SSE, 서버 네이티브 히스토리 재생)로 전환. approval/stop은 `run.started`의 run_id로 기존 `/v1/runs/{id}/approval|stop` 재사용. **web과 동일한 sessions 백엔드 재사용**(별도 재구현 없음).

세션 해석(`resolve_session`: session_id optional / 최근 세션 resume / 자동 생성)과 `--session`/`--new` 플래그는 **이미 구현돼 있어 무변경**.

## 파일별 변경

| 파일 | 변경 |
|---|---|
| `caduceus/cli/chat.py` | `_turn`: 사전 `_messages_raw`+`_history`+`POST v1/runs`+`_turn_baseline` 제거 → `_consume_stream(session_id, message)` **완전 1-콜**(사후 GET도 없음). `_consume_stream`: `agent_api_stream("POST", chat/stream, json={message})` + `iter_sse` **named 이벤트**(`event.event`) 디스패치. `_dispatch(kind, data)`: `run.started`→run_id 캡처(+pending-stop 발화), `assistant.delta`→출력, `tool.started`→⚙, `tool.completed`/`tool.failed`→✓/✗(error=이름), `approval.request`→prompt/auto_deny, `assistant.completed`→최종 content fallback, **`run.completed`→이번 턴 role=tool 메시지 보관**, `error`→에러. **`tool.progress{_thinking}`(reasoning) 미표시(Q1=B3)**. `_interrupt()`(인자 제거)+신규 `_send_stop`: run_id 없으면 `_pending_stop`로 지연→run.started에서 발화. `_prompt_approval(payload)`: summary=command/description/tool_name. `_history`·`_messages_raw` 제거. `_render_tool_failures()`: **`run.completed.messages`(이번 턴 authoritative transcript, #34703)** 에서 tool 메시지를 취해 `!=` 정확-일치 가드로 페어링 — baseline·GET 불요, 멀티턴 오염·오귀속 원천 차단. |
| `tests/unit/test_cli_chat.py` | `sse()` named 프레임화, 하네스 `POST .../chat/stream` 라우트, 이벤트명·run.started(run_id)·approval/stop 경로·tool 실패 상세·reasoning 미표시 갱신. `test_resume_*`→**`{message}` 바디** 검증(conversation_history 제거). **신규**: stop-전-run.started **지연 stop** 테스트. |
| `tests/integration/test_cli_daemon_e2e.py` | 인라인 fake hermes에 `POST .../chat/stream`(named SSE) 라우트, `sse_bytes` named 포맷화. |
| `web/src/pages/chat/ChatView.tsx` (**별도 커밋**) | `submit()` catch에 `toast('error', …)`(영속 표면) + `setInput(text)`(입력 복원) → 부분 장애(POST 실패·GET 성공) 시 finally hydrate가 라이브 버퍼를 비워도 실패 피드백·메시지 생존. |

## 적대적 리뷰(5차원×refuter, 14 에이전트) 반영

확정 6건(반박 3건) → 조치:
- **수정 #1 (medium, correctness 회귀)** — tool 실패 페어링 가드를 last-N/`<`로 약화해 denied/dropped-frame로 store tool 메시지가 초과되면 **다른 도구에 실패 상세 오귀속**. → `run.completed.messages`(이번 턴 transcript, #34703)로 **정확 스코핑 + `!=` 가드** 복원. baseline/GET 제거 부수효과로 **멀티턴 오염(#3)도 원천 해소** + 완전 1-콜화.
- **커버리지 보강** — 웹 hydrate 수정 e2e(#2: 500→toast+입력 복원), auto_deny 2경로(#4), assistant.completed 중복 no-op 카운트 검증(#5), garbled-JSON 프레임 드롭(#6).
- **반박(무효)**: deny만 든 correctness 중복본, stop 확인 문구 상실(코스메틱), 스트리밍 중 draft 덮어씀(streamSessionChat이 mid-stream throw 안 함).

## 검증

- `ruff` clean · `mypy`(caduceus/cli, strict) clean · `pytest tests/unit`+통합 chat **308 passed**.
- web(별도 커밋): `tsc`/`eslint` clean · `vitest` **110/110** · `build`(web_dist 갱신) · **E2E 20/20**(hydrate-outage 포함).
- 실측(사용자): sessions 스트림 reasoning은 content 뒤 도착 → 콘솔은 재배치 불가라 **미표시 확정(Q1=B3)**.

## 확정 결정
- Q1=B3(reasoning 미표시) · Q2=A(웹 hydrate 수정, 별도 커밋) · Q3=A(`_history` 제거).

## 비목표 / 부가
- 세션 해석·플래그·`iter_sse`·`agent_api_stream`·POST 스트림 **이미 충족 → 무변경**.
- happy-path가 진짜 1-콜(tool 실패 시에만 사후 1 GET). 멀티모달·룸 무관.
