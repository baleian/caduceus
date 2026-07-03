# Requirements — Chat UX Improvements (U4 Web UI)

**Stage**: CONSTRUCTION — 점진 개선 (어댑티브, 경량)
**Date**: 2026-07-04
**Scope**: `web/src/pages/chat/ChatView.tsx` 및 관련 컴포넌트만. 백엔드/hermes/프록시 변경 없음.

## 1. 배경 / Intent

직전 조사에서 확인: hermes `GET /api/sessions/{id}/messages`는 **pagination 미지원**이라
세션 이력을 항상 전량 반환한다. 서버 전송량은 클라이언트에서 줄일 수 없으므로, 이번 작업은
**렌더 부담 완화**(지연 렌더)와 **스트리밍 중 UX 결함 3건** 수정에 한정한다.

## 2. 기능 요구사항

### FR-1 — 지연 렌더 (렌더 부담 완화)
- 서버는 전체 transcript를 내려주지만, DOM에는 **최근 N개 항목만 마운트**하고
  이전 항목은 사용자가 요청할 때 점진적으로 추가 마운트한다.
- 목적: 수백~수천 메시지 세션을 처음 열 때 초기 마운트/레이아웃 비용을 상수 수준으로 억제.
- 채팅 메시지는 높이가 가변(마크다운, 코드블록, tool chip)이라 고정높이 가정이 어렵다 →
  구현 방식은 Q1에서 결정.
- 새 항목 마운트 시(이전 메시지 펼치기) **스크롤 위치가 튀지 않아야** 한다(scroll anchoring).

### FR-2 — 스트리밍 자동 스크롤 + Slack 스타일 뱃지
- **현재 결함**: 스트리밍 중 새 델타가 쌓여도 자동 스크롤이 안 됨(하이드레이트 시점에만 스크롤).
- 사용자가 **최하단에 고정(pinned)** 상태면 → 스트리밍 델타를 따라 자동 스크롤.
- 사용자가 위로 스크롤해 **최하단이 아니면** → 자동 스크롤 비활성화(읽는 위치 유지) +
  하단에 **"↓ 새 메시지" 부동 뱃지(pill)** 표시. 클릭 시 최하단으로 점프 + 다시 pinned.
- "pinned" 판정: 스크롤 컨테이너 바닥과의 거리 ≤ 임계값(구현 기본 64px). (질문 대상 아님)

### FR-3 — 스트리밍 완료 시 입력창 자동 포커스
- **현재 결함**: 턴 종료 후 입력창에 포커스가 돌아오지 않아 키보드만으로 연속 대화 불가.
- 사용자가 pinned(자동 스크롤을 보고 있는) 상태로 턴이 완료되면 → 입력 textarea로 자동 포커스.
- 사용자가 위로 스크롤해 과거를 읽고 있던 중이면 포커스를 가로채지 않는다(pinned일 때만 포커스).

### FR-4 — 입력 영역 리디자인
- **현재**: 밋밋한 `rows=2` textarea + 옆에 별도 Send/Stop 버튼.
- 상용 LLM 챗 인터페이스 수준으로 완성도 개선. 구체 범위는 Q3에서 결정.
- 접근성/키보드 동작(Enter 전송, Shift+Enter 줄바꿈)과 Stop 버튼 상태 전이는 **현행 유지**.

## 3. 비기능 / 제약

- **의존성 최소 기조 유지**: 현재 web은 가상 스크롤 라이브러리가 없음(React 18 + Tailwind 4 +
  lucide + recharts). 새 런타임 의존성 추가는 Q1에서 명시 승인된 경우에만.
- **W7 단일 소스 불변**: transcript는 항상 서버에서 재-하이드레이트. 지연 렌더는 순수 view 계층
  (마운트 개수 제어)이며 데이터 소스/머신 상태를 바꾸지 않는다.
- **기존 test-id / 동작 보존**: `chat-transcript`, `chat-composer-input`, `chat-send-button`,
  `chat-stop-button`, `chat-live-turn` 등 Playwright E2E가 참조하는 훅 유지.
- **회귀 없음**: typecheck / eslint / vitest / Playwright E2E 전부 통과, `vite build`로
  `caduceus/web_dist` 갱신.

## 4. Extension 적용성 (경량 판단)

- **Resiliency Baseline**: 순수 프론트엔드 view 개선. 스트림 실패/재-하이드레이트 실패 경로는
  현행 로직 유지(변경 없음). → 대체로 N/A, 관련 경로 회귀만 방지.
- **Security Baseline**: 신규 입출력 경계 없음. redact 파이프라인 현행 유지. → N/A.
- **Property-Based Testing**: 스크롤/pinned 판정은 순수 함수로 분리 가능(예: `isPinned(dist, threshold)`,
  지연 렌더 윈도우 계산). 해당 순수 로직에 한해 단위 테스트로 커버. 전면 PBT는 과함 → 최소 적용.

## 5. 결정 필요 (→ requirements-questions.md)

- **Q1** 지연 렌더 구현 방식 (무의존 윈도우 vs 가상 스크롤 라이브러리)
- **Q2** "이전 메시지" 로드 트리거 (자동 스크롤업 vs 명시 버튼)
- **Q3** 입력 영역 리디자인 범위 (풀 리디자인 vs 경량 리스타일)

FR-2(뱃지 동작)와 FR-3(포커스 조건)은 요청이 충분히 구체적이라 별도 질문 없이 위 명세대로 구현.
