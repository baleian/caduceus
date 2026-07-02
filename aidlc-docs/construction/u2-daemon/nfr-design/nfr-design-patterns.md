# U2 Daemon — NFR Design Patterns

**Date**: 2026-07-03

## 적용 패턴

| 패턴 | 적용 지점 | 설계 |
|---|---|---|
| **Streaming pass-through proxy** | C1 프록시, chat 중계 | httpx `client.stream` → FastAPI `StreamingResponse` 청크 즉시 전달(무버퍼). 클라이언트 절단 감지 시 상류 취소 (리소스 누수 방지) |
| **Atomic client swap** | 업스트림 핫스왑 | 새 AsyncClient 생성·검증 → 참조 원자 교체 → 구 클라이언트는 진행 중 요청 완주 후 지연 close (S4) |
| **Serialized command queue** | Provisioner | asyncio.Queue + 단일 워커 태스크 — 프로비저닝 전 구간 직렬(경합·포트 중복 원천 차단). 조회 경로는 비차단 |
| **Publisher–Subscriber + replay buffer** | EventBus | in-proc 구독자(WS 세션들) + deque(500) 리플레이. 발행은 비차단·실패 무전파(P4) |
| **Cache-aside status** | 상태 합성 | prober가 백그라운드 갱신, API는 캐시 조회. `?probe=1`만 동기 실측 (성능 목표 달성 수단) |
| **Middleware chain (인증→검증→핸들러)** | Admin API | 인증 미들웨어(상수시간, A1~A3) → pydantic 검증(B1) → 얇은 핸들러 → 서비스 계층. 인증 실패는 본문 파싱 전 401 |
| **Two-plane composition root** | daemon.py | 조립 지점 한 곳에서 포트/서비스 주입 — proxy↔control 접점 3개만 배선 (테스트에서 페이크 조립 재사용) |
| **Bounded retry + explicit remediation** | reconcile | 자동 조치는 "죽은 desired=running 1회 재기동"만(R5). 그 외 이벤트로 사용자에게 위임 (자동 파괴 금지) |
| **Fail-closed error envelope** | 전 API | 도메인 예외 → 일반화된 오류 스키마 매핑 테이블(PU2-5). 스택·내부 경로 비노출, X-Request-Id로 로그 상관 |

## 명시적 비적용 (근거)

- **분산 큐/브로커·외부 캐시**: 단일 프로세스 인메모리로 충분 (FD5, P4)
- **서킷브레이커(업스트림)**: 단일 업스트림·로컬 도구 — 타임아웃+명확한 502/504가 사용자에게 더 유용. 상태성 차단기는 오히려 혼란 (RESILIENCY-10은 타임아웃으로 충족)
- **요청 재시도(프록시)**: LLM 호출은 비멱등(과금·부작용) — 재시도는 클라이언트(hermes) 판단에 위임

## 관측성 설계 (N5)

- 요청 로그: method/path(쿼리 제외)/status/latency/agent/X-Request-Id — 본문·토큰 없음 (P1/P3)
- 메트릭: TrafficStats + 프로세스 상태 + health 캐시 → `GET /api/status` 단일 요약 (deep health, RESILIENCY-06)
- 이벤트 스트림이 대시보드 실시간성의 단일 원천 (U3/U4 폴링 불필요)
