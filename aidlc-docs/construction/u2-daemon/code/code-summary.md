# U2 Daemon — Code Summary

**Date**: 2026-07-03
**검증**: ruff ✅ · mypy --strict ✅ (28 files) · pytest **347 passed** (실물 integration 3건은 `-m integration` 옵트인)

## 생성 파일

### Data plane (`caduceus/proxy/`)
| 파일 | 내용 | 설계 계약 |
|---|---|---|
| `traffic.py` | 인메모리 AgentTraffic 카운터·링버퍼(100)·totals — 본문 절대 비저장 | FD5, P1/P2, PU2-2 |
| `upstream.py` | httpx AsyncClient, 원자적 핫스왑(구 클라이언트 linger), api_key_env 해석(S4), 타임아웃 체계 | S4, R1 |
| `service.py` | 인증→재작성→중계 파이프라인, SSE/논스트림, usage 추출(추정 금지), **오류 매핑 테이블**(PU2-5), fail-closed 401 | logic §1.1, A2/R3 |
| `routes.py` | `/v1/{path:path}` thin 라우터 | |

### Control plane (`caduceus/control/`)
| 파일 | 내용 | 설계 계약 |
|---|---|---|
| `events.py` | EventBus — pub/sub + 리플레이 500, 발행 무전파(P4), EventSink 구현 | PU2-6 |
| `auth.py` | admin.token 생성/로드(0600), 상수시간 검증, deny-by-default 미들웨어(본문 파싱 전 401) | FD6, A1~A4 |
| `jobs.py` | Job 가드된 상태 기계 + 직렬 워커 큐, redact된 실패 사유 | PU2-3, E4 |
| `provisioner.py` | create 9단계(registry-add 후치 — FD7)/remove 4단계(워크스페이스 비접촉 — L3), preflight 게이트 | logic §2 |
| `lifecycle.py` | start/stop(graceful), **synthesize_status 순수 함수**(진실 테이블), logs | PU2-1, logic §3 |
| `prober.py` | FD8 판정(연속 3회 실패→unreachable), health.changed 이벤트, 루프 생존 보장 | RESILIENCY-06 |
| `reconciler.py` | 죽은 desired=running 재기동 1회(R5), 관리 키 드리프트, **cad-\* 고아 profile/컨테이너 감지** | S5, G2 |
| `agent_proxy.py` | chat 중계 — 경로 격납(allowed_subpath), API_SERVER_KEY 서버측 부착, SSE 무버퍼·절단 시 상류 취소 | PU2-4, S2/S3 |
| `api.py` | C5 REST 계약 전체 + WS `/api/events`(리플레이+실시간, WS 자체 인증) + X-Confirm(A5) + 레코드 공개 시 키/해시 제거(S3) | B1~B4 |

### 조립
- `caduceus/daemon.py` — build_daemon(테스트 주입 가능한 composition root, 2-플레인 접점 배선), 하드닝 미들웨어(1MB 제한 B1, nosniff), `/healthz`, startup(L7 desired 재기동)/shutdown(L1) 시퀀스, `caduceusd` 엔트리(uvicorn, access_log 비활성 — 자체 로깅 P3)
- U1 확장(in-place): `hermes_adapter.py`에 `container_state`/`list_container_profiles`/`list_profiles` 추가 (상태 합성·고아 감지 입력)

### 테스트
| 구분 | 파일 | 커버 |
|---|---|---|
| property | test_events_traffic(PU2-2·6), test_jobs(PU2-3 RuleBasedStateMachine), test_status(PU2-1 — 192 조합 전수), test_agent_proxy(PU2-4) | **PU2-1~6 전부** (PU2-5는 테이블 전수 example) |
| unit | test_events, test_proxy(페이크 업스트림 ASGI — 401/스트리밍/usage/오류 매핑/핫스왑), test_auth_jobs, test_provisioner_lifecycle, test_prober_reconciler | 규칙 A/B/P/R |
| integration(무마커) | test_daemon_asgi — **전 구간 3 시나리오**: 생성→/v1 LLM 호출→chat 중계→핫스왑→삭제(워크스페이스 보존)→폐토큰 401 / WS 리플레이·인증 / soul·toolsets·토큰 회전 | S1~S4 E2E |
| integration(marker) | test_daemon_real_hermes — 실물 hermes+docker 프로비저닝→중계→삭제 (Build & Test에서 실행) | |

## 특기 사항
- **run-stop 훅**: 데몬 종료 시 활성 run 명시 중단은 hermes gateway의 네이티브 SIGTERM graceful drain에 위임 (P2 — 재구현 회피). `RunStopFn` 시임은 향후 확장용으로 유지
- FastAPI 204 라우트는 `response_model=None` 명시 (스펙 준수)
- 남은 U1+U2 런타임 의존성: pydantic, ruamel.yaml, fastapi, uvicorn, httpx (5개)

## 잔여 사항
- CI 파이프라인 정의·통합 테스트 실행 → Build & Test (R7)
- CLI(`caduceus`) → U3, Web UI 정적 서빙 연결 + SECURITY-04 전체 헤더 → U4
