# Requirements — Chat Streaming Render Order (U4 Web UI)

**Stage**: CONSTRUCTION — 점진 개선 (어댑티브, 경량)
**Date**: 2026-07-04
**Scope**: `web/src/pages/chat/ChatView.tsx` + 신규 `web/src/lib/liveTurn.ts` + 속성 테스트만.
백엔드 / hermes / 프록시 / `transcript.ts` 무변경.

## 1. 배경 / Intent

직전 사이클 `chat-transcript-rendering`(커밋 c98d632)은 **히스토리(재-하이드레이트)
렌더**를 실제 발생 순서 — 메시지별로 thinking → content → tool cards — 로 고쳤다.
그러나 **라이브 스트리밍 턴**(`LiveTurnBlock`)은 여전히 이벤트를 버킷으로 모아
고정 순서로 렌더한다.

### 현행 문제 (사용자 보고)

`LiveTurn` 상태가 스트리밍 이벤트를 **평면 필드**로 축적한다:

- `assistantText: string` — 모든 `message.delta`를 하나로 이어붙임
- `tools: ToolCall[]` — 모든 `tool.started` / `tool.completed`를 평면 배열로

`LiveTurnBlock`은 이를 **고정 순서**(userText → tools 전부 → assistantText 전체 →
notes)로 렌더한다. 따라서 assistant가 `content → tool → content → tool`처럼
교차 진행하면:

- 모든 tool 카드가 **맨 위**에 몰리고,
- 모든 content가 **맨 아래**에 이어붙어 표시된다.

턴 종료 후 W7 재-하이드레이트로 messages 기반 재렌더되면서 정상 순서로 복구된다 —
즉 **데이터/저장소는 정상**, **라이브 뷰 모델만 순서를 잃는다**.

## 2. 기능 요구사항

### FR-1 — 라이브 턴을 이벤트 순서 세그먼트로 렌더 (사용자 명시)
- 스트리밍 중 assistant의 content(텍스트)와 tool 호출을 **도착(이벤트) 순서 그대로**
  교차 렌더한다. `content → tool → content → tool` 패턴이 화면에 그 순서대로 나타나야 한다.
- 연속된 `message.delta`는 하나의 텍스트 블록으로 합쳐지고(coalesce), tool 이후
  도착한 delta는 **새 텍스트 블록**을 시작한다.

### FR-2 — 히스토리와 라이브의 순서 일관성
- 스트리밍 중 표시 순서와 턴 종료 후 재-하이드레이트된 표시 순서가 동일한 상대 순서를
  유지한다(사용자가 턴 종료 순간 순서가 뒤바뀌는 것을 체감하지 않도록).

### FR-3 — 회귀 없음 / 기존 계약 유지
- **testid 유지**: `chat-live-turn`(스트리밍 텍스트 포함 — E2E app.spec.ts:125),
  `chat-tool-call`(라이브 툴 카드), `chat-system-note`(노트 — app.spec.ts:127).
- **redact 파이프라인 유지**: 텍스트 / preview 표시 전 기존 `redact` 적용.
- **W7 단일 소스 불변**: 라이브 버퍼는 렌더 전용, 턴 종료 시 재-하이드레이트로 폐기.
  데이터 소스 / chatMachine 변경 없음.
- **라이브 툴 카드는 헤더-온리 유지**: 라이브 이벤트에는 preview / duration만 존재하며
  full args / result는 재-하이드레이트 후에만 제공 → `LiveToolCard` 형태 유지.

### FR-4 — 파생 (설계 결정, 승인 게이트에서 override 가능)
- 순서 축적 로직을 **순수·total 함수**로 분리(`web/src/lib/liveTurn.ts`) — PBT 대상,
  뷰(React)와 분리. (`chat-transcript-rendering`이 페어링을 순수 함수로 분리한 것과 동일 패턴.)
- 스트리밍 커서(▍)는 **마지막 세그먼트가 텍스트일 때만** 그 뒤에 표시한다(직전 tool이
  실행 중이면 tool 카드의 스피너가 활동 표시를 대신하므로 중간 텍스트에 커서를 남기지 않음).
- 시스템 노트(중단 / 실패 등 메타)는 현행대로 **턴 하단에 모아** 표시한다(이벤트 순서
  교차 대상 아님 — 사용자 보고 범위 밖).

## 3. 비기능 / 제약 & Extension 적용성 (경량 판단)

- **Resiliency Baseline**: 리듀서는 임의 이벤트 시퀀스에 대해 total(무예외)이며 순서 보존·
  coalesce 불변식을 유지한다 → 해당 불변식으로 커버(PBT 검증).
- **Security Baseline**: 신규 입출력 경계 없음. 이미 세션 스토어/스트림에서 오던 데이터의
  표시 순서만 변경. redact 유지. → **N/A**.
- **Property-Based Testing (Full enforcement)**: 순수 리듀서가 fast-check 속성 대상 —
  순서 보존, delta coalescing, tool 완료 매칭, fallback(텍스트 없을 때만), totality,
  tool 세그먼트 수 == `tool.started` 이벤트 수 불변식.

## 4. 결정 필요

FR-1(이벤트 순서 렌더)은 요청이 충분히 구체적이라 별도 질문 없이 위 명세대로 구현한다.
FR-4의 커서 / 노트 처리는 위 기본값으로 진행하되 **승인 게이트에서 override 가능**.
