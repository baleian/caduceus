# Code Summary — Chat UX Improvements

**Date**: 2026-07-04 · **Plan**: `plan.md` (S1~S10, 전체 [x])

## Created

- `web/src/lib/chatScroll.ts` — 순수 윈도우/스크롤 헬퍼: `isPinned`(바닥 고정 판정, 64px),
  `growWindow`(청크 확장·total 클램프), `windowStart`(절대 시작 인덱스), 상수
  `INITIAL_WINDOW=40` / `WINDOW_CHUNK=40` / `PIN_THRESHOLD_PX=64`
- `web/tests/property/chatScroll.test.ts` — fast-check 속성 6건: 클램프/수렴/단조 확장,
  마운트 슬라이스 정확성, 윈도우 상향 확장, pinned 경계 포함·단조

## Modified

- `web/src/pages/chat/ChatView.tsx` — 단일 파일 수정:
  - **FR-1 지연 렌더**: `transcript.slice(windowStart(...))`만 마운트(키=절대 인덱스),
    상단 sentinel + IntersectionObserver(rootMargin 160px)로 스크롤업 시 40개씩 확장,
    `useLayoutEffect` scrollTop 보정으로 앵커링(위치 튐 없음), "N earlier messages" 표시
    (`chat-earlier-indicator`)
  - **FR-2 자동 스크롤+뱃지**: 스크롤 컨테이너 pinned 추적(ref, 렌더 무관) — pinned면
    델타/툴칩/하이드레이트마다 바닥 추종, 아니면 "↓ New messages" 부동 pill
    (`chat-new-messages-badge`) 표시. 클릭/수동 바닥 도달 시 소멸. 본인 메시지 전송 시 항상
    바닥 점프(Slack/ChatGPT 관례)
  - **턴 종료 하이드레이트 `preserveView` 모드**: 사용자가 위를 읽는 중이면 뷰포트를 당기지
    않고 윈도우를 증가분만큼 확장(같은 항목 유지) + 뱃지로 알림. 세션 전환은 기존처럼
    바닥 정렬 + 윈도우 리셋
  - **FR-3 포커스 복귀**: streaming→idle 전이 시 pinned인 경우에만 composer 포커스
  - **FR-4 컴포저 리디자인**: 단일 rounded-2xl 컨테이너(focus-within 액센트 링), 1행 시작
    자동 확장 textarea(max 208px 후 내부 스크롤, 비우면 원복), 우하단 통합 원형 버튼
    (전송 ArrowUp gradient / 정지 Square danger / 정지중 스피너), placeholder
    "Message {agent}…", 힌트 라인. **동작 변경(승인됨)**: 스트리밍 중 타이핑 가능
    (전송은 chatMachine idle 게이트 유지)

## Preserved contracts

- test-id 전부 유지 + 신규 2종(`chat-new-messages-badge`, `chat-earlier-indicator`)
- Enter 전송/Shift+Enter 줄바꿈, Stop 전이(streaming→stopping), W7 재-하이드레이션,
  chatMachine/redact 무변경. 백엔드/프록시/hermes 무변경.

## Verification

- `tsc --noEmit` 0 errors · eslint(--max-warnings 0) pass
- vitest 54/54 (신규 chatScroll 6건 포함) · Playwright E2E 14/14
- `vite build` → `caduceus/web_dist` 갱신 (index-CG1u0rtQ.js)

## Extension compliance

- Resiliency: 실패 경로 무변경(하이드레이트 실패 시 라이브 버퍼 유지 동작 보존) — N/A
- Security: 신규 I/O 경계 없음, redact 경로 유지 — N/A
- PBT: chatScroll 순수 함수 3종 속성 테스트 적용 — 준수
