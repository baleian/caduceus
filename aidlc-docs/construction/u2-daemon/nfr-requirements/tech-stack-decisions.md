# U2 Daemon — Tech Stack Decisions

**Date**: 2026-07-03 (사용자 확정: Q1=A)

| 영역 | 선택 | 근거 |
|---|---|---|
| HTTP 서버 | **FastAPI + uvicorn** | pydantic v2 통합(U1 타입 재사용, B1 검증 무비용), WS 내장, StreamingResponse로 SSE/청크 중계 |
| HTTP 클라이언트 | **httpx (AsyncClient)** | 스트리밍(`client.stream`)·연결 풀·타임아웃 세분화(connect/read/write/pool) |
| WS 이벤트 | FastAPI WebSocket | `/api/events` 링버퍼 리플레이 + 실시간 |
| 상태 기계 PBT | Hypothesis `RuleBasedStateMachine` | PU2-3 (Job 상태 기계 모델 비교) |
| 기타 | U1 전역 표준 승계 (uv/pydantic/ruamel/pytest/mypy strict/ruff/stdlib logging) | |

## U2 추가 런타임 의존성
`fastapi`, `uvicorn`, `httpx` — 프로젝트 런타임 의존성 총 5개 (pydantic, ruamel.yaml 포함)

## 유예
- U4: SPA 스택 (U4 NFR에서 확정)
