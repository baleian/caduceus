# U2 Daemon — Functional Design Plan

**Date**: 2026-07-03
**Unit**: U2 Daemon (C1 Proxy Plane, C3 Provisioner, C4 Lifecycle & Health, C5 Admin API + EventBus — `caduceus/proxy/`, `caduceus/control/`, `daemon.py`)
**입력**: services.md S1~S6, component-methods.md C1/C3/C4/C5 계약, U1 core 공개 API

## Plan Steps

- [x] Step 1: 설계 질문 답변 수집·분석 (Q1=A 인메모리 집계 → FD5, Q2=A admin 토큰 → FD6 — 모호성 없음)
- [x] Step 2: `domain-entities.md` — Job/이벤트 스키마, TrafficStats, AdminAuth, HealthState 판정
- [x] Step 3: `business-logic-model.md` — 프록시 파이프라인·핫스왑, 프로비저닝(FD7 기록 후치·E4 실패 의미론), 상태 합성 진실 테이블, reconcile·고아 감지, chat 중계, 데몬 수명주기 + Testable Properties PU2-1~6 (PBT-01)
- [x] Step 4: `business-rules.md` — 인가 A1~A5, 검증 B1~B4, 프라이버시 P1~P4, 신뢰성 R1~R5, 문서화된 예외
- [x] Step 5: 완료 메시지 제시 및 승인 대기

## 사전 결정 (질문 불필요 — 근거 명시, 아티팩트에 상세)

- **프로비저닝 레지스트리 기록 시점**: 설정·프로필 준비가 모두 성공한 **후** `registry.add` → 이후 gateway 기동 (중간 크래시 시 레지스트리에 미완성 레코드가 남지 않음. 고아 profile/컨테이너는 reconcile이 `cad-` 네임스페이스로 감지·경고 — FD1의 이점 활용, E4 정합)
- **Health 판정 기본값**: 폴링 주기 = reconcile.interval_s(30s), 연속 3회 실패 → `unreachable`, `/health` 200 = healthy (파라미터는 설정 가능)
- **Chat 중계**: api_server 엔드포인트 그대로 pass-through (세션/runs/stop/approval 무변형), `API_SERVER_KEY` 서버측 부착 — 기확정(AD-3, S2 플로우)

---

# 설계 질문 — U2

## Question 1: LLM 트래픽 사용량 데이터 취급 (F4 확장 기반)
프록시가 관찰하는 사용량 메타데이터(에이전트별 요청 수·토큰 사용량·latency)를 어떻게 다룰까요? R4에서 향후 모니터링·감사·버짓 제한의 기반이라 하셨습니다.

A) **인메모리 집계만** (MVP 권장) — 데몬 생존 동안의 누적 카운터 + 최근 요청 링버퍼. WS 이벤트·상태 API로 노출. 재시작 시 초기화. 영속 감사/버짓은 후속 버전에서 (스키마 여지만 확보)

B) **로컬 영속 집계** — SQLite(또는 JSONL append)로 요청 로그/일별 집계 저장. 감사·버짓의 기반이 지금부터 쌓임, 대신 의존성·상태·보존 정책 관리 추가

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 2: Admin API 인증 (N3, SECURITY-08)
CLI/Web UI가 사용하는 Admin API(`/api/*`)와 chat 중계(`/agents/*`)의 인증은? (게이트웨이 `/v1`은 에이전트 토큰으로 이미 인증됨)

A) **자동 생성 admin 토큰** (권장) — `caduceus init` 시 생성해 `~/.caduceus/`에 0600 저장. CLI는 자동 로드(무비용), Web UI는 최초 접속 시 한 번 입력(또는 `caduceus ui`가 토큰 포함 URL 오픈). loopback 바인딩 + 토큰의 2중 방어 — 같은 호스트의 다른 프로세스/사용자로부터 보호 (SECURITY-08 충족)

B) **loopback 신뢰만** — 127.0.0.1 바인딩 자체를 인증으로 간주, 토큰 없음 (최단순, 단 같은 호스트의 모든 로컬 프로세스가 제어 가능 — SECURITY-08 예외 문서화 필요)

C) Other (please describe after [Answer]: tag below)

[Answer]: A
