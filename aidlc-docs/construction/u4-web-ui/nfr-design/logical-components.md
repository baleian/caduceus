# U4 Web UI — Logical Components

**Date**: 2026-07-03
**전제**: nfr-design-patterns.md WPT-1~12, tech-stack-decisions.md §3 코드 조직

## 1. 클라이언트 모듈 구조 (`web/src/`)

| 모듈 | 책임 | 준수 패턴 |
|---|---|---|
| `lib/reducer.ts` | CoreEvent → AppState 순수 리듀서 (agents/jobs/traffic/system 갱신, 바운디드 불변식) | WPT-1/3, PU4-3 |
| `lib/sse.ts` | 증분 SSE 파서 (임의 청킹·garbage 내성 — U3 sse.py 동형) | WPT-1, PU4-1 |
| `lib/chatMachine.ts` | run 상태 전이표 + transition() (U3 전이표 동형 포팅) | WPT-5, PU4-2 |
| `lib/transcript.ts` | messages→transcript 매핑(전 함수), tool 실패 상세 추출(U3 tool_failure_summary 동형) | WPT-1, PU4-4 |
| `lib/tail.ts` | 로그 스냅샷 중첩 dedup (U3 tail.py 동형) | WPT-1, PU4-6 |
| `lib/redact.ts` | 토큰형 문자열 마스킹 게이트 (U1 redact 동형) | WPT-6, PU4-7 |
| `lib/forms.ts` | 검증 규칙(이름 정규식 단일 상수, W4 표) + toolsets/approvals 라운드트립 merge | WPT-1, PU4-5 |
| `api/client.ts` | 단일 fetch 래퍼 (토큰 부착·오류 정규화·타임아웃·401 신호) | WPT-2 |
| `api/ws.ts` | WS 연결 관리 (백오프·재연결 시퀀스·주입 가능한 소켓 팩토리) | WPT-4/10 |
| `api/agentApi.ts` | `/agents/{name}/api/*` 중계 호출 (sessions/runs/stop/approval) | WPT-2 |
| `state/AppStore.tsx` | Context+useReducer — lib/reducer의 React 바인딩, REST 스냅샷 로드 | WPT-3 |
| `state/useAuth.ts` | fragment 파싱→저장→제거, 401 처리 | W3, U4-SEC-3 |
| `state/usePolling.ts` | 가시성 연동 폴링 공통 훅 | WPT-8 |
| `components/` | ConfirmModal(WPT-11), StatusBadge, Toast, CollapsibleSection 등 공용 | |
| `pages/agents|agent-detail|chat|gateway|system/` | FD frontend-components.md §1 트리 그대로 | |

**의존 규칙 (eslint 존 강제 — WPT-1)**: `lib` → (없음) / `api` → `lib` / `state` → `api`,`lib` / `components` → `state`,`lib` / `pages` → 전부. 역방향 금지.

## 2. 서버측 변경점 (U4 범위 — 기존 자리표시자의 완성)

| 변경 | 위치 | 내용 |
|---|---|---|
| 정적 서빙 연결 | `caduceus/daemon.py` | `web_dist/` 마운트 + SPA fallback(비-API 경로 → index.html) — U2 빈 자리표시자 대체 |
| 보안 헤더 | `caduceus/daemon.py` 미들웨어 | U4-SEC-1 헤더 세트(CSP/frame-ancestors/Referrer-Policy/Cache-Control). 기존 nosniff·1MB 제한 유지 |
| `caduceus ui` fragment | `caduceus/cli/bootstrap.py` | 열기 URL에 `#token=<admin>` 부착 (1줄 — FD 승인 사항) |

신규 API 0건 (FD에서 입증) — 위 3건 외 Python 측 무변경.

## 3. 테스트 컴포넌트 매핑

| 검증 지점 | 도구 | 대상 |
|---|---|---|
| PU4-1~7 property | Vitest + fast-check | `lib/` 7개 모듈 (DOM 불요) |
| 폼 규칙·모달 게이트·오류 표시 | Vitest + jsdom + Testing Library | AgentForm/ConfirmModal/SettingsTab (W1/W4) |
| API 게이트 계약 | Vitest (주입 transport — WPT-10) | 401 신호·오류 3형태 정규화·타임아웃 |
| 리듀서+WS 통합 | Vitest (가짜 소켓) | 재연결 시퀀스·리플레이 중복 (WPT-4) |
| F11 브라우저 E2E | Playwright(chromium) — 실 데몬+페이크 hermes | 토큰 게이트→생성(잡 진행률)→start/stop→설정 편집→chat(스트리밍/stop/approval/세션 관리)→gateway 핫스왑→로그 follow→삭제 |
| 헤더/서빙 회귀 | pytest (기존 U2 테스트 확장) | U4-SEC-1 헤더 존재·SPA fallback·no-store |
| web_dist 재현 일치 | CI 스텝 | src↔산출물 드리프트 검출 (tech-stack §4) |

## 4. 인프라 컴포넌트 부재 판정 (Logical Components 카테고리 종결)

큐·캐시·서킷브레이커·스토리지 등 인프라 요소는 **전부 서버(U1/U2) 소유** — 클라이언트가 갖는 것은 바운디드 렌더 캐시(리듀서 상태)와 localStorage 2키(admin 토큰, UiPrefs)뿐. Infrastructure Design 스테이지는 U4에서 **스킵 대상** (배포 인프라 없음 — 정적 자산은 기존 데몬에 동봉, U1~U3와 동일 판정).
