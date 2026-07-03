# U4 Web UI — NFR Design Patterns

**Date**: 2026-07-03
**전제**: u4 functional-design (APPROVED), u4 nfr-requirements (APPROVED). 패턴 ID는 코드 생성 시 준수 계약.

## WPT-1. 순수 코어 / React 셸 분리 (U4-MNT-2, PBT 지대)

- `web/src/lib/`의 모듈(reducer/sse/chatMachine/transcript/tail/redact/forms)은 **React·DOM·fetch import 금지** — 입력→출력 순수 함수만
- React 계층(state/, pages/)은 lib을 호출만 함. PU4-1~7은 lib에 직접 적용 (jsdom 불요, U1 "순수 로직과 부수효과 분리" 철학의 프론트 동형)
- 강제: eslint `no-restricted-imports` 존 규칙 (lib → react/api 금지)

## WPT-2. 단일 API 게이트 (W2/W3 강제 지점)

- 모든 서버 호출은 `api/` 모듈의 단일 fetch 래퍼 경유: admin 토큰 부착, 오류 3형태(`{error:str}`/`{detail}`/OpenAI 중첩 — U3 검증) 정규화, 401 → 전역 `auth:invalid` 신호 1회 발행
- 컴포넌트에서 raw fetch 금지 (redact·인증·오류 매핑 우회 차단)
- 타임아웃: 일반 30s(AbortController) / SSE·로그 스트림 무제한 (U4-REL-3)

## WPT-3. 멱등 이벤트 리듀서 (U4-REL-1, PU4-3)

- `(state, CoreEvent) → state` 순수 함수. 같은 이벤트 재적용 = 불변(리플레이 500 + 실시간 중복 안전), 미지 kind는 eventLog 외 no-op(전방 호환)
- 바운디드 구조 불변식: recentRequests ≤100, eventLog ≤500 — 리듀서 내부에서 강제

## WPT-4. 백오프 재연결 + 스냅샷 정합 (U4-REL-1)

- WS 끊김 → 1s→2s→4s…≤30s 재시도. 재연결 성공 시퀀스: **REST 전량 재조회(agents/jobs/gateway/status) → 리플레이 적용** 순서 고정 (리듀서 멱등이 순서 관용 보장)
- 두절 동안 ConnectionBadge=reconnecting + 잡 카드만 폴링 폴백 (S-U4-1.6)

## WPT-5. 상태 기계 승계 (PU4-2 — U3 동형)

- chat run 상태 기계는 U3 `chat.py`의 **전이표를 데이터로 동형 포팅** (4 상태 × 6 이벤트, 미지 쌍 no-op). 불변식 동일: stop ≤1/turn, 제출은 idle에서만
- UI 어댑터만 상이 (Stop 버튼/라우트 이탈 확인) — 전이표 자체는 불변

## WPT-6. redact 단일 경로 (W2, PU4-7)

- 서버 텍스트(스트림 델타·로그·오류 메시지)는 화면 도달 전 `lib/redact.ts` 단일 게이트 통과 (U1 `redact` 규칙 동형)
- React의 기본 이스케이프 + plain text 렌더(마크다운 미도입)로 주입 표면 제거 — `dangerouslySetInnerHTML` 전면 금지 (eslint 규칙)

## WPT-7. 낙관 갱신 원복 (U4-REL-4)

- 낙관 UI는 스킬 토글 등 **단일 필드 PUT에 한정**. 실패 시 이전 값 원복 + 토스트. 잡 기반 조작(생성/삭제)·202 접수형(start/stop)은 낙관 갱신 금지 — 서버 이벤트가 유일한 전이 원천 (W9)

## WPT-8. 가시성 연동 폴링 (U4-PERF-5)

- 폴링(로그 follow·잡 폴백)은 마운트+`document.visibilityState=visible`일 때만. 언마운트/숨김 시 타이머 해제 — 누수 금지
- 공통 훅 1개로 구현 (개별 setInterval 산재 금지)

## WPT-9. 자급 번들 강제 (W6/U4-SEC-1)

- 외부 오리진 참조는 빌드에서 검출: CSP `default-src 'self'`가 런타임 강제 + CI에서 빌드 산출물의 외부 URL 스캔 (폰트·이미지 포함 전부 동봉)
- 소스맵은 프로덕션 산출물에서 제외 (web_dist 커밋 크기 관리)

## WPT-10. 주입 가능한 경계 (테스트 설계)

- 시간(setTimeout/폴링 주기)·WS 생성·fetch는 상위에서 주입 가능한 팩토리로 — Vitest에서 페이크 타이머/가짜 소켓 대체 (U2 build_daemon 조립 철학의 프론트 대응)
- Playwright E2E는 실 데몬(페이크 hermes) 대상 — 주입 없이 전 구간

## WPT-11. 확인 게이트 (W1)

- 파괴적 조작은 `ConfirmModal`의 단일 컴포넌트만 사용 — 이름 타이핑 변형(에이전트 삭제)/경량 변형(세션 삭제·토큰 회전)을 prop으로 구분. X-Confirm 헤더는 모달 성공 콜백에서만 생성 (우회 경로 없음)

## WPT-12. 서버 권위 렌더 (W9)

- 상태 배지·트래픽 수치·잡 단계는 서버 값 그대로 — 클라이언트 재합성/추론 금지. 시각만 로컬 표기 변환
- 서버 스키마에 없는 필드 접근은 TS 타입(수신 DTO 명시 정의)으로 컴파일 타임 차단
