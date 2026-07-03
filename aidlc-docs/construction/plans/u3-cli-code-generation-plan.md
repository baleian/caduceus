# U3 CLI — Code Generation Plan

**Date**: 2026-07-03
**단일 진실 원천**: 이 플랜이 U3 코드 생성의 유일한 실행 목록이다.

## Unit Context

- **구현 요구사항**: F9/F10 (전 명령), F6 (chat 스트리밍 렌더·stop·resume), N4 (단일 도구 체감)
- **의존**: U1 core 공개 API (config/auth 파일·preflight·redact — CLI-D3 범위), U2 Admin API HTTP 계약 (REST/WS 아님 — 폴링), `caduceus.daemon` (serve 한정 — CLI-D2)
- **제공 계약**: `caduceus` 실행 파일 — 종료 코드 0~5 공개 계약, `--json` stdout 순수성
- **코드 위치**: `caduceus/cli/` (+ `tests/`)
- **설계 입력**: u3-cli/functional-design (커맨드 트리·매핑 전표·PU3-1~7·CLI-* 규칙), nfr-design (P1~P10 패턴, 12 모듈), tech-stack (typer/rich, httpx 동기, SSE 수제 파서)

## Generation Steps

- [x] **Step 1: 의존성 추가** — pyproject에 typer/rich 추가, `uv lock`/`sync`, `[project.scripts] caduceus = "caduceus.cli.main:main"` 엔트리
- [x] **Step 2: 오류 코어** — `cli/errors.py` (CliError 계층, exit code 단일 테이블, 최상위 매퍼 — P2)
- [x] **Step 3: 오류 코어 테스트** — PBT: PU3-1 (임의 예외·status·code 조합 → 전역성 oracle)
- [x] **Step 4: API 클라이언트** — `cli/client.py` (ClientConfig 해석 순서, ApiClient 전 메서드, wait_job 0.5s 폴링, X-Confirm, 타임아웃 체계 U3-REL-3)
- [x] **Step 5: API 클라이언트 테스트** — example: MockTransport로 전 메서드 계약·인증 헤더·오류 변환·폴링 종결
- [x] **Step 6: 렌더러** — `cli/output.py` (Renderer + Console 주입, redact 단일 경로 P6, 잡 스냅샷 diff→렌더 액션 순수 함수, 사람 표/JSON 모드, 비-TTY 강등)
- [x] **Step 7: 렌더러 테스트** — PBT: PU3-2 (잡 렌더 수렴 — U2 유효 전이 생성기), PU3-4 (JSON stdout 순수성 — capture console)
- [x] **Step 8: 순수 스트림 모듈** — `cli/sse.py` (SSE 파서), `cli/tail.py` (중첩 dedup — P8)
- [x] **Step 9: 순수 스트림 테스트** — PBT: PU3-3 (SSE fuzzing + 델타 재조립 oracle), PU3-6 (tail 무중복·무유실)
- [x] **Step 10: Chat** — `cli/chat.py` (순수 전이 함수 4-상태 기계 P3, REPL, 세션 결정 Q4=A, approval y/n, 절단 복귀)
- [x] **Step 11: Chat 테스트** — PBT: PU3-5 (RuleBasedStateMachine — stop ≤1/turn, idle에서만 종료, 세션 파괴 부재); example: 스크립트된 SSE 시나리오 (델타·thinking·tool·approval·절단·stop)
- [x] **Step 12: 부트스트랩** — `cli/bootstrap.py` (init 멱등·doctor 6항목·ui 폴백 체인·detach 유틸 P9), `cli/serve_cmd.py` (serve/-d/stop/status, daemon lazy import — CLI-D2)
- [x] **Step 13: 부트스트랩 테스트** — example: init 멱등성·doctor 판정·stale pid 판별 (fake 주입), 비-TTY 분기
- [x] **Step 14: 커맨드 표면 조립** — `cli/commands/{agent,gateway,job}.py` (thin — P1), `cli/main.py` (typer 루트, 글로벌 플래그, completion, 최상위 오류 핸들러 유일 지점, lazy import P4)
- [x] **Step 15: 표면 계약 테스트** — PBT: PU3-7 (유효/무효 커맨드라인 → 파싱·exit 2); example: CliRunner로 전 커맨드 계약 (rm 확인·--yes·비-TTY, --json stdout 순수성 재검, exit code 전 경로)
- [x] **Step 16: 통합 테스트** — 인프로세스 데몬(U2 build_daemon + 페이크 hermes/업스트림)에 CLI를 실 HTTP로 배선한 E2E (create→ls→chat→rm) + 실물 hermes CLI E2E (`-m integration`)
- [x] **Step 17: 문서화** — `aidlc-docs/construction/u3-cli/code/code-summary.md`
- [x] **Step 18: 로컬 검증** — ruff / mypy --strict / pytest 전체 통과 (U1+U2 포함 회귀), cold start 스팟 체크 (U3-PERF-1)

## 확장 규칙 반영 지점
- PBT-02~08: Steps 3/7/9/11/15 (PU3-1~7 전부)
- SECURITY-03: redact 단일 경로 Step 6, 토큰 비노출 전 스텝 / SECURITY-05: 입력 검증은 데몬 소유 — CLI는 파싱 계약(Step 15)
- RESILIENCY: 무재시도·인터럽트 안전 Steps 10/11, health-검증 detach Step 12
