# Code Generation Plan — Chat Transcript Rendering (U4 Web UI)

**Date**: 2026-07-04
**Requirements**: `requirements.md` (FR-1~FR-4) — 답변 Q1=A(접힘 카드+요약 헤더) / Q2=A(스마트 포매팅) / Q3=A(라이브 통일)
**Scope**: `web/src/lib/` + `web/src/pages/chat/ChatView.tsx` + `web/tests/`. 백엔드/hermes/프록시/chatMachine 무변경.
**이 파일이 Code Generation의 단일 소스 오브 트루스입니다.**

## Unit Context

- **대상**: U4 Web UI — transcript 매핑(lib)과 채팅 view(ChatView)만.
- **참조 실데이터** (세션 `api_1783094412_efcf71ec`에서 확인, 2026-07-04):
  - **terminal (구조화)**: `{"output": str, "exit_code": int, "error": str|null}` —
    성공 `exit_code:0/error:null`, 실패 `exit_code:127`(output에 오류 텍스트, error는 null).
    → 실패 판정: `exit_code != 0` **또는** `error` 비어있지 않음.
  - **browser_navigate (래핑)**: content가 `<untrusted_tool_result source="…">` +
    고정 preamble 문단 + JSON body(`{"success": false, "error": "Blocked: …"}`) +
    `</untrusted_tool_result>`. → 래퍼/preamble 제거 후 내부 body 파싱.
    실패 판정: `success === false` 또는 `error` 비어있지 않음.
  - **write_file (임의 JSON)**: `{"bytes_written", "dirs_created", "lint": {...},
    "resolved_path", "files_modified": [...]}` → 일반 key-value 표시.
  - **비-JSON**: raw 텍스트 폴백.
  - assistant 패턴: content+tool_calls 동시(예: id 52), tool_calls만(content 빈 문자열),
    reasoning+content+tool_calls 동시(사용자 예시 id 34). `tool_calls[].id`==`call_id`.
- **보존 계약**:
  - W7: transcript는 서버 재-하이드레이트가 단일 소스. `historyFromMessages` 무변경.
  - `redact()`를 모든 표시 문자열(args/output/reasoning)에 현행처럼 적용.
  - test-id 유지: `chat-tool-call`(호출 카드), `chat-tool-result`(고아 결과),
    `chat-thinking-toggle`, `chat-live-turn`. 카드 내부 신규: `chat-tool-card-args`,
    `chat-tool-card-result`.
  - PU4-4 총함수 불변식 재정의: "모든 메시지는 정확히 한 곳에 렌더" (병합 or 독립).

## Steps

### lib — FR-2 페어링, FR-4 타입 (순수 함수)

- [x] **S1. 타입 확장** (`web/src/lib/types.ts`)
  - `SessionMessage`에 `tool_call_id?: string | null` 추가.
- [x] **S2. 스마트 포매팅 파서** (`web/src/lib/toolFormat.ts` 신규, Q2=A)
  - `parseToolArgs(args: string): ArgsView` — JSON 파싱 →
    `{ kind: 'fields', fields: {key, value}[] }` (중첩 값은 JSON 문자열화);
    파싱 실패 → `{ kind: 'raw', text }`. 요약용 `argsSummary(args): string` —
    `command` 등 단일 대표 필드 우선, 없으면 `k=v` 조인 후 절단.
  - `parseToolResult(content: unknown): ResultView` —
    (1) `<untrusted_tool_result …>` 래퍼면 태그+고정 preamble 문단 제거 후 body로;
    (2) JSON 객체면: terminal 계열(`output`/`exit_code`/`error` 키) →
    `{ kind: 'terminal', output, exitCode, error, failed }`;
    그 외 객체 → `{ kind: 'fields', fields, failed }`(`success:false`·비어있지 않은
    `error`로 실패 판정); (3) 비-JSON → `{ kind: 'raw', text, failed: false }`.
  - 모든 파서는 임의 입력에 무예외(total). 요약 문자열은 단일 라인·길이 제한.
