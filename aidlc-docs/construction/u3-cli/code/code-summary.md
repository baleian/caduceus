# U3 CLI — Code Summary

**Date**: 2026-07-03
**검증**: ruff ✅ · mypy --strict ✅ (43 files) · pytest **431 passed** (U1+U2 회귀 포함, 실물 integration 4건은 `-m integration` 옵트인)

## 생성 파일 (`caduceus/cli/`)

| 모듈 | 내용 | 설계 계약 |
|---|---|---|
| `errors.py` | CliError + **exit code 단일 테이블**(0~5) + 전역 매퍼 (모든 오류 경로의 유일 관문) | P2, PU3-1 |
| `client.py` | ClientConfig 해석(env→config.yaml→기본값), ApiClient 전 메서드(동기 httpx, 무재시도), wait_job 0.5s 폴링, X-Confirm, agent 프록시 중계(`agent_api[_stream]`, 스트림 읽기 무제한) | U3-REL-3/4 |
| `output.py` | Renderer(Console 주입) — **redact 단일 경로**, `--json` stdout 순수성, 잡 스냅샷 diff 순수 함수, 비-TTY 강등 | P6/P10, PU3-2/4 |
| `sse.py` | 수제 SSE 파서(증분 UTF-8 디코더, 임의 청킹·garbage 내성, 절단 이벤트 미조작) | PU3-3 |
| `tail.py` | logs -f 중첩 dedup 순수 함수(회전=gap 보고, 침묵 유실 없음) | P8, PU3-6 |
| `chat.py` | **4-상태 순수 전이 함수**(interrupt→stop ≤1/turn, idle에서만 종료) + ChatApp REPL — 세션 재개(Q4=A), approval once/session/always/deny, 절단 시 세션 보존 복귀 | P3, PU3-5 |
| `bootstrap.py` | init 멱등(홈/config/admin.token 0600 + upstream 마법사 + key env 존재 검사), doctor 6항목(데몬 다운 시 skip 강등), ui 폴백 체인(webbrowser→wslview→URL 출력), pid 유틸(stale 판정), rm 확인 게이트(비-TTY는 --yes 강제) | CLI-C/D3, P7/P9 |
| `serve_cmd.py` | serve 포그라운드(daemon lazy import — CLI-D2 유일 지점)/`-d` double-fork+setsid+**healthz 검증 기동**(U3-REL-5)/stop(SIGTERM 1회+15s 관찰)/status | P9, Q2=B |
| `context.py` | AppState(ctx.obj), client/renderer 팩토리, finish() | |
| `commands/agent.py` | create/ls/status/start/stop/rm/logs(-f)/soul(--edit는 click.edit 0600 임시파일)/skills/toolsets/token rotate — 전부 thin | P1 |
| `commands/gateway.py` | status(트래픽 표)/upstream get·set(핫스왑) | |
| `commands/job.py` | ls/status/wait(--no-wait 이어받기) | |
| `main.py` | typer 루트(3단 트리, completion, -h 전면), 글로벌 플래그(--home/--no-color/-q/--debug/--version), **단일 오류 퍼널** main(argv) — click usage=2 정합, 스택트레이스 억제(--debug 예외) | P2/P4 |

- `pyproject.toml`: typer/rich 의존 + `[project.scripts] caduceus` 엔트리 (최종 런타임 의존 7)
- **U1/U2 in-place 변경 1건**: `load_or_create_admin_token`을 `control/auth.py` → `core/tokens.py`로 이동 (CLI init이 데몬 플레인 import 없이 토큰 생성 가능 — CLI-D1/D3. control.auth는 re-export로 U2 API 유지)

## 테스트

| 구분 | 파일 | 커버 |
|---|---|---|
| property | test_cli_errors(PU3-1 oracle·redact), test_cli_output(PU3-2 유효 전이 생성기·PU3-4 순수성), test_cli_stream(PU3-3 라운드트립+fuzzing·PU3-6 무중복무유실), test_cli_chat(PU3-5 **RuleBasedStateMachine**), test_cli_surface(PU3-7 유효/무효 커맨드라인) | **PU3-1~7 전부** |
| unit | test_cli_client(MockTransport 계약 13), test_cli_chat(스크립트 SSE 9 — approval/stop 1회/절단/미지 이벤트/DELETE 부재), test_cli_bootstrap(17 — init 멱등·doctor·stale pid·확인 게이트), test_cli_surface(**main(argv) 실 퍼널** 20 — exit code 전 경로·X-Confirm·토큰 비노출) | 규칙 CLI-P/C/O/E |
| integration(무마커) | test_cli_daemon_e2e — **uvicorn 스레드 실 HTTP** ↔ 실 U2 플레인(페이크 hermes): create→ls→status→rm 전 수명주기 + chat 릴레이 스트리밍 + 폐토큰 exit 3 | S1~S3 E2E |
| integration(marker) | test_cli_real_daemon — 실물 hermes+docker 대상 CLI 수명주기 (Build & Test 실행) | |

## FD 편차 (실 계약 검증 후 수정 — 근거: hermes api_server 소스)

1. **chat 전송 계약**: FD는 `POST /api/sessions/{id}/chat/stream` + `/v1/runs/{id}/stop` 조합을 가정했으나, 소스 확인 결과 세션 chat/stream 경로는 run을 stop 레지스트리에 등록하지 않아 stop이 404가 됨. → **`/v1/runs` 플로우로 구현**: 세션 히스토리를 `GET /api/sessions/{id}/messages`로 하이드레이션해 `conversation_history`로 전달(runs API는 자체 하이드레이션 없음 — turn_context 확인), 이벤트는 `GET /v1/runs/{id}/events`(data-only SSE), stop/approval 네이티브 동작. 전부 네이티브 엔드포인트 조합 (P1/P2 준수, 재구현 없음)
2. **start/stop 잡 대기 없음**: U2 실 구현이 202+`{ok}` 즉시 반환(잡은 create/rm만) — CLI도 요청 접수만 보고
3. **오류 본문 형태**: 단일 `{"error": {code,message}}`가 아닌 3형태(`{"error": str}`/`{"detail": str}`/OpenAI 중첩) 공존 — 매퍼가 전부 수용 (PU3-1 검증)

## 특기 사항

- cold start: lazy 경계 검증 완료(fastapi/uvicorn/daemon/control/proxy **미로드**). 절대 수치는 본 환경(WSL2 drvfs `/mnt/f`)의 I/O 지배로 <300ms 미달 — 네이티브 파일시스템 기준 재측정을 Build & Test에 이관. httpx(~55%)는 모든 원격 커맨드의 필수 의존이라 추가 지연 무의미
- `logs -f`의 반복 동일 라인 한계(중첩 모호성)는 tail.py docstring에 문서화 — gateway 로그는 타임스탬프 포함이라 실사용 무영향

## 잔여 사항
- CI 파이프라인·실물 integration 실행(cold start 재측정 포함) → Build & Test
- Web UI 정적 서빙 + `caduceus ui` 대상 화면 → U4
