# U3 CLI — NFR Requirements Plan

**Date**: 2026-07-03
**Unit**: U3 CLI (C8 — `caduceus/cli/`)
**입력**: u3-cli/functional-design/ 3종 (커맨드 트리·잡 렌더·chat 파이프라인·PU3-1~7), 기존 스택 확정분 (Python ≥3.11, uv, httpx, pydantic, Hypothesis, pytest/mypy strict/ruff — U1/U2에서 승인)

## Plan Steps

- [x] Step 1: NFR 질문 답변 수집·분석 (Q1=A typer, Q2=A rich, Q3=A completion 포함 — 모호성 없음)
- [x] Step 2: `nfr-requirements.md` — 성능(시작 시간·스트리밍 체감), 신뢰성(인터럽트 안전·부분 출력 보존), 보안(토큰 취급·TTY 판별), 이식성(Linux/WSL2/macOS·비-TTY), 테스트 전략(PU3 PBT + CLI 계약 테스트)
- [x] Step 3: `tech-stack-decisions.md` — 프레임워크·렌더 라이브러리 결정 기록 + 근거
- [x] Step 4: 완료 메시지 제시 및 승인 대기

## 사전 결정 (기존 승인 스택 계승 — 질문 불필요)

- **HTTP 클라이언트**: httpx 재사용 (U2 기존 의존 — 신규 의존 0). CLI는 **동기 클라이언트** 사용 — 단일 사용자 대화형 도구에 asyncio 불필요, KeyboardInterrupt(Ctrl+C) 처리가 동기 흐름에서 단순·결정적 (PU3-5 상태 기계 구현 용이)
- **SSE 파싱**: 수제 파서 (~30줄, `data:`/`event:` 라인 규격) — httpx-sse 의존 회피 (P4). PU3-3 fuzzing 대상
- **시작 시간 예산**: cold start < 300ms 목표 — 서브커맨드별 lazy import (fastapi/uvicorn은 `serve`에서만 import — CLI-D2 경계와 일치)
- **테스트 전략**: pytest + Hypothesis 계승. HTTP 계층은 httpx `MockTransport`(U2 테스트와 동일 기법), 커맨드 계약은 프레임워크 러너로 stdout/stderr/exit code 검증, PU3-1~7 전부 PBT
- **패키징**: 동일 패키지 `[project.scripts] caduceus = "caduceus.cli.main:main"` 추가 (U1 결정 계승)

---

# NFR 질문 — U3

## Question 1: CLI 프레임워크

커맨드 트리가 3단(`agent soul <name> --edit` 등) + 글로벌 플래그 + `-h` 전면 제공 규모입니다.

A) **typer (권장)** — 타입 힌트 기반 선언(mypy strict와 시너지), 서브커맨드 그룹 자연 표현, shell completion 내장, 테스트 러너(CliRunner) 제공. 의존 +1 (click 포함)

B) **click** — 성숙·경량, completion·CliRunner 동일 제공. 데코레이터 스타일. 의존 +1

C) **argparse (stdlib)** — 신규 의존 0 (P4 최대 정합). 대신 3단 트리·타입 변환·completion을 수제 관리 (코드량·유지보수 비용 증가)

[Answer]: A

## Question 2: 터미널 렌더 라이브러리

잡 진행률(스텝 스피너/✓✗), chat 렌더(dim thinking, 색상, 라인 갱신)가 필요합니다.

A) **rich (권장)** — 스피너·색·Live 갱신·비-TTY 자동 강등을 검증된 구현으로. `NO_COLOR` 표준 준수 내장. 의존 +1. CLI UX 품질이 이 도구의 일상 체감을 결정 (F10)

B) **최소 ANSI 자체 구현** — 의존 0. dim/색/스피너를 이스케이프 코드 수제 관리 + TTY 판별·NO_COLOR 직접 처리 (PU3 렌더 속성 테스트 표면이 넓어짐)

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 3: shell completion 제공 범위

A) **v1 포함** — bash/zsh completion 스크립트 생성 커맨드 제공 (Q1=A/B면 프레임워크 내장 기능 활성화만 — 비용 근사 0. Q1=C면 수제 구현 필요)

B) **v1 제외** — 후속 버전에서

[Answer]: A
