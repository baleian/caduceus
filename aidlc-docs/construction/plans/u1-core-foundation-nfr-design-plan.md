# U1 Core Foundation — NFR Design Plan

**Date**: 2026-07-02

## Plan Steps

- [x] Step 1: NFR Requirements 분석
- [x] Step 2: 질문 카테고리 평가 — **신규 질문 0건, 카테고리별 근거 아래 명시**
- [x] Step 3: `nfr-design-patterns.md` 생성
- [x] Step 4: `logical-components.md` 생성
- [x] Step 5: 완료 메시지 제시 및 승인 대기

## 질문 카테고리 평가 (Step 2 근거 — 신규 질문 불필요)

| 카테고리 | 평가 결과 |
|---|---|
| Resilience Patterns | 기확정 — 백오프 재시작(L6, 1s→60s cap), fail-closed(E2), subprocess 타임아웃(hermes 60s/docker 30s), crashloop 차단. 추가 재시도 정책은 "단일 시도 + 명확한 오류"로 설계 (프로비저닝은 사용자 재시도 가능 작업 — 자동 재시도가 파괴적 부작용 위험) |
| Scalability Patterns | 기확정 — N10(상한 없음), 순차 포트 할당, 단일 JSON 레지스트리(수백 규모 충분, NFR §성능) |
| Performance Patterns | 기확정 — resolve_token 인메모리 캐시(<1ms), 레지스트리 <50ms. 추가 최적화 불요 (비핫패스) |
| Security Patterns | 기확정 — S1~S4, V6/P9 경로 방어, 인자 배열 subprocess, redaction |
| Logical Components | 신규 인프라 컴포넌트 없음 (큐·외부 캐시·서킷브레이커 불요 — 로컬 라이브러리 모듈). 내부 논리 컴포넌트만 구체화 (logical-components.md) |
