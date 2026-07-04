# Code Summary — Chat Streaming Render Order (U4 Web UI)

**Date**: 2026-07-04
**Plan**: `plan.md` S1~S5 전체 완료.

## 근본 원인

라이브 스트리밍 턴 상태가 이벤트를 **평면 버킷**으로 축적:
`assistantText`(모든 delta 이어붙인 단일 문자열) + `tools[]`(평면 배열). `LiveTurnBlock`이
이를 **고정 순서**(tools 전부 위 → content 전부 아래)로 렌더 → `content→tool→content→tool`
교차 순서가 소실. 턴 종료 후 W7 재-하이드레이트(`transcriptFromMessages`→메시지별
아이템)로만 정상 순서 복구. 즉 저장소/데이터는 정상, **라이브 뷰 모델만 순서를 잃음**.

## 변경 파일

### Created
- `web/src/lib/liveTurn.ts` (S1) — 순수·total 라이브-턴 모델 + 리듀서.
  타입 `LiveToolCall` / `LiveSegment = {kind:'text'} | {kind:'tool'}` / `LiveTurn`(userText·
  segments·notes) / `EMPTY_TURN`. 리듀서(불변):
  - `appendText` — 빈 문자열 no-op; 마지막이 텍스트면 coalesce, 아니면 새 텍스트 세그먼트.
  - `startTool` — in-flight tool 세그먼트(error=null) 추가.
  - `completeTool` — 뒤에서부터 동명·미완료 tool을 in-place 해소; 없으면 완료 tool 추가(폴백).
  - `fallbackText` — `turnHasText`가 false이고 non-blank일 때만 텍스트 세그먼트 추가
    (reasoning.available / run.completed용 — 델타 미방출 provider).
  - `addNote` / `turnHasText` / `turnIsEmpty`.
- `web/tests/property/liveTurn.test.ts` (S4) — fast-check 속성 12건:
  이벤트 순서 보존 + delta coalescing(핵심), tool 이후 delta 분리, 빈 delta 무시,
  tool 완료 매칭(최근 미완료·재해소 안 함·미매칭 append), fallback 게이팅(텍스트 있으면 no-op),
  totality/불변(입력 미변형·EMPTY_TURN 센티넬 불변), notes 순서·세그먼트 무영향, `turnIsEmpty`.

### Modified
- `web/src/pages/chat/ChatView.tsx` (S2·S3):
  - 로컬 `ToolCall` / `LiveTurn` / `EMPTY_TURN` 정의 제거 → `lib/liveTurn` 임포트.
  - `consumeStream` 리와이어: `message.delta`→`appendText`, `tool.started`→`startTool`,
    `tool.completed`→`completeTool`, `reasoning.available`·`run.completed`→`fallbackText`,
    `pushNote`→`addNote`. redact는 뷰에 유지(리듀서는 정제된 문자열 수신).
  - `LiveTurnBlock` 재작성: `turn.segments`를 **이벤트 순서대로** 렌더(tool→`LiveToolCard`,
    text→`Markdown`). 스트리밍 커서(▍)는 **마지막 세그먼트가 텍스트일 때만**. `turnIsEmpty`
    가드. `LiveToolCard` prop `LiveToolCall`. testid(`chat-live-turn`/`chat-tool-call`/
    `chat-system-note`) 유지.

## 검증 (S5)

- `tsc --noEmit` **0 errors** · `eslint src tests --max-warnings 0` **clean** ·
  `vitest run` **85/85**(신규 liveTurn 12 포함) · Playwright E2E **14/14**(스트리밍 답장
  재-하이드레이트 #8 / 중단 #9 포함) · `vite build` → `caduceus/web_dist` 갱신.
- 신규 파일 prettier-clean. (레포는 `prettier --check` 미게이트 — 커밋된 다수 파일이 이미
  systemic drift; ChatView의 prettier 지적 2건은 모두 **미변경** 영역[react 임포트,
  기존 `tool.duration` JSX]으로 내 편집 라인은 clean.)

## Extension 준수

- **Resiliency**: 리듀서 total(임의 이벤트 시퀀스 무예외) + 순서 보존·coalesce·입력 미변형
  불변식 — PBT로 검증. **준수**.
- **Security**: 신규 입출력 경계 없음. redact 뷰에 유지(리듀서는 정제 문자열만). → **N/A**.
- **PBT (Full)**: 순수 리듀서에 fast-check 속성 12건 신설. **준수**.

## W7 / 데이터 불변

- 백엔드 / hermes / 프록시 / `transcript.ts` 무변경. 라이브 버퍼는 렌더 전용, 턴 종료 시
  재-하이드레이트로 폐기(단일 소스 불변). 세그먼트는 append / in-place만 → 인덱스 key 안전.
