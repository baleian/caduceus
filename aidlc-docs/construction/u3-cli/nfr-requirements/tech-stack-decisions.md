# U3 CLI — Tech Stack Decisions

**Date**: 2026-07-03

## 신규 결정 (이 유닛)

| 영역 | 결정 | 근거 |
|---|---|---|
| CLI 프레임워크 | **typer** (Q1=A) | 타입 힌트 선언이 mypy strict와 시너지, 3단 서브커맨드 트리 자연 표현, CliRunner 테스트 러너, completion 내장. click을 내포하므로 실질 의존 +1군 |
| 터미널 렌더 | **rich** (Q2=A) | 스피너·색·Live 갱신·비-TTY 자동 강등·NO_COLOR 준수를 검증된 구현으로 (U3-SEC-5 제어문자 이스케이프 포함). F10 일상 UX 품질 |
| shell completion | **v1 포함** (Q3=A) | typer 내장 `--install-completion` 활성화 — 추가 구현 비용 근사 0 |
| HTTP 클라이언트 | **httpx 동기 API** (사전 결정) | 기존 의존 재사용. 동기 흐름에서 KeyboardInterrupt 처리가 결정적 — PU3-5 상태 기계 구현 단순화 |
| SSE 파싱 | **수제 파서** (사전 결정) | `data:`/`event:` 규격 ~30줄, httpx-sse 의존 회피 (P4). PU3-3 fuzzing 대상 |

## 계승 결정 (U1/U2 승인분 — 변경 없음)

- Python ≥ 3.11, uv + pyproject (uv.lock 커밋), pydantic v2 (API 응답 최소 파싱용 — 단 CLI-O2에 따라 재가공 스키마 금지, 필요 시 dict 직접 사용)
- pytest (asyncio_mode=auto, `-m 'not integration'` 기본), Hypothesis, mypy strict, ruff (동일 설정)
- 패키징: `[project.scripts] caduceus = "caduceus.cli.main:main"` 추가 (기존 `caduceusd`와 병행)

## 최종 런타임 의존성 (U3 반영 후)

pydantic, ruamel.yaml, fastapi, uvicorn, httpx, **typer, rich** — 7개 (신규 2)

## 기각 대안

| 대안 | 기각 사유 |
|---|---|
| argparse | 3단 트리·completion 수제 관리 비용 > 의존 1개 절감 이득 (사용자 결정 Q1=A) |
| click 단독 | typer가 동일 기반 위에서 타입 선언·completion을 더 적은 코드로 제공 |
| 자체 ANSI 렌더 | TTY 판별·강등·이스케이프 방어 재구현은 P4 취지(표면 최소화)에 오히려 역행 (사용자 결정 Q2=A) |
| asyncio CLI | 단일 사용자 대화형 도구 — 동시성 이득 없음, 인터럽트 복잡도만 증가 |
| httpx-sse | 파서 30줄 vs 의존 +1 — 수제 채택 |
