# U3 CLI — NFR Requirements

**Date**: 2026-07-03
**결정 근거**: u3-cli-nfr-requirements-plan.md (Q1=A typer, Q2=A rich, Q3=A completion 포함)
**상속**: 전역 NFR N1~N10, Security/Resiliency/PBT Baseline (블로킹), U1/U2 승인 스택

## 1. 성능

| ID | 요구사항 | 측정 |
|---|---|---|
| U3-PERF-1 | cold start < 300ms (`caduceus --help`, `agent ls` 기준) — 서브커맨드별 lazy import: `serve`만 fastapi/uvicorn/daemon을, `chat`만 렌더 파이프라인 전체를 import | `python -X importtime` 스팟 체크 (Build & Test) |
| U3-PERF-2 | chat 스트리밍 무버퍼 체감 — SSE 델타 수신→화면 출력 지연 < 50ms (배치·정렬 지연 금지) | 수동 검증 + 렌더 경로에 버퍼링 코드 부재 리뷰 |
| U3-PERF-3 | 잡 폴링 0.5s / logs -f 폴링 1s — 데몬 부하 무시 가능 수준 (loopback 단건 GET) | 설계 고정값 |

## 2. 신뢰성 (Resiliency Baseline 적용)

| ID | 요구사항 |
|---|---|
| U3-REL-1 | **인터럽트 안전**: 임의 시점 Ctrl+C에서 세션·잡·레지스트리 등 서버측 상태를 파괴하지 않음 (PU3-5). 잡 대기 중단 시 잡 지속 사실 안내 (CLI-C5) |
| U3-REL-2 | **부분 출력 보존**: 스트림 절단·stop 시 이미 수신한 델타는 화면에 남김. 절단 후 세션 보존 안내 및 idle 복귀 (business-logic §3) |
| U3-REL-3 | **타임아웃 체계**: 연결 5s / 일반 읽기 30s / 스트리밍·잡 대기 읽기 무제한 (데몬이 상태 소유 — CLI가 임의 포기하지 않음) |
| U3-REL-4 | **재시도 없음**: 멱등성 보장이 없는 명령(create/rm 등)의 자동 재시도 금지 — 실패는 즉시 보고 (E4 정합). 조회형도 재시도 없이 exit 3 (사용자 재실행이 단순·명확) |
| U3-REL-5 | **detach 기동 검증**: `serve -d`는 `/healthz` 응답 확인까지가 성공 — 자식 기동 실패를 부모가 침묵 통과하지 않음 |

## 3. 보안 (Security Baseline 적용)

| ID | 요구사항 |
|---|---|
| U3-SEC-1 | 토큰 취급 CLI-P1~P4 그대로 (원문 전면 비표시, 이중 redact, api_key 값 즉시 폐기) |
| U3-SEC-2 | admin.token 읽기 시 파일 권한 확인 — 0600이 아니면 경고 (진행은 허용, doctor에서 ✗ 항목) |
| U3-SEC-3 | `ui`는 토큰을 URL·클립보드에 넣지 않음 (U4에서 Web UI 인증 확정 전까지) |
| U3-SEC-4 | `soul --edit` 임시파일은 0600으로 생성, 편집 종료 후 즉시 삭제 (persona에 민감 지침이 포함될 수 있음) |
| U3-SEC-5 | 데몬 응답의 터미널 출력 시 제어문자 이스케이프 (로그·soul 본문 경유 터미널 이스케이프 시퀀스 주입 방어) — rich 기본 동작 활용 |

## 4. 이식성·운영 (N1, N4)

| ID | 요구사항 |
|---|---|
| U3-PORT-1 | Linux(WSL2)·macOS 1급 지원. `serve -d`(double-fork)·pid 처리 POSIX 전용 — Windows 미지원은 문서화된 예외 (CLI-D5) |
| U3-PORT-2 | 비-TTY 완전 동작: 파이프·CI에서 색/스피너 자동 강등(rich 내장), `--json` stdout 순수성 (PU3-4), 비-TTY `rm`은 `--yes` 강제 |
| U3-PORT-3 | `NO_COLOR`/`--no-color` 준수 (rich 내장 + 전역 플래그 연결) |
| U3-PORT-4 | 브라우저 오픈: `xdg-open`(Linux)/`open`(macOS)/`wslview` 폴백(WSL2), 전부 실패 시 URL 출력만 |

## 5. 테스트 전략 (PBT Baseline — 블로킹)

| ID | 요구사항 |
|---|---|
| U3-TEST-1 | PU3-1~7 전부 Hypothesis 구현 (PU3-5는 RuleBasedStateMachine) |
| U3-TEST-2 | 커맨드 계약 테스트: typer CliRunner로 표면 전체 — 인자 파싱·exit code·stdout/stderr 분리 검증. HTTP는 httpx MockTransport 주입 |
| U3-TEST-3 | chat 파이프라인: 스크립트된 SSE 스트림(fake transport)으로 렌더·인터럽트·approval 플로우 example 테스트 |
| U3-TEST-4 | 실물 통합(`-m integration`): 데몬+실 hermes 대상 `create→chat→rm` CLI E2E — Build & Test 단계에서 실행 |
| U3-TEST-5 | mypy strict·ruff 통과 (U1/U2와 동일 게이트) |

## 6. 유지보수성

| ID | 요구사항 |
|---|---|
| U3-MAINT-1 | 커맨드 함수는 thin — 파싱→ApiClient 호출→렌더 위임. 비즈니스 로직 불포함 (판단은 데몬 소유) |
| U3-MAINT-2 | 렌더·API 클라이언트·커맨드 정의를 모듈 분리 — PU3 속성 테스트가 렌더/매핑을 CLI 실행 없이 단위 검증 가능하게 |
| U3-MAINT-3 | exit code·오류 매핑은 단일 모듈의 단일 테이블 (PU3-1 oracle 대상) — 커맨드별 산재 금지 |
