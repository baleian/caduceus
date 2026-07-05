# per-agent Chat → sessions/chat/stream 마이그레이션 — Requirements 결정 질문

현재 per-agent chat(`ChatView.tsx`)을 hermes **runs** 흐름에서 **sessions/chat/stream**(네이티브 히스토리 하이드레이션 + 우리 approval/stop 패치)으로 전환하는 계획입니다.

각 `[Answer]:` 뒤에 A/B/C… 중 하나를 적어주세요. 없으면 마지막 X(기타)에 설명을 덧붙이면 됩니다.
내가 근거·추천을 달았고, 최종 방향은 네 결정으로 정합니다.

---

## Q1 — 스코프와 룸 설계와의 관계 (방향을 가르는 질문)

`ten` 브랜치 설계상 미래 **Main Chat 룸**은 runs+Caduceus 주입(C1) 기반(멀티에이전트 멀티플렉스, SOT=Caduceus). 반면 **현재 per-agent chat**(1:1)은 sessions 네이티브 하이드레이션이 정답. 이번 마이그레이션의 성격은?

A) **per-agent chat만** sessions/chat/stream으로 전환. 룸 설계는 그대로 runs 유지(두 전송 공존, 직교). per-agent chat은 Agent 상세에서 접근하는 실사용 기능이라 룸과 무관하게 지속 가치. (추천)

B) 이번 전환을 **룸 전송 재검토의 계기**로 삼는다 — 룸도 (agent,thread) 세션을 sessions/chat/stream으로 돌리는 대안을 별도로 평가(룸 설계 §7/§9 재검토 필요, 이번 사이클 밖 큰 결정).

C) per-agent chat **웹 + CLI(`caduceus/cli/chat.py`)** 둘 다 전환(일관성).

X) 기타

[Answer]: A

---

## Q2 — runs 클라이언트 코드 처리

전환 후 `startRun`/`streamRunEvents`/`historyFromMessages`(턴 주입용)가 per-agent chat에서 불필요해집니다.

A) **제거** — 사용처가 사라진 `startRun`/`streamRunEvents`와 턴용 `conversation_history` 조립을 걷어낸다(표시용 `fetchMessages`/transcript는 유지). 죽은 코드 없이 깔끔. (추천, 단 Q1=A 전제)

B) **보존** — 롤백/폴백 대비로 남겨둔다(당장 미사용). 룸이 runs를 쓰므로 `agentApi.ts`의 runs 헬퍼 자체는 어차피 남을 수 있음.

X) 기타

[Answer]: A

---

## Q3 — 멀티모달(이미지) 입력

sessions/chat/stream의 `message`는 멀티모달 content를 **네이티브 수용**(이미지 입력, 출력은 assistant.completed가 media→data URL 해소). 지금 챗 입력창은 텍스트 전용입니다.

A) **이번엔 전송 마이그레이션만** — 텍스트 입력 유지, 이미지 입력은 후속 사이클. (추천 — 스코프 규율)

B) **이미지 입력도 지금 추가** — 첨부 UI + 멀티모달 body 구성까지 포함(스코프↑).

X) 기타

[Answer]: A

---

## Q4 — 라이브 "thinking"(reasoning) 표시

sessions 스트림은 reasoning을 `tool.progress(tool_name=_thinking)`로 라이브 방출합니다. 현재 runs 경로는 reasoning을 라이브로 거의 안 보여주고(“세션에만 영속” 노트), 재수화 transcript에서만 노출.

A) **현행 동작 유지(패리티 우선)** — 라이브 thinking을 새로 표시하지 않음. reasoning은 기존처럼 재수화 transcript에서. 마이그레이션 위험 최소. (추천)

B) **라이브 thinking 표시** — `tool.progress(_thinking)`를 라이브 턴에 반영(직전 transcript/streaming-order 렌더 규칙과 정합 필요, 비용 소).

X) 기타

[Answer]: B

---

## Q5 — 재설치 게이트웨이 반영(운영)

로컬 hermes는 패치 브랜치로 교체됐지만, 실행 중 게이트웨이 3개(cad-test/2/3)는 **옛 코드 메모리 보유**. 신규 코드는 agent 재시작(Caduceus 재spawn) 시 반영됩니다. (caduceus serve 본체는 네 포그라운드 터미널 — 미개입.)

A) **지금 3개 agent 재시작** — 곧바로 패치 코드로 전환해 E2E/수동 검증 가능. 진행 중 세션 잠깐 중단됨. (추천 — 검증 위해 필요)

B) **구현/테스트 시점에 재시작** — 계획 확정 후 코드 작업과 함께.

C) 내가(사용자) 직접 재시작하겠다.

X) 기타

[Answer]: A

---

> 답이 모이면 requirements.md를 확정하고 Code Generation Plan(S1..Sn)으로 진행합니다.
