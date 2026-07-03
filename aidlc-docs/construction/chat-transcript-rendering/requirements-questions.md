# Chat Transcript Rendering — Clarification Questions

각 질문의 `[Answer]:` 뒤에 알파벳(A/B/…)을 적어 주세요. 마음에 드는 보기가 없으면
마지막 "Other"를 고르고 뒤에 원하는 바를 서술하면 됩니다. 다 되면 알려 주세요.

---

## Question 1
도구 호출 카드(FR-3)의 상호작용 모델은 어떻게 할까요?

A) **접힘 기본 + 한 줄 요약 헤더 (권장)** — 카드 헤더에 [상태 아이콘 · 도구명 ·
   args 핵심 한 줄 요약 · (실패 시) 결과 힌트]를 항상 표시하고, 클릭하면 펼쳐져
   Arguments / Result 두 섹션이 정돈되어 나타남. 도구 호출이 많은 세션에서도
   transcript가 어지럽지 않고, 필요할 때만 상세 확인. (실패한 호출은 시각적으로
   구분되는 헤더 색으로 즉시 눈에 띔)

B) **항상 펼침** — 모든 도구 카드가 args + output을 항상 노출. 스크롤은 길어지지만
   클릭 없이 전체 흐름을 읽을 수 있음.

C) Other (please describe after [Answer]: tag below)

[Answer]: A

---

## Question 2
args와 결과(output)의 포매팅 수준은 어떻게 할까요?

A) **스마트 포매팅 (권장)** — arguments JSON을 파싱해 key-value 표시
   (예: terminal이면 `command`를 코드 라인으로 강조). 결과도 JSON이면 파싱해
   terminal 계열은 `output`을 코드 블록으로, `exit_code`를 뱃지로, `error`가 있으면
   빨간 강조로 표시. 파싱 실패 시 raw 텍스트로 안전 폴백.

B) **Raw 표시** — args 문자열과 content 문자열을 그대로 `<pre>` 코드 블록으로.
   구현 단순, 도구 스키마에 무관하게 동일.

C) Other (please describe after [Answer]: tag below)

[Answer]: A

---

## Question 3
라이브 스트리밍 중(턴 진행 중)의 도구 표시도 새 카드 디자인으로 통일할까요?

A) **통일 (권장)** — 라이브에서도 동일한 카드 비주얼 사용. 단 라이브 이벤트에는
   preview(≤120자)와 완료 시 duration/성패만 있으므로 [스피너 → ✓/✗ + duration]의
   축약 카드로 표시하고, 턴 종료 후 재-하이드레이트되면 full args/output 카드로 대체됨
   (현행 W7 흐름 그대로).

B) **현행 칩 유지** — 라이브는 지금의 콤팩트 칩 그대로 두고, 히스토리(하이드레이트된
   transcript)만 새 카드 적용. 라이브/히스토리 시각 차이는 감수.

C) Other (please describe after [Answer]: tag below)

[Answer]: A
