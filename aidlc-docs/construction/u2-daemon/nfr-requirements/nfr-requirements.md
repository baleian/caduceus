# U2 Daemon — NFR Requirements

**Date**: 2026-07-03

## 성능
- 프록시 오버헤드(수신→업스트림 전달 개시): p50 <5ms, p99 <20ms (TokenResolver 인메모리 캐시 — U1 <1ms 목표와 정합)
- Admin API: p50 <50ms (레지스트리/상태 캐시 조회)
- 스트리밍: 무버퍼 중계 — 첫 바이트 지연 = 업스트림 + 프록시 오버헤드. 청크 단위 즉시 flush
- 상태 합성: 캐시된 health/process 상태 사용 (요청 시 실측 안 함 — `?probe=1` 옵션만 즉시 폴링)

## 동시성·규모
- asyncio 단일 프로세스·단일 이벤트 루프. 에이전트 수 상한 없음(N10), 동시 스트림은 OS fd 한도까지
- 프로비저닝은 직렬 큐(의도적 — 경합 제거), 프록시/조회 경로는 완전 병렬
- httpx AsyncClient 연결 풀 재사용 (업스트림 1개 + 에이전트별 api_server)

## 신뢰성 (N4, RESILIENCY-06/10)
- 타임아웃: 업스트림 connect 10s / 스트림 유휴 120s / 논스트림 총 600s. 에이전트 api_server: health 5s, chat 중계는 스트림 유휴 120s. 전부 설정 오버라이드 가능
- `GET /healthz` — 데몬 liveness(공개). `GET /api/status` — deep(레지스트리·프로세스·에이전트 health 요약) (RESILIENCY-06 shallow/deep)
- graceful shutdown ≤30s (run stop best-effort 5s + 자식 SIGTERM grace 15s + 여유)
- 이중 실행 차단: listen 포트 바인드 실패 시 명확한 오류로 종료

## 보안 (N3)
- FD-U2 규칙군(A1~A5, B1~B4, P1~P4, R1~R5) 그대로 구현 의무
- uvicorn은 127.0.0.1 바인드 고정(설정의 listen.host 기본), 프록시 헤더 신뢰 없음
- 의존성 추가분(fastapi/uvicorn/httpx)은 uv.lock 갱신 (SECURITY-10)

## 유지보수성 (N7)
- 2-플레인 경계 유지: `caduceus/proxy/`는 `caduceus/control/`을 import하지 않음 (접점 3개: reload/invalidate/EventSink)
- 라우트 핸들러는 얇게 — 로직은 서비스 클래스(단위 테스트 가능), FastAPI 의존성 주입으로 포트 페이크 치환
- API 계약 = pydantic 스키마 (OpenAPI 자동 문서 부산물로 획득)

## 확장 규칙 컴플라이언스 (이 단계)
- PBT-09 ✅ (Hypothesis + RuleBasedStateMachine — PU2-3)
- RESILIENCY-10 ✅ 타임아웃 체계 확정 / RESILIENCY-06 ✅ shallow+deep health 설계
- SECURITY-10 ✅ lock 갱신 방침 / 나머지는 코드 단계 검증
