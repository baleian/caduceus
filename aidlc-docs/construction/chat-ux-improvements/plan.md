# Code Generation Plan — Chat UX Improvements (U4 Web UI 점진 개선)

**Date**: 2026-07-04
**Requirements**: `requirements.md` (FR-1~FR-4) — 답변 Q1=A(무의존 윈도우), Q2=A(스크롤업 자동 로드), Q3=A(풀 리디자인)
**Scope**: `web/` 프론트엔드만. 백엔드/hermes/프록시/chatMachine 무변경.
**이 파일이 Code Generation의 단일 소스 오브 트루스입니다.**

## Unit Context

- **대상**: U4 Web UI — `web/src/pages/chat/ChatView.tsx` 중심
- **의존**: 없음(순수 view 계층). W7 하이드레이션·chatMachine(PU4-2)·redact 파이프라인은 그대로 사용.
- **보존 계약**: test-id (`chat-transcript`, `chat-composer-input`, `chat-send-button`,
  `chat-stop-button`, `chat-live-turn`, `chat-new-session-button` 등), Enter 전송/Shift+Enter 줄바꿈,
  Stop 상태 전이(streaming→stopping), W7 재-하이드레이션 흐름.
- **명시적 동작 변경 1건**: 스트리밍 중에도 textarea **입력 가능**(전송은 idle 게이트 유지 —
  상용 챗 관례, 다음 메시지 선입력). E2E는 disabled를 단언하지 않음 → 안전.

## Steps

### FR-1 — 지연 렌더 (Q1=A 무의존 윈도우, Q2=A 스크롤업 자동 로드)

- [x] **S1. 순수 로직 모듈 생성**: `web/src/lib/chatScroll.ts`
  - `PIN_THRESHOLD_PX = 64`, `INITIAL_WINDOW = 40`, `WINDOW_CHUNK = 40` 상수
  - `isPinned(distanceFromBottom, threshold?)` — 바닥 고정 판정
  - `growWindow(visible, total, chunk?)` — 윈도우 확장(총량 클램프, 단조 증가)
  - `windowStart(total, visible)` — 렌더 시작 절대 인덱스(키 안정성용)
- [x] **S2. 속성 테스트**: `web/tests/property/chatScroll.test.ts` (fast-check, 기존 패턴)
  - growWindow: 단조 증가·total 클램프·chunk 기본값 불변식
  - isPinned: 임계 경계(≤ threshold ⇔ true), 음수 방어
  - windowStart: `0 ≤ start ≤ total`, `start + min(visible,total) === total`
- [x] **S3. 윈도우 렌더 적용** (`ChatView.tsx`)
  - `visibleCount` 상태(세션 전환/하이드레이트 시 `INITIAL_WINDOW`로 리셋)
  - `transcript.slice(windowStart(...))` 렌더, key = 절대 인덱스(윈도우 확장 시 리마운트 방지)
  - 숨겨진 이전 항목 수 표시(예: "… N earlier messages") — 시각 단서
- [x] **S4. 위로 무한 로드 + 스크롤 앵커링** (`ChatView.tsx`)
  - 목록 상단 sentinel div + IntersectionObserver → 교차 시 `growWindow`
  - 확장 직전 `scrollHeight/scrollTop` 기록 → `useLayoutEffect`에서
    `scrollTop += (신규 scrollHeight − 이전 scrollHeight)` 보정(위치 튐 방지)

### FR-2 — 스트리밍 자동 스크롤 + Slack 스타일 뱃지

- [x] **S5. pinned 추적 + 자동 스크롤** (`ChatView.tsx`)
  - 스크롤 컨테이너 ref + onScroll에서 `isPinned` 갱신(ref, 렌더 무관)
  - 스트리밍 델타/툴칩/노트 갱신 시 pinned면 컨테이너 바닥으로 자동 스크롤
  - 하이드레이트 직후는 현행대로 무조건 바닥 정렬(pinned 초기화)
- [x] **S6. 새 메시지 뱃지** (`ChatView.tsx`)
  - !pinned 상태에서 콘텐츠 증가 시 하단 부동 pill 표시: "↓ New messages"
    (`data-testid="chat-new-messages-badge"`, transcript 영역 위 absolute)
  - 클릭 → 바닥으로 스크롤 + pinned 복귀 + 뱃지 소멸; 수동으로 바닥 도달 시에도 소멸

### FR-3 — 완료 시 입력창 자동 포커스

- [x] **S7. 포커스 복귀** (`ChatView.tsx`)
  - textarea ref + 직전 streaming 여부 ref
  - streaming→idle 전이 시 **pinned인 경우에만** `textarea.focus()`
    (과거 읽는 중 포커스 탈취 금지 — FR-3 명세)

### FR-4 — 입력 영역 풀 리디자인 (Q3=A)

- [x] **S8. 컴포저 리디자인** (`ChatView.tsx` footer)
  - 단일 rounded-2xl 컨테이너(border-edge, bg-surface, `focus-within:` 액센트 링)
  - 내부 borderless textarea: 1행 시작 → 입력에 따라 자동 확장(max ~8행/200px, 초과 시 내부 스크롤)
  - 우하단 통합 원형 아이콘 버튼: idle=전송(ArrowUp, gradient, 빈 입력 시 dim/disabled) /
    streaming=정지(Square, danger) / stopping=스피너 — testid 3종 유지
  - placeholder "Message {agent}…", 하단 힌트 라인 "Enter to send · Shift+Enter for newline"
  - 스트리밍 중 입력 가능(전송 게이트는 chatMachine 그대로), 접근성 aria-label 부여

### 검증·문서

- [x] **S9. 전체 검증**: `tsc` typecheck / eslint / vitest(unit+property) / Playwright E2E /
  `vite build` → `caduceus/web_dist` 갱신. 전부 통과 확인.
- [x] **S10. 문서/상태**: `code-summary.md`(이 폴더), `aidlc-state.md`·`audit.md` 갱신,
  완료 메시지(표준 2옵션) 제시.

## Traceability

| 요구 | 단계 |
|---|---|
| FR-1 지연 렌더 | S1–S4 |
| FR-2 자동 스크롤+뱃지 | S5–S6 |
| FR-3 완료 시 포커스 | S7 |
| FR-4 컴포저 리디자인 | S8 |
| NFR(무회귀·빌드) | S9 |

## Extension Compliance (예정)

- **Resiliency**: 스트림/하이드레이트 실패 경로 무변경(회귀만 방지) — 관련 규칙 N/A
- **Security**: 신규 I/O 경계 없음, redact 유지 — N/A
- **PBT**: S1 순수 함수 3종에 fast-check 속성 테스트(S2) — 적용
