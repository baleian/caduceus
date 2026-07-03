# U3 CLI — NFR Design Patterns

**Date**: 2026-07-03
**전제**: 신규 질문 0건 (u3-cli-nfr-design-plan.md 카테고리 전수 검토 — 전부 기결정에서 유도)

## P1. Thin Command (Humble Object)

커맨드 함수 = `파싱(typer) → ApiClient 호출 → Renderer 위임` 3줄 구조. 판단 로직(상태 합성·검증)은 데몬 소유(U3-MAINT-1), 렌더·매핑 로직은 순수 모듈로 추출 — typer/rich에 물리지 않은 코어가 PBT 대상이 된다 (U1 ports 패턴의 CLI 판).

## P2. 단일 오류 테이블 (Total Function)

`(예외 클래스 | HTTP status | API error code) → (메시지 방침, exit code)`를 **한 모듈의 한 테이블**로 고정 (U3-MAINT-3). 모든 커맨드는 최상위 핸들러 한 곳에서 이 테이블을 통과 — 커맨드별 try/except 산재 금지. PU3-1이 테이블의 전역성(어떤 입력도 정확히 하나의 결과)을 검증. U2 `ERROR_MAP`과 동형 구조.

## P3. 명시적 상태 기계 (인터럽트·잡 렌더)

- **chat**: `idle | streaming | stopping | awaiting_approval` 4-상태를 enum으로 명시, 전이 함수는 순수(현재 상태 × 이벤트 → 다음 상태 × 액션). KeyboardInterrupt는 이벤트로 변환되어 상태 기계에 주입 — 시그널 핸들러에 로직 두지 않음. PU3-5 RuleBasedStateMachine이 U2 jobs와 동일 기법으로 검증
- **잡 렌더**: 스냅샷 diff → 렌더 액션의 순수 함수 (PU3-2). rich Live는 액션의 실행자일 뿐

## P4. Lazy Import (시작 예산)

`cli/main.py`는 typer 등록만 — 무거운 import(fastapi/uvicorn/daemon, rich 렌더 파이프라인)는 커맨드 함수 본문 안에서 지연 로드 (U3-PERF-1 <300ms). 이 배치는 CLI-D2 경계(daemon import는 serve 한정)를 물리적으로 강제하는 효과 겸용.

## P5. Sync 경계

CLI 전체는 동기 실행 (httpx sync API) — KeyboardInterrupt가 스트림 read 지점에서 결정적으로 발생 (P3 상태 기계 입력으로 직결). 유일한 async 접점은 `serve`가 인프로세스로 넘기는 daemon 실행 경로(uvicorn이 소유) — CLI 코드에 이벤트 루프 관리 없음.

## P6. 출력 Redact 필터 (심층 방어)

사용자에게 향하는 모든 데몬 유래 텍스트(오류 메시지·잡 error·로그 라인)는 출력 직전 core `redact()`를 한 번 더 통과 (U3-SEC-1, CLI-P2). 구현 지점은 Renderer 단일 경로 — 우회 출력(`print` 직접 호출) 금지를 ruff 커스텀 규칙 대신 코드 리뷰 규칙으로 명시. rich 렌더는 제어문자 이스케이프를 기본 제공 (U3-SEC-5).

## P7. 무재시도·Fail-Fast

모든 명령: 실패 즉시 매핑된 메시지 + exit code (U3-REL-4). 재시도가 필요한 시나리오(데몬 기동 대기)는 유일하게 `serve -d`의 health 확인 루프(최대 10s)로 한정 — 이는 기동 검증이지 요청 재시도가 아님 (U3-REL-5).

## P8. 중첩 Dedup Tail

`logs -f`: 직전 스냅샷의 접미사와 새 스냅샷의 접두사 중첩을 찾아 신규분만 출력 (PU3-6). 중첩 미발견 = 로그 회전으로 간주하고 전체를 신규 처리 + 안내 1줄 — 침묵 유실 금지.

## P9. Health-검증 Detach (POSIX)

double-fork + setsid + 로그 파일 리다이렉트 → 부모는 pid 기록 후 `/healthz` 폴링(최대 10s)으로 기동을 **확인하고** 종료 (U3-REL-5). stale pid는 프로세스 생존 검사로 판별. `serve stop`은 SIGTERM 1회 + 15s 관찰만 (CLI-C6 — graceful은 데몬 소유).

## P10. 주입 가능한 Console/Transport (테스트 패턴)

- `Renderer`는 rich `Console`을 주입받음 — 테스트는 capture console로 출력 검증, `force_terminal`/`no_color`로 TTY 양태 강제 (U3-PORT-2/3 테스트 가능)
- `ApiClient`는 `httpx.Client`(transport 주입 가능)를 받음 — MockTransport로 전 계약 테스트 (U3-TEST-2)
- typer CliRunner가 프로세스 없이 exit code·stdout/stderr 분리 검증 (PU3-4)
