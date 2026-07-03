# Code Summary — Chat Transcript Rendering (U4 Web UI)

**Date**: 2026-07-04
**Plan**: `plan.md` S1~S7 전체 완료 (Q1=A 접힘 카드 / Q2=A 스마트 포매팅 / Q3=A 라이브 통일)

## 변경 파일

### Modified
- `web/src/lib/types.ts` — `SessionMessage.tool_call_id?: string | null` 추가 (S1).
- `web/src/lib/transcript.ts` — 페어링(S3): `TranscriptToolCall`에 `id`/`result` 추가;
  `transcriptFromMessages`가 미청구 call id 맵으로 `role:"tool"` 메시지를 매칭되는
  호출에 병합(청구 1회), 불일치·중복·id 없음은 독립 아이템 폴백. 무손실 불변식:
  `items + merged == messages`. `toolFailureSummary`/`FAILURE_DETAIL_LIMIT` 제거
  (toolFormat이 대체). `historyFromMessages` 무변경.
- `web/src/pages/chat/ChatView.tsx` — (S4) `ToolCallCard`(접힘 기본, 헤더:
  상태 아이콘·도구명·args 요약·실패 힌트, 실패 시 `border-bad` 구분; 펼침:
  Arguments key-value 그리드/raw + Result terminal 출력 코드블록·`exit n` 뱃지·
  error 강조/fields/raw, 모든 표시 문자열 redact, `RESULT_LIMIT` 4000) +
  `LiveToolCard`(동일 셸 헤더-온리, 스피너→✓/✗+duration) + `StatusIcon`/
  `CodeBlock`/`FieldGrid` 헬퍼. (S5) `TranscriptBlock` assistant 순서
  **thinking → content → tool cards**(FR-1), 병합 결과 카드 렌더(FR-2), 고아
  tool 아이템은 `chat-tool-result` testid의 동일 카드. `LiveTurnBlock` 칩 →
  라이브 카드(Q3=A). `ToolChip` 제거.
- `web/tests/property/transcript.test.ts` — 무손실 속성(오라클 대조), 청구
  유일성 속성, 병합/고아·중복 청구 시나리오, history 속성 유지 (S6).

### Created
- `web/src/lib/toolFormat.ts` (S2) — 순수·total 파서:
  `parseToolArgs`(JSON→fields/raw), `argsSummary`(대표 키 command/path/url…
  우선, 단일 라인 ≤100자), `parseToolResult`(`<untrusted_tool_result>` 래퍼+
  preamble 해제 → terminal(`output`/`exit_code`/`error`, 실패=exit≠0∨error)
  / fields(실패=`success:false`∨error) / raw 폴백), `failureHint`.
- `web/tests/property/toolFormat.test.ts` (S6) — 실데이터 픽스처 4종
  (terminal 성공/127 실패, untrusted 래퍼 browser_navigate, write_file 임의
  JSON, 비-JSON raw) + totality/단일라인/경계 fast-check 속성.

## 검증 (S7)

- vitest **73/73** (신규 15 포함) · tsc **0 errors** · eslint **0 warnings**
- Playwright E2E **14/14** · `vite build` → `caduceus/web_dist` 갱신
- 실데이터 검증: 참조 세션 `api_1783094412_efcf71ec` 22개 메시지 →
  15개 아이템(결과 7건 전부 정확 병합), browser_navigate 래퍼 해제+실패 판정,
  terminal 127 실패 힌트, write_file fields, content+tool_calls 동시 메시지의
  FR-1 순서 확인.

## Extension 준수

- **Resiliency**: 파서·매핑 total(임의 형상 무예외) + 무손실 불변식 — PBT로 검증.
- **Security**: 신규 입출력 경계 없음. 표시 문자열 전부 redact 경유. untrusted
  래퍼는 표시 정리만 — 내용은 pre/코드블록의 비활성 텍스트로만 렌더(마크다운 미해석).
- **PBT**: transcript 무손실·청구 유일성, toolFormat totality·요약 경계 속성 추가.
