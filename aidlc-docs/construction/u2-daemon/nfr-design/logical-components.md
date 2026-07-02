# U2 Daemon — Logical Components

**Date**: 2026-07-03
**모듈 경로**: `caduceus/proxy/`, `caduceus/control/`, `caduceus/daemon.py`

## 내부 논리 컴포넌트 (파일 단위 계획)

### Data plane — `caduceus/proxy/`
| 컴포넌트 | 파일 | 책임 |
|---|---|---|
| Upstream Client | `upstream.py` | httpx AsyncClient 보유, 원자적 핫스왑, 타임아웃 설정, api_key_env 해석 |
| Proxy Service | `service.py` | `/v1/*` 파이프라인: 토큰 resolve → 재작성 → 스트림/논스트림 중계 → 사용량 추출 → TrafficEvent. 오류 매핑 테이블(PU2-5) |
| Proxy Routes | `routes.py` | FastAPI 라우터 (얇음 — service 위임) |
| Traffic Stats | `traffic.py` | AgentTraffic 카운터·링버퍼(PU2-2), totals 합산 |

### Control plane — `caduceus/control/`
| 컴포넌트 | 파일 | 책임 |
|---|---|---|
| Event Bus | `events.py` | pub/sub + 리플레이 버퍼(PU2-6), EventSink 구현(U1 포트) |
| Job Engine | `jobs.py` | Job/JobStep 상태 기계(PU2-3), 직렬 워커 큐 |
| Provisioner | `provisioner.py` | create/remove 파이프라인 오케스트레이션 (U1 core 호출만) |
| Lifecycle Service | `lifecycle.py` | start/stop(graceful run-stop), 상태 합성(PU2-1 테이블), logs 중계 |
| Health Prober | `prober.py` | 주기 폴링·연속 실패 카운트·health.changed 이벤트 (FD8) |
| Reconciler | `reconciler.py` | 드리프트·고아 감지, 제한적 재기동(R5) |
| Admin Auth | `auth.py` | admin.token 로드/생성, 상수시간 검증 미들웨어 (A1~A4) |
| Admin API | `api.py` | REST 라우터(C5 계약, B1~B4), WS `/api/events` |
| Agent Chat Proxy | `agent_proxy.py` | `/agents/{name}/api/*` 중계 (경로 격납 PU2-4, api_server_key 부착) |

### 조립 — `caduceus/daemon.py`
- composition root: 설정/토큰/레지스트리 로드 → 컴포넌트 조립(2-플레인 접점 3개) → FastAPI 앱 구성(미들웨어→라우터) → uvicorn 실행 → startup/shutdown 훅 (§logic-5)
- `[project.scripts] caduceusd = "caduceus.daemon:main"` 등록

## 의존 규칙 (강제)
- `proxy/*` → `core`만 (control import 금지). control과의 접점: TrafficEvent(EventSink), TokenResolver 캐시 무효화 콜백, upstream reload 함수 — daemon.py가 배선
- `control/*` → `core` + proxy의 공개 함수 2개(reload/invalidate)만
- 라우터는 서비스 호출만 (비즈니스 로직 없음)

## 테스트 전략 매핑 (PBT-10)

| 대상 | PBT | Example | 통합 |
|---|---|---|---|
| traffic.py | PU2-2 (단조·합산·링버퍼) | 사용량 null 처리 | — |
| jobs.py | PU2-3 (RuleBasedStateMachine — 모델 비교) | 실패 중단·순서 | — |
| lifecycle.py | PU2-1 (진실 테이블 전 조합 oracle) | E3 unknown 케이스 | — |
| agent_proxy.py | PU2-4 (경로 격납·프리픽스 거부) | 헤더 부착 검증 | — |
| service.py 오류 매핑 | PU2-5 (클래스→응답 테이블) | 401/502/504 케이스 | — |
| events.py | PU2-6 (보존·순서·리플레이) | WS 구독/해지 | — |
| HTTP 전 구간 | — | FastAPI TestClient/ASGI (페이크 업스트림·페이크 api_server 서버) | 실물 hermes 에이전트 1개 E2E (marker) |
