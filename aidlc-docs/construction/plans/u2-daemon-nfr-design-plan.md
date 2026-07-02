# U2 Daemon — NFR Design Plan

**Date**: 2026-07-03

## Plan Steps

- [x] Step 1: NFR Requirements 분석
- [x] Step 2: 질문 카테고리 평가 — **신규 질문 0건, 카테고리별 근거 아래 명시**
- [x] Step 3: `nfr-design-patterns.md` 생성
- [x] Step 4: `logical-components.md` 생성
- [x] Step 5: 완료 메시지 제시 및 승인 대기

## 질문 카테고리 평가 (Step 2 근거 — 신규 질문 불필요)

| 카테고리 | 평가 결과 |
|---|---|
| Resilience Patterns | 기확정 — 타임아웃 체계(R1), fail-closed(R2), graceful shutdown(R4), reconcile 제한적 자동 조치(R5), 백오프는 U1 process_manager 소관 |
| Scalability Patterns | 기확정 — asyncio 병렬 + 프로비저닝 직렬 큐(의도), 상한 없음(N10). 스케일아웃 불요(단일 호스트 데몬) |
| Performance Patterns | 기확정 — 인메모리 토큰 캐시, 무버퍼 스트리밍, 캐시 기반 상태 조회, 연결 풀 재사용 |
| Security Patterns | 기확정 — A1~A5(이중 토큰 체계·권한 분리), B1~B4, P1~P4 + 문서화된 예외 4건 |
| Logical Components | 외부 인프라 컴포넌트 없음 (인메모리 EventBus/큐로 충분 — FD5). 내부 컴포넌트 구성만 구체화 (logical-components.md) |

**Infrastructure Design (다음 스테이지) 판정 — U2 스킵**: 클라우드 리소스 없음. Docker 토폴로지·네트워킹은 U1 렌더러가 소유(FD 확정), CI/CD 파이프라인(R7)은 Build & Test 산출물. → U2는 NFR Design 승인 후 바로 Code Generation
