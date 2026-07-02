# U2 Daemon — Code Generation Plan

**Date**: 2026-07-03
**단일 진실 원천**: 이 플랜이 U2 코드 생성의 유일한 실행 목록이다.

## Unit Context

- **구현 요구사항**: F4(프록시), F1/F9(프로비저닝·라이프사이클 API), F6(chat 중계), F11 백엔드, N2~N5
- **의존**: U1 core 공개 API (registry/tokens/render/hermes_adapter/process_manager/workspace/config/ports)
- **제공 계약**: Admin REST/WS (C5 — U3 CLI·U4 Web UI가 소비), OpenAI 호환 `/v1`
- **코드 위치**: `caduceus/proxy/`, `caduceus/control/`, `caduceus/daemon.py`
- **설계 입력**: u2-daemon/functional-design (FD5~FD8, A/B/P/R 규칙, PU2-1~6), nfr-design (패턴·컴포넌트·의존 규칙), tech-stack (FastAPI/uvicorn/httpx)

## Generation Steps

- [x] **Step 1: 의존성 추가** — pyproject에 fastapi/uvicorn/httpx 추가, `uv lock`/`sync`, `[project.scripts] caduceusd` 엔트리
- [x] **Step 2: Event Bus** — `control/events.py` (pub/sub, 리플레이 500, EventSink 구현, 발행 무전파 P4)
- [x] **Step 3: Event Bus 테스트** — PBT: PU2-6 (보존·FIFO·리플레이 순서); example: 구독/해지·발행 실패 무전파
- [x] **Step 4: Traffic Stats** — `proxy/traffic.py` (AgentTraffic 카운터, 링버퍼 100, totals, 본문 비저장)
- [x] **Step 5: Traffic 테스트** — PBT: PU2-2 (단조 증가·합산 일치·링버퍼 경계) (steps 2–5: 8 passed)
- [x] **Step 6: Upstream Client + Proxy Service** — `proxy/upstream.py` (AsyncClient, 원자적 핫스왑, api_key_env 해석, 타임아웃), `proxy/service.py` (인증→재작성→중계, 스트림/논스트림, 사용량 추출 — 추정 금지, 오류 매핑 테이블), `proxy/routes.py`
- [x] **Step 7: Proxy 테스트** — PBT: PU2-5 (오류 클래스→응답 전사); example: ASGI 테스트(페이크 업스트림) — 401/스트리밍 중계/사용량 기록/핫스왑
- [x] **Step 8: Admin Auth + Job Engine** — `control/auth.py` (admin.token 생성/로드/상수시간 미들웨어), `control/jobs.py` (상태 기계, 직렬 워커 큐)
- [x] **Step 9: Auth·Jobs 테스트** — PBT: PU2-3 (RuleBasedStateMachine 모델 비교); example: 401 사유 무구분·토큰 파일 0600·큐 직렬성
- [x] **Step 10: Provisioner + Lifecycle** — `control/provisioner.py` (create 9단계/remove 4단계, FD7 기록 후치, E4 무롤백), `control/lifecycle.py` (start/stop graceful, 상태 합성 테이블, logs)
- [x] **Step 11: Provisioner·Lifecycle 테스트** — PBT: PU2-1 (진실 테이블 oracle 전 조합); example: 페이크 core로 파이프라인 단계·실패 중단·X-Confirm 의미론
- [x] **Step 12: Prober + Reconciler** — `control/prober.py` (FD8 판정), `control/reconciler.py` (드리프트·고아 감지, 재기동 1회 R5)
- [x] **Step 13: Prober·Reconciler 테스트** — example: 연속 실패 카운트·상태 전이 이벤트·고아 감지 (페이크 clock/http)
- [x] **Step 14: Agent Chat Proxy + Admin API** — `control/agent_proxy.py` (경로 격납, api_server_key 부착, SSE 중계), `control/api.py` (C5 REST 계약 전체 + WS /api/events + /healthz)
- [x] **Step 15: API 테스트** — PBT: PU2-4 (경로 격납·프리픽스 거부); example: TestClient로 전 라우트 계약·인증·검증·X-Confirm·WS 리플레이
- [x] **Step 16: Daemon 조립** — `caduceus/daemon.py` (composition root, startup/shutdown 시퀀스 §logic-5, 시그널 처리, 이중 실행 차단)
- [x] **Step 17: 통합 테스트** — ASGI 전 구간(페이크 업스트림+페이크 api_server로 생성→채팅 중계→정지 시나리오) + 실물 hermes E2E (marker `integration`)
- [x] **Step 18: 문서화** — `aidlc-docs/construction/u2-daemon/code/code-summary.md`
- [x] **Step 19: 로컬 검증** — ruff / mypy --strict / pytest 전체 통과 (U1 포함 회귀)

## 확장 규칙 반영 지점
- PBT-02~08: Steps 3/5/7/9/11/15 (PU2-1~6 전부)
- SECURITY-05/08/15: Steps 6/8/14 (검증·인증·fail-closed) / SECURITY-03: P1~P3 로깅 규칙 전 스텝
- RESILIENCY-06/10: Steps 6/12/16 (health·타임아웃·graceful)
