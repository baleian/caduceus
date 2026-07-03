# U3 CLI — NFR Design Plan

**Date**: 2026-07-03
**Unit**: U3 CLI (C8 — `caduceus/cli/`)
**입력**: u3-cli/nfr-requirements/ 2종 (U3-PERF/REL/SEC/PORT/TEST/MAINT, typer+rich 스택)

## Plan Steps

- [x] Step 1: 질문 필요성 평가 — 카테고리 전수 검토 (아래 — 신규 질문 0건, 근거 명시)
- [x] Step 2: `nfr-design-patterns.md` — 패턴 카탈로그 P1~P10 (thin command, 단일 오류 테이블, 인터럽트 상태 기계, lazy import, 출력 redact 필터, 무재시도, 중첩 dedup tail, health-검증 detach, 주입 가능한 Console/Transport)
- [x] Step 3: `logical-components.md` — `caduceus/cli/` 모듈 구조(12 모듈)·의존 규칙·테스트 컴포넌트 (PU3 속성별 검증 지점 매핑)
- [x] Step 4: 완료 메시지 제시 및 승인 대기

## 질문 카테고리 전수 검토 (신규 질문 0건 — 근거)

| 카테고리 | 판단 | 근거 (기결정) |
|---|---|---|
| Resilience Patterns | 질문 불필요 | 무재시도(U3-REL-4)·인터럽트 안전(PU3-5)·타임아웃 체계(U3-REL-3)·부분 출력 보존(U3-REL-2) 전부 FD/NFR에서 확정 |
| Scalability Patterns | 해당 없음 | 단일 사용자 로컬 CLI — 부하·스케일 표면 부재 (데몬 측은 U2에서 처리) |
| Performance Patterns | 질문 불필요 | lazy import 예산(U3-PERF-1)·무버퍼 스트리밍(U3-PERF-2)·폴링 주기(U3-PERF-3) 수치까지 확정 |
| Security Patterns | 질문 불필요 | U3-SEC-1~5 확정 (토큰 비노출·권한 검사·임시파일 0600·제어문자 이스케이프). 신규 위협 표면 없음 — 모든 원격 접근은 U2 인증 계층 경유 |
| Logical Components | 질문 불필요 | 큐·캐시·서킷브레이커류 인프라 컴포넌트 불요 (stateless 클라이언트). 모듈 분해는 U3-MAINT-1~3 제약에서 유도 — Step 3에서 명세 |
