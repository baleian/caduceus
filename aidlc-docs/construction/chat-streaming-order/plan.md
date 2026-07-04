# Plan — Chat Streaming Render Order (U4 Web UI)

**Requirements**: `requirements.md` (FR-1 ~ FR-4)
**Cycle**: CONSTRUCTION 경량. 단일 유닛(U4). 변경 파일 `web/` 한정.

## Steps

- [x] **S1 — 순수 라이브-턴 모델 / 리듀서 추출** (`web/src/lib/liveTurn.ts`, 신규)
  - 타입: `LiveToolCall`(tool·preview·error·duration),
    `LiveSegment = { kind:'text'; text } | { kind:'tool'; tool }`,
    `LiveTurn = { userText; segments; notes }`, `EMPTY_TURN`.
  - 순수·total 리듀서(입력 미변형, 새 객체 반환):
    - `appendText(turn, text)` — 빈 문자열 no-op; 마지막 세그먼트가 텍스트면 이어붙여
      coalesce, 아니면(또는 없으면) 새 텍스트 세그먼트 push.
    - `startTool(turn, tool, preview)` — tool 세그먼트 push(error=null, duration='').
    - `completeTool(turn, tool, error, duration)` — 뒤에서부터 이름 일치·미완료
      (error===null) tool 세그먼트를 갱신; 없으면 완료 tool 세그먼트 push(기존 폴백 동작 보존).
    - `fallbackText(turn, text)` — `turnHasText`가 false이고 text가 비어있지 않을 때만
      텍스트 세그먼트 push(reasoning.available / run.completed 폴백용 — 델타 미방출 provider).
    - `addNote(turn, note)`, `turnHasText(turn)`(비어있지 않은 텍스트 세그먼트 존재),
      `turnIsEmpty(turn)`.

- [x] **S2 — consumeStream / submit 리와이어** (`ChatView.tsx`)
  - `message.delta` → `appendText` · `tool.started` → `startTool` ·
    `tool.completed` → `completeTool` · `reasoning.available` / `run.completed` →
    `fallbackText` · `pushNote` → `addNote`.
  - `submit`의 `setTurn({ ...EMPTY_TURN, userText })` 및 `EMPTY_TURN`을 lib 임포트로 교체.
  - 로컬 `ToolCall` / `LiveTurn` / `EMPTY_TURN` 정의 제거(→ `lib/liveTurn` 임포트).

- [x] **S3 — LiveTurnBlock 재작성** (`ChatView.tsx`)
  - `turn.segments`를 **순서대로** map: `tool` → `LiveToolCard`, `text` → `Markdown`.
  - 커서(▍)는 `streaming && 이 세그먼트가 마지막 세그먼트 && 텍스트`일 때만 표시.
  - `turnIsEmpty` 가드로 빈 턴 null. testid 유지(`chat-live-turn` / `chat-tool-call` /
    `chat-system-note`). `LiveToolCard`의 prop 타입을 `LiveToolCall`로 갱신.

- [x] **S4 — 속성 테스트** (`web/tests/property/liveTurn.test.ts`, 신규)
  - 순서 보존: 임의 이벤트열 적용 → 세그먼트 순서가 tool / text 발생 순서를 반영.
  - delta coalescing: 연속 delta는 1개 텍스트 세그먼트로 병합, tool 뒤 delta는 새 세그먼트.
  - tool 완료 매칭: `completeTool`이 가장 최근 미완료 동명 tool을 갱신.
  - fallback: `turnHasText`가 true면 `fallbackText` no-op.
  - totality: 임의 (event, turn) 조합에서 무예외.
  - 불변식: tool 세그먼트 수 == `startTool` 호출 수.

- [x] **S5 — 검증**
  - `pnpm -C web tsc`(0 errors) · `eslint`(0 warnings) · `vitest`(신규 포함 전부 green) ·
    Playwright E2E(스트리밍 tick / 중단 / 승인 시나리오 포함) · `vite build` →
    `caduceus/web_dist` 갱신.
  - 실기 스모크: 다중 tool 턴에서 `content → tool → content → tool` 순서가 라이브에
    그대로 나타나고 턴 종료 재-하이드레이트 후 순서 불변인지 육안 확인.

## 영향 / 리스크

- 단일 뷰 파일 로직 교체 + 신규 순수 lib. 백엔드·데이터·`transcript.ts` 무변경 →
  재-하이드레이트 경로·W7 불변 안전.
- 세그먼트는 append / in-place 갱신만(재정렬·삭제 없음) → 인덱스 key 안전(기존과 동일).
- E2E 계약: `chat-live-turn`이 스트리밍 텍스트 포함(125) 유지, `chat-system-note`
  중단 노트(127) 유지 → 회귀 없음 예상.
- 롤백 용이: 뷰 + lib 국소 변경, 커밋 단위 분리.
