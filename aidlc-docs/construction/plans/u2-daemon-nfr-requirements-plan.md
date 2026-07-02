# U2 Daemon — NFR Requirements Plan

**Date**: 2026-07-03

## Plan Steps

- [x] Step 1: HTTP 스택 질문 답변 수집·분석 (Q1=A — FastAPI+uvicorn+httpx, 모호성 없음)
- [x] Step 2: `nfr-requirements.md` — U2 NFR 확정 (프록시 성능·동시성·신뢰성·보안)
- [x] Step 3: `tech-stack-decisions.md` — U2 스택 확정 (런타임 의존성 총 5개)
- [x] Step 4: 완료 메시지 제시 및 승인 대기

## 사전 확정 (질문 불필요 — 근거)

- **성능 목표**: 프록시 오버헤드(토큰 조회+중계 시작) p50 <5ms/p99 <20ms (인메모리 캐시 — U1 NFR과 정합). Admin API p50 <50ms. 스트리밍 첫 바이트 지연 = 업스트림 지연 + 프록시 오버헤드
- **동시성**: asyncio 단일 프로세스 — 에이전트 수 상한 없음(N10), 동시 스트림 수는 OS fd 한도만
- **신뢰성·보안**: FD-U2 규칙군(A/B/P/R) 기확정. 타임아웃 값 §logic-1.1
- **PBT**: Hypothesis(전역 표준), stateful PBT(PU2-3)는 Hypothesis `RuleBasedStateMachine`

---

# 기술 스택 질문 — U2

## Question 1: HTTP 서버·클라이언트 프레임워크
데몬의 HTTP 표면(OpenAI 호환 `/v1` 스트리밍 프록시 + Admin REST + WS 이벤트 + chat SSE 중계)과 업스트림/에이전트 호출 클라이언트의 조합은?

A) **FastAPI + uvicorn (서버) / httpx (클라이언트)** (권장) — pydantic v2 네이티브 통합(U1 타입을 API 스키마로 그대로 사용, B1 규칙 무비용), WS 내장, 표준 생태계·문서화 우수. 스트리밍 프록시는 StreamingResponse + httpx.stream으로 구현. 의존성 3개 추가

B) **aiohttp 단일 (서버+클라이언트)** — 의존성 1개(P4 극대화), hermes gateway와 동일 스택(스트리밍 프록시 패턴 검증됨). 대신 pydantic 검증·WS 라우팅을 수동 배선(B1 구현 비용 증가)

C) **starlette + httpx** — FastAPI보다 경량, 대신 검증·문서화 수동

D) Other (please describe after [Answer]: tag below)

[Answer]: A
