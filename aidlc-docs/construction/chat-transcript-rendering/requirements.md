# Requirements — Chat Transcript Rendering (U4 Web UI)

**Stage**: CONSTRUCTION — 점진 개선 (어댑티브, 경량)
**Date**: 2026-07-04
**Scope**: `web/src/lib/transcript.ts`, `web/src/lib/types.ts`,
`web/src/pages/chat/ChatView.tsx` 및 관련 테스트만. 백엔드/hermes/프록시 변경 없음.

## 1. 배경 / Intent

세션 저장소(`GET /api/sessions/{id}/messages`)의 메시지에는 다음 패턴이 존재한다:

- **assistant** 메시지 하나에 `reasoning`(=`reasoning_content`, 모델 사고 과정) +
  `content`(사용자에게 보이는 응답 텍스트) + `tool_calls[]`(도구 호출, `id`/`call_id` 보유)가
  **동시에** 실릴 수 있다 (`finish_reason: "tool_calls"`).
- 후속 **tool** 메시지는 `tool_call_id`로 어느 호출의 결과인지 가리키며, `content`는
  terminal 계열의 경우 `{"output": …, "exit_code": …, "error": …}` JSON 문자열이다.

### 현행 문제 (ChatView.tsx `TranscriptBlock`)

1. assistant 렌더 순서가 **thinking → tool chips → content** 로, 실제 발생 순서
   (생각 → 응답 텍스트 → 도구 실행)와 어긋난다.
2. tool result가 **별도의 독립 Collapsible 블록**으로 렌더되어, 어떤 도구 호출의
   결과인지 시각적으로 연결되지 않는다. 호출 인자(args)는 80자 잘린 칩,
   결과는 접힌 요약 한 줄이라 "무엇을 실행했고 결과가 뭐였는지" 파악이 어렵다.
3. `SessionMessage` 타입에 `tool_call_id` 필드 자체가 없어 페어링이 불가능하다.

## 2. 기능 요구사항

### FR-1 — assistant 메시지 렌더 순서 (사용자 명시)
- reasoning + content + tool_calls가 한 메시지에 공존하면
  **thinking → content(마크다운) → tool calls** 순서로 렌더한다.
- reasoning/content/tool_calls 중 일부만 있는 경우에도 동일한 상대 순서를 유지한다.

### FR-2 — tool result를 도구 호출 카드에 병합 (사용자 명시)
- `role: "tool"` 메시지는 `tool_call_id`를 직전 assistant 메시지의
  `tool_calls[].id`(또는 `call_id`)와 매칭하여 **해당 도구 호출 카드 안에**
  입력 args + 결과 output을 함께 렌더한다.
- 매칭되어 병합된 tool 메시지는 **별도 transcript 블록으로 렌더하지 않는다**.
- **고아(orphan) 안전성**: 매칭 실패한 tool 메시지는 기존처럼 독립 카드로 폴백 —
  메시지는 절대 드롭되지 않는다 (PU4-4 총함수 불변식의 재정의: "모든 메시지는
  정확히 한 곳에 렌더된다").
- 결과가 (아직) 없는 tool call은 args만 있는 카드로 렌더한다 (거부/미완료 등).

### FR-3 — 도구 호출 카드 디자인 개선 (사용자 명시)
- 어떤 도구가 **어떤 인자로** 호출됐고 **결과가 어땠는지**를 한눈에 파악 가능해야 한다.
- 성공/실패 상태를 시각적으로 구분한다 (terminal 계열: `error` 필드·`exit_code` 활용).
- 카드 상호작용 모델(접힘/펼침)은 Q1, args/output 포매팅 수준은 Q2에서 결정.

### FR-4 — 파생 작업
- `SessionMessage` 타입에 `tool_call_id?: string | null` 추가 (types.ts).
- `transcriptFromMessages`가 페어링을 수행하도록 확장 — 페어링은 **순수 함수**로 유지.
- 라이브 스트리밍 턴(`LiveTurnBlock`)의 도구 표시를 새 카드와 통일할지는 Q3에서 결정
  (라이브 이벤트에는 preview/duration만 있고 full args/output은 재-하이드레이트 후 제공).

## 3. 비기능 / 제약

- **W7 단일 소스 불변**: transcript는 항상 서버에서 재-하이드레이트. 이번 변경은
  매핑(lib/transcript)과 view(ChatView)에 한정하며 데이터 소스/chatMachine을 바꾸지 않는다.
- **redact 파이프라인 유지**: args/output/reasoning 표시 전 기존 `redact()` 적용 유지.
- **기존 test-id 호환**: `chat-tool-call`, `chat-tool-result`, `chat-thinking-toggle`은
  현재 E2E에서 미참조 확인 — 형태 변경 가능하나 testid 자체는 유지 권장.
- **테스트 갱신**: `tests/property/transcript.test.ts`의 "메시지 1개 → 아이템 1개"
  속성을 "메시지 무손실(병합 or 독립 렌더)" 속성으로 재정의 + 페어링 속성 추가.
- **회귀 없음**: tsc / eslint / vitest / Playwright E2E 전부 통과,
  `vite build`로 `caduceus/web_dist` 갱신.

## 4. Extension 적용성 (경량 판단)

- **Resiliency Baseline**: 순수 프론트 view/매핑 변경. 임의 형상 메시지에 대한
  무예외(total function) + 무손실 불변식 유지가 곧 회복탄력성. → 해당 불변식으로 커버.
- **Security Baseline**: 신규 입출력 경계 없음. redact 유지. args/output은 이미
  세션 저장소에서 오던 데이터의 표시 방식 변경. → N/A.
- **Property-Based Testing**: 페어링 로직이 순수 함수 → fast-check 속성 테스트 대상
  (무손실, tool_call_id 매칭 정확성, 순서 보존, 임의 형상 무예외).

## 5. 결정 필요 (→ requirements-questions.md)

- **Q1** 도구 카드 상호작용 모델 (접힘 기본 vs 항상 펼침)
- **Q2** args/output 포매팅 수준 (스마트 포매팅 vs raw)
- **Q3** 라이브 스트리밍 턴의 도구 표시 통일 여부

FR-1(렌더 순서)과 FR-2(병합 동작)는 요청이 충분히 구체적이라 별도 질문 없이 위 명세대로 구현.