- [x] **S3. transcript 페어링** (`web/src/lib/transcript.ts`, FR-2)
  - `TranscriptToolCall`에 `id: string`, `result: { text: string } | null` 추가
    (result의 파싱/표시는 view에서 toolFormat 사용 — lib 매핑은 원문 보존).
  - `transcriptFromMessages`: 순회하며 미청구(unclaimed) call id 맵 유지 —
    `role:"tool"` && `tool_call_id`가 미청구 id와 일치 → 해당 assistant 아이템의
    toolCall.result에 병합(청구 처리), transcript 아이템 미생성.
    불일치/중복 청구/id 없음 → 기존처럼 독립 `tool` 아이템(고아 폴백).
  - 순서·무손실 보장: user/assistant/other 매핑 현행 유지.

### view — FR-1 순서, FR-3 카드 (Q1=A), 라이브 통일 (Q3=A)

- [x] **S4. ToolCallCard 컴포넌트** (`web/src/pages/chat/ChatView.tsx`)
  - 접힘 기본. 헤더: 상태 아이콘(✓ ok / ✗ failed / ● 결과 없음 / 스피너 live-running)
    + 도구명 + args 한 줄 요약 + (실패 시) 오류 힌트 + duration(라이브) + chevron.
    실패 카드는 `border-bad/50` 계열로 즉시 구분.
  - 펼침: **Arguments** 섹션(fields면 key-value 그리드, `command`는 코드 라인 강조;
    raw면 pre) + **Result** 섹션(terminal: output 코드 블록 + `exit code n` 뱃지 +
    error 빨간 강조; fields: key-value 그리드; raw: pre). 결과 없으면 "no result".
  - `data-testid="chat-tool-call"` 유지, 내부 섹션 testid 부여. 라이브 변형:
    preview 텍스트를 요약 자리에, 완료 시 ✓/✗+duration (Q3=A) — 동일 카드 셸 재사용.
- [x] **S5. TranscriptBlock 재배치 + 병합 렌더** (`web/src/pages/chat/ChatView.tsx`)
  - assistant: **thinking → content(Markdown) → ToolCallCard[]** 순서로 변경(FR-1).
  - toolCall.result가 있으면 카드에 함께 렌더(FR-2) — 기존 독립 tool Collapsible은
    고아 아이템 전용(`chat-tool-result`, 카드 스타일로 통일).
  - `LiveTurnBlock`: 칩 → 라이브 카드로 교체(Q3=A). 동작(스피너→성패+duration) 유지.

### 테스트 + 검증

- [x] **S6. 테스트** (PBT 확장 적용)
  - `web/tests/property/transcript.test.ts` 갱신: "메시지 1:1" →
    **무손실 속성**(아이템 수 + 병합 결과 수 == 메시지 수, 병합은 call id 정확 일치,
    청구는 id당 1회, 순서 보존, 임의 형상 무예외). 고아 tool 메시지 독립 렌더 케이스.
  - `web/tests/property/toolFormat.test.ts` 신규(fast-check): 임의 문자열/JSON에
    무예외, 요약 단일 라인·경계 준수 + 실데이터 픽스처 4종
    (terminal 성공/실패, untrusted 래퍼, write_file 임의 JSON, 비-JSON raw).
- [x] **S7. 검증 + 산출물**
  - tsc / eslint / vitest / Playwright E2E 통과, `vite build` → `caduceus/web_dist` 갱신.
  - `code-summary.md` 작성, plan 체크박스·aidlc-state.md·audit.md 갱신.

## Extension 준수 계획

- **Resiliency**: S2/S3 — 임의 형상 메시지 무예외 + 무손실(드롭 없음) 불변식.
- **Security**: 신규 입출력 경계 없음. redact 파이프라인 유지(S4/S5).
  untrusted 래퍼의 preamble 제거는 표시 정리일 뿐, 내용은 여전히 DATA로만 렌더
  (마크다운 미해석 — 코드 블록/pre로만 표시).
- **PBT**: S6 — 페어링 무손실·청구 유일성·파서 total 속성.
