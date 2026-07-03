# U3 CLI — Logical Components

**Date**: 2026-07-03

## 모듈 구조 (`caduceus/cli/`)

| 모듈 | 책임 | 패턴 | 검증 |
|---|---|---|---|
| `main.py` | typer 앱 루트 — 커맨드 그룹 등록, 글로벌 플래그(`--json`/`--no-color`/`-q`/`--debug`), completion, 최상위 오류 핸들러(P2 테이블 통과 유일 지점) | P1, P4 | CliRunner 표면 계약 (PU3-7) |
| `client.py` | `ClientConfig` 해석(env→config.yaml→기본값) + `ApiClient` — Admin API 전 호출 메서드, 잡 폴링 루프(`wait_job`), 401/404/409/연결 예외를 도메인 예외로 변환 | P5, P10 | MockTransport 계약 테스트 |
| `errors.py` | `CliError` 계층 + **exit code 단일 테이블** + 최상위 매퍼 (전역성) | P2 | **PU3-1** oracle |
| `output.py` | `Renderer` — rich Console 주입, redact 필터 단일 경로, 사람 표/`--json` stdout 순수성, 비-TTY 강등, 잡 스텝 diff→렌더 액션 순수 함수 | P6, P10 | **PU3-2, PU3-4** |
| `sse.py` | SSE 라인 파서 (순수 — bytes 스트림 → 이벤트 dict 이터레이터) | — | **PU3-3** fuzzing |
| `chat.py` | chat REPL — 세션 결정(Q4=A), 인터럽트 **상태 기계(순수 전이 함수 + 실행자 분리)**, approval y/n, ScreenElement 렌더 호출 | P3, P5 | **PU3-5** RuleBasedStateMachine + 스크립트된 SSE example |
| `tail.py` | logs -f 중첩 dedup 알고리즘 (순수 함수: 이전 창 × 새 창 → 신규 라인) | P8 | **PU3-6** |
| `bootstrap.py` | `init`(멱등 홈/토큰/upstream 마법사 — core config/auth 재사용), `doctor`(6항목), `ui`(브라우저 폴백 체인), detach 유틸(double-fork·pid 파일·stale 판별) | P7, P9 | example (fake 파일시스템·프로세스 검사 주입) |
| `serve_cmd.py` | `serve`/`serve stop`/`serve status` — daemon lazy import(CLI-D2 유일 허용 지점) | P4, P9 | example + 실물은 integration |
| `commands/agent.py` | `agent *` 커맨드 그룹 (create/ls/status/start/stop/rm/logs/soul/skills/toolsets/token) — 전부 thin | P1 | CliRunner |
| `commands/gateway.py` | `gateway status / upstream get·set` | P1 | CliRunner |
| `commands/job.py` | `job ls / status / wait` | P1 | CliRunner |

## 의존 규칙 (강제)

```
main.py → commands/* → client.py, output.py, errors.py
chat.py → sse.py, client.py, output.py
bootstrap.py → caduceus.core.{config, auth 파일 생성, hermes_adapter.preflight, redact}   # CLI-D3
serve_cmd.py → caduceus.daemon (lazy, 함수 본문 내 import)                                  # CLI-D2
금지: caduceus.proxy / caduceus.control import (serve_cmd의 daemon 경유 제외)               # CLI-D1
금지: output.py 우회 출력 (print/console 직접 사용)                                          # P6
```

- `client.py`·`errors.py`·`sse.py`·`tail.py`·상태 기계 전이 함수는 **typer/rich 비의존** (순수 코어) — PBT가 CLI 실행 없이 단위 검증 (U3-MAINT-2)

## 인프라 컴포넌트

큐·캐시·서킷브레이커 등 별도 인프라 컴포넌트 **없음** — stateless 단명 프로세스. 유일한 로컬 산출물은 detach 실행물(pid 파일·로그 파일, CLI-D6 예외)과 `soul --edit` 임시파일(0600, 즉시 삭제 — U3-SEC-4).

## 테스트 컴포넌트 (`tests/`)

| 컴포넌트 | 용도 |
|---|---|
| `cli_harness` fixture | CliRunner + MockTransport 배선 + capture Console — 커맨드 계약 일괄 검증 |
| 스크립트된 SSE transport | chat 파이프라인 example (델타·thinking·tool·approval·절단 시나리오) |
| 잡 스냅샷 생성기 (Hypothesis) | U2 상태 기계 유효 전이만 생성 — PU3-2 입력 |
| SSE fuzzer (Hypothesis) | 임의 바이트/이벤트 스트림 — PU3-3 |
| `test_cli_real_daemon` (`-m integration`) | 실 데몬+hermes 대상 create→chat→rm E2E (U3-TEST-4, Build & Test 실행) |
