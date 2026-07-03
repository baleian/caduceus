# U4 Web UI — NFR Design Plan

**Date**: 2026-07-03
**Unit**: U4 Web UI (C9 — `web/` SPA + caduceusd 서빙 완성)
**입력**: u4-web-ui/nfr-requirements/ 2종 (U4-PERF/REL/SEC/MNT, React+TS+Vite+Tailwind 스택), functional-design 4종

## Plan Steps

- [x] Step 1: 질문 필요성 평가 — 카테고리 전수 검토 (아래 — 신규 질문 0건, 근거 명시)
- [x] Step 2: `nfr-design-patterns.md` — 패턴 카탈로그 WPT-1~12 (순수 코어/셸 분리, 단일 API 게이트, 멱등 리듀서, 백오프 재연결, 상태 기계 승계, redact 단일 경로, 낙관 원복, 가시성 연동 폴링, 자급 번들 강제, 주입 가능 경계, 확인 게이트, 서버 권위 렌더)
- [x] Step 3: `logical-components.md` — `web/src/` 모듈 구조·의존 규칙, 서버측 U4 변경점(정적 서빙+헤더), 테스트 컴포넌트 (PU4 속성별 검증 지점 매핑)
- [x] Step 4: 완료 메시지 제시 및 승인 대기

## 질문 카테고리 전수 검토 (신규 질문 0건 — 근거)

| 카테고리 | 판단 | 근거 (기결정) |
|---|---|---|
| Resilience Patterns | 질문 불필요 | 재연결 백오프+정합 복구(U4-REL-1), 절단 내성+원천 재하이드레이션(U4-REL-2/W7), 타임아웃 체계(U4-REL-3), 낙관 원복(U4-REL-4) 전부 FD/NFR에서 수치까지 확정 |
| Scalability Patterns | 해당 없음 | 단일 사용자 loopback SPA — 부하 표면은 데몬(U2) 소관. N10은 상한 미하드코딩으로 충족(가상화 기각 기록 존재) |
| Performance Patterns | 질문 불필요 | 번들 예산(U4-PERF-2), 프레임 배치 렌더(U4-PERF-3), O(1) 리듀서(U4-PERF-4), 폴링 가시성 규칙(U4-PERF-5) 확정 |
| Security Patterns | 질문 불필요 | U4-SEC-1~6 확정 (CSP/검증/인증/공급망/크리덴셜/fail-safe). 위협 모델(loopback 단일 사용자·XSS 최소화)은 business-rules 예외 기록까지 완료 |
| Logical Components | 질문 불필요 | 큐·캐시·서킷브레이커류 불요 (서버가 소유 — 클라이언트는 바운디드 렌더 캐시만). 모듈 분해는 U4-MNT-2(순수 코어 분리)에서 유도 — Step 3에서 명세 |
