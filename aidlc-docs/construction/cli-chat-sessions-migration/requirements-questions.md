# CLI `caduceus chat` → sessions/chat/stream — Requirements 결정 질문

CLI 챗을 runs에서 sessions/chat/stream으로 전환합니다. 세션 해석(`resolve_session`)·`--session`/`--new` 플래그·SSE 파서·POST 스트림은 **이미 갖춰져 있어** 순수 전송 전환입니다. 아래 `[Answer]:` 뒤에 A/B… 를 적어주세요.

---

## Q1 — CLI reasoning 표시 방식

**실측(사용자)**: sessions 스트림도 reasoning이 **content 뒤에** 도착함(라이브 아님). 웹은 재수화로 reasoning↔content 재배치가 됐지만, 콘솔은 append-only라 재배치 불가 → 답변 아래에 reasoning이 붙어 직관적이지 못함. 위치를 못 바꾸니 **분리·라벨링**이 관건.

B1) **라벨된 dim 푸터(추천)** — content 라이브 스트리밍, reasoning은 버퍼링 후 턴 종료 시 `─ thinking ─` 구분선과 함께 dim 출력. 손실 없음, 새 플래그 없음, "사후 사고"로 읽힘.

B2) **opt-in** — 기본 숨김, `--reasoning` 플래그 또는 `/reasoning` REPL 명령으로 직전 턴 reasoning 표시(세션 스토어/버퍼).

B3) **완전 미표시** — content만. reasoning 손실.

X) 기타

[Answer]: B3 — reasoning 완전 미표시(content만). sessions 스트림 reasoning이 content 뒤에 도착하고 콘솔은 재배치 불가라, 지금은 표시하지 않기로 확정.

---

## Q2 — 웹 hydrate-outage 버그 동반 수정 여부

직전에 설명한 웹 버그: 부분 장애(POST 실패·GET 성공) 시 finally `hydrate`가 에러 note·입력 메시지를 덮어 "실패 피드백이 사라지는" 문제(마이그레이션 이전부터 존재, 웹 `ChatView.tsx`).

A) **이번에 함께 수정** — 작은 웹 수정을 별도 스텝/커밋으로 포함(POST가 스트림을 시작 못 했으면 재수화 스킵 + 입력 복원). (추천 — 저비용, 사용자 관심 사안)

B) **별도 사이클로 미룸** — 이번은 CLI 전송 전환만.

X) 기타

[Answer]: A

---

## Q3 — 미사용화되는 runs 경로 코드 처리

전환 후 `_history`(턴 주입용)가 미사용됩니다. `_messages_raw`는 `_render_tool_failures`가 계속 사용하므로 유지.

A) **제거** — `_history` 삭제(+ 관련 test 갱신). runs 방식 잔재 없이 정리. (추천)

B) **보존** — 롤백 대비 남김.

X) 기타

[Answer]: A

---

> 답이 모이면 requirements 확정 → Code Generation Plan(S1..Sn) → 생성.
