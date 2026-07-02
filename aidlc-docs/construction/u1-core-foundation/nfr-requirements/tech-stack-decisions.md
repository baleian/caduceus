# U1 Core Foundation — Tech Stack Decisions

**Date**: 2026-07-02 (사용자 확정: Q1=A, Q2=A, Q3=A)
**적용 범위**: U1 확정이지만 언어·패키징·검증·PBT는 프로젝트 전역 표준

| 영역 | 선택 | 근거 |
|---|---|---|
| 언어 | **Python ≥3.11** | AD-4 (hermes 생태계 정렬, 단일 언어) |
| 패키징·의존성 | **uv + pyproject.toml** (uv.lock 커밋) | SECURITY-10 lock, `uv tool install caduceus` 배포, 버전 고정 롤백(R8), hermes도 uv 사용 |
| 데이터 모델·검증 | **pydantic v2** | V1~V6 선언적 검증, registry JSON round-trip, U2 API 스키마 재사용 |
| YAML 처리 | **ruamel.yaml (round-trip 모드)** | FD2/G1 — 사용자 주석·포맷 보존 병합 쓰기 |
| PBT 프레임워크 | **Hypothesis** | PBT-09 (custom strategies, shrinking, seed 재현, pytest 통합) |
| 테스트 러너 | **pytest** (+ pytest-asyncio) | 표준. PBT/example 테스트 분리 규약은 PBT-10 준수 |
| 타입 체크 | **mypy (strict)** | N7 |
| 린트/포맷 | **ruff** (lint+format) | 단일 도구로 최소 표면적 (P4) |
| 로깅 | **stdlib logging + 구조화 포맷터**(JSON 옵션) | SECURITY-03 (timestamp/level/correlation id), 의존성 최소 |
| 프로세스 관리 | **asyncio.subprocess** | FD3 자식 프로세스 spawn/monitor — 외부 감독 라이브러리 불필요 |

## U1 런타임 의존성 (최종)
`pydantic>=2`, `ruamel.yaml` — 이상 2개 (P4: 최소 표면적)
개발 의존성: `pytest`, `pytest-asyncio`, `hypothesis`, `mypy`, `ruff`

## 유예 (해당 유닛에서 확정)
- U2: HTTP 프레임워크(FastAPI vs aiohttp), SSE/WS 처리, HTTP 클라이언트(httpx 등)
- U4: SPA 스택(프레임워크·빌드 도구)
