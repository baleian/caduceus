# U4 Web UI — NFR Requirements

**Date**: 2026-07-03
**결정 근거**: u4-web-ui-nfr-requirements-plan.md (Q1=A, Q2=A, Q3=B, Q4=A, Q5=A) + 사전 결정 7건

## 1. 성능 (N6 — 부차적, 로컬 도구 기준)

| ID | 요구 | 목표 |
|---|---|---|
| U4-PERF-1 | 초기 로드 (loopback, 콜드 캐시) | < 1s (인지 기준) |
| U4-PERF-2 | 프로덕션 번들 총량 | < 500KB gzip (예산 초과 시 빌드 경고 — 코드 스플리팅 검토 트리거) |
| U4-PERF-3 | 채팅 스트리밍 렌더 | SSE 이벤트 배치(프레임당 1회) append — 입력 지연 무감(대략 <50ms) |
| U4-PERF-4 | WS 이벤트 처리 | 리듀서는 O(1)/이벤트 (recentRequests 등 바운디드 구조 — FD 확정) |
| U4-PERF-5 | 백그라운드 부하 | 폴링(잡 폴백·로그 follow)은 해당 화면 표시 중에만 (W8 승계) — 유휴 시 WS 1개 외 네트워크 0 |

## 2. 신뢰성 (N4 — RESILIENCY 적용)

| ID | 요구 | 실현 |
|---|---|---|
| U4-REL-1 | WS 두절 내성 | 지수 백오프 재접속(1s→2s→…≤30s) + 재연결 시 REST 전량 재조회 후 리플레이 적용 (리듀서 멱등 — PU4-3) |
| U4-REL-2 | 스트림 절단 내성 | SSE 절단 시 세션 보존 + idle 복귀 + system-note. 재진입 시 서버 원천 재하이드레이션으로 유실 0 (W7) |
| U4-REL-3 | 요청 타임아웃 | 일반 REST 30s / 스트리밍(SSE·로그)은 읽기 무제한 (U3 U3-REL-3 동형) — 무한 대기 스피너 금지, 실패는 항상 표면화 |
| U4-REL-4 | 낙관 갱신 실패 복원 | 낙관 UI(스킬 토글 등)는 실패 시 원복 + 토스트 (침묵 실패 금지) |
| U4-REL-5 | 데이터 정합 | 서버가 항상 권위 (W9) — 클라이언트 상태는 전부 재구성 가능(휘발), 영속은 토큰·UiPrefs만 |

## 3. 보안 (N3 — SECURITY 적용)

| ID | 요구 | 실현 |
|---|---|---|
| U4-SEC-1 | 서빙 헤더 (SECURITY-04) | CSP `default-src 'self'` + `connect-src 'self' ws:` + `frame-ancestors 'none'`, nosniff, Referrer-Policy no-referrer, index.html/API no-store (business-rules W5 — 서버측 구현은 U4 범위) |
| U4-SEC-2 | 입력 검증 (SECURITY-05) | 클라 선검증은 UX용·서버 422가 권위 (W4). 렌더 경로는 프레임워크 이스케이프 + redact 게이트 (PU4-7). **채팅 본문은 v1에서 plain text 렌더** — markdown/HTML 렌더러 미도입 (XSS 표면 제거, tech-stack §5 근거) |
| U4-SEC-3 | 인증 (SECURITY-08) | admin 토큰 필수(deny-by-default 서버 계약 승계), fragment 전달 후 즉시 제거, 401 fail-safe (W3) |
| U4-SEC-4 | 공급망 (SECURITY-10) | 정확 버전 고정 + package-lock.json 커밋, CI에서 `npm audit`(high 이상 fail) + lockfile 무결성 검사 |
| U4-SEC-5 | 크리덴셜 (SECURITY-12) | 토큰 원문 비표시(W2), localStorage 보관은 문서화된 예외(위협 모델: loopback 단일 사용자 + CSP 외부 오리진 전면 금지) |
| U4-SEC-6 | fail-safe (SECURITY-15) | 인증 실패 → 잠금 화면(자동 재시도 없음), WS 인증 실패 4401 → 토큰 화면 |

## 4. 유지보수성·품질 (N7)

| ID | 요구 | 실현 |
|---|---|---|
| U4-MNT-1 | 타입 안전 | TypeScript strict (mypy --strict와 동일 기조), typescript-eslint에서 `no-explicit-any` 강제 |
| U4-MNT-2 | 순수 로직 분리 | 리듀서/SSE 파서/상태 기계/tail dedup/폼 라운드트립은 **React 무관 순수 TS 모듈**(`web/src/lib/`) — PBT 직접 적용 지대 (U1 설계 철학 승계) |
| U4-MNT-3 | PBT (PBT-02~08, 10) | fast-check + Vitest — FD의 PU4-1~7 전부 테스트로 구현 (blocking) |
| U4-MNT-4 | E2E | Playwright(chromium) — F11 플로우 전체를 페이크 hermes 위 실 데몬 대상 실행 (완료 기준 직접 충족). 실물 hermes 시나리오는 Build & Test의 `-m integration` 계열로 이관 |
| U4-MNT-5 | 린트/포맷 | eslint(typescript-eslint) + prettier — CI 게이트 (Python 측 ruff/mypy와 대칭) |

## 5. 규모·플랫폼 (N9/N10)

- **에이전트 수 상한 하드코딩 금지** (N10): 목록·테이블은 임의 개수 렌더 가능한 단순 구조. 가상화는 미도입(P4) — 성능 문제가 실측되면 후속 (근거: 로컬 도구의 현실 규모)
- **브라우저**: 에버그린만 (사전 결정). WSL2 사용자는 Windows 브라우저에서 접속하는 경우 포함 — loopback 접근은 WSL2 localhost 포워딩으로 동작 (기존 U3 `ui` 폴백 체인의 wslview 경로 재사용)
- **테마**: 다크/라이트 자동(`prefers-color-scheme`) + 수동 토글, UiPrefs 저장 (Q5=A)
- **접근성(경량)**: 시맨틱 마크업, 키보드 조작 가능(모달 포커스 트랩, Composer Enter/Shift+Enter), 토큰 팔레트 대비 준수 — 감사 도구 게이트까지는 미도입 (P4)

## 6. 확장 적용 매트릭스

| 확장 규칙 | 판정 | 근거 |
|---|---|---|
| SECURITY-04 웹 보안 헤더 | **적용** | U4-SEC-1 — 본 유닛의 핵심 준수 지점 (U2 자리표시자 완성) |
| SECURITY-05 입력 검증 | 적용 | U4-SEC-2, W4 |
| SECURITY-06 최소 권한 | 적용 | SPA는 admin 토큰 외 권한 없음, 키는 서버측 부착으로 브라우저 미도달 (기존 설계 승계) |
| SECURITY-08 접근 제어 | 적용 | U4-SEC-3 |
| SECURITY-09 하드닝 | 적용 | CSP·외부 오리진 금지·의존 최소 |
| SECURITY-10 공급망 | 적용 | U4-SEC-4 (npm 생태계가 본 유닛의 신규 공급망 표면) |
| SECURITY-12 크리덴셜 | 적용(예외 문서화) | U4-SEC-5 |
| SECURITY-15 fail-safe | 적용 | U4-SEC-6 |
| RESILIENCY 타임아웃/폴백/복구 | 적용 | U4-REL-1~5 |
| RESILIENCY 멀티 존/리전·DR | **N/A** | 로컬 단일 호스트 SPA (R5 기결정) |
| PBT-09 프레임워크 선정 | 적용 | fast-check (tech-stack-decisions.md) |
| PBT-02~08/10 | 적용 예정 | Code Generation에서 PU4-1~7 구현 (blocking) |
