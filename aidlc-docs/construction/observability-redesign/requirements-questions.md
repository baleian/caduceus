# Observability 전면 재설계 — Requirements 결정 질문

전용 Observability 메뉴를 새로 만들어 **Total(fleet) / Agent / Session** 으로 좁혀보며,
**통계값 + 시계열 활동 지표**를 높은 수준으로 시각화하는 것이 목표입니다.

아래는 설계를 확정하기 위한 결정 질문입니다. 각 `[Answer]:` 뒤에 A~F 중 하나를 적어주세요.
없으면 마지막 "Other"를 고르고 설명을 덧붙이면 됩니다.

---

## 배경 — 두 데이터 소스의 성격 (질문 이해에 필요)

| 소스 | 성격 | 주는 값 | 시계열 가능성 |
|---|---|---|---|
| **hermes-native** (`/api/sessions` fan-out) | **영속**(디스크 세션 DB), per-**session** | api_call_count(요청수), 토큰 6종, cost(est/actual), tool_call_count, message_count, started_at/last_active/ended_at, model, source | 세션 타임스탬프 **버킷팅**으로 가능(단위: 세션 시작/활동 시각 — per-request 정밀 아님) |
| **gateway TrafficStats** | **휘발**(데몬 재시작 시 리셋), per-**agent** | requests, errors(4xx/5xx), latency, 최근 100개 링 + WS 라이브 피드 | per-request **정밀** 시계열이지만 브라우저 세션/프로세스 수명 한정 |

즉 **latency·error·정밀 요청 시계열**은 gateway만 알고(휘발), **영속 누적·토큰·비용·세션·요청수**는 hermes만 압니다(영속·다소 coarse). 이 이원성을 어떻게 다룰지가 핵심입니다.

---

## Question 1 — 메뉴/정보구조(IA)와 Narrow-down 방식
전용 Observability 섹션을 어떤 구조로 만들까요?

A) 새 최상위 메뉴 **"Observability"** 1개 + 페이지 내 스코프 전환기(Fleet → Agent → Session)를 드릴다운(클릭해 내려가고 breadcrumb로 복귀). 기존 Dashboard는 운영 상태 홈으로 유지, 트래픽 시각화는 Observability로 이전/통합.

B) 새 메뉴 "Observability" 만들되 **Fleet + Agent 2단계까지만**. Session 상세는 기존 Agent 상세의 세션 목록에 지표를 얹는 형태로 분리.

C) 새 메뉴 + 좌측에 **스코프 트리(Fleet/agent들/세션들) 상시 네비게이터**를 두고 오른쪽에 지표 패널(항상 3단계 탐색 가능).

D) Other (please describe after [Answer]: tag below)

[Answer]: D — (합의) Fleet vs Agent는 1:1 아님(Fleet=N-agent 롤업). 스코프를 **Total**(플릿 집계 + agent 비교/랭킹) 과 **Agent**(단일 agent 상세) 2개로 구분. Session은 최상위 레벨이 아니라 **Agent 뷰의 각 metric 패널 내부에서 narrow-down**. 단 session 분해는 hermes-native 지표 한정(latency/errors는 gateway가 세션 id를 몰라 agent 레벨까지만).

---

## Question 2 — 집계 아키텍처 (어디서 fan-out·버킷팅하나)
현재는 브라우저가 agent마다 `/api/sessions`를 직접 호출(fan-out)해 합산합니다. 관측 페이지는 Total/Agent/Session + 시계열이라 데이터량이 커집니다.

A) **데몬 측 신규 집계 엔드포인트** 신설(예: `GET /api/observability?scope=&range=`). 데몬이 fan-out + 버킷팅 + gateway TrafficStats 병합을 서버에서 수행해 **바로 그릴 수 있는 시계열/통계 JSON**을 1회 응답으로 반환. 브라우저 경량, 두 소스 병합이 깔끔, 캐시 가능. (백엔드 작업 증가)

B) **클라이언트 집계 유지·확장**. 기존 `useAgentUsage` 패턴을 늘려 브라우저에서 fan-out·버킷팅. 백엔드 최소 변경(필요 시 relay allowlist에 경로 추가 정도). (브라우저 부하↑, N fan-out 유지)

C) **하이브리드**: 영속 세션 집계는 데몬 엔드포인트(A), 라이브 정밀 트래픽은 기존 WS 피드 그대로(B). 두 채널을 UI에서 합성.

D) Other (please describe after [Answer]: tag below)

[Answer]: C

---

## Question 3 — Gateway 지표(latency/error/정밀 요청)의 이력 보존
TrafficStats는 휘발성(재시작 리셋, 링 100)이고 WS 피드는 브라우저 세션 한정입니다. 관측 메뉴에서 latency/error 시계열을 어디까지 보여줄까요?

A) **휘발 유지(무상태 원칙 고수)**. latency/error/정밀 요청 시계열은 "현재 프로세스/세션 창"만 표시하고 라벨 명시("since daemon start"). 영속 시계열(요청수/세션/토큰/비용)은 hermes 세션 버킷으로 별도 제공.

B) **경량 영속 도입**. gateway 지표를 분/시간 단위로 롤업해 디스크에 append(예: 롤링 24h~30d 집계)해서 재시작에도 latency/error 시계열 생존. (무상태 원칙 일부 완화 — 소형 stateful 컴포넌트 추가)

C) **인메모리 확장만**. 링을 키우고 다해상도(초/분)로 늘려 라이브 시계열은 풍부하게, 단 재시작 리셋은 수용.

D) Other (please describe after [Answer]: tag below)

[Answer]: C — 확인: A와 동일(휘발·재시작 리셋·디스크 영속 없음·"since daemon start")하되 링을 크게 확장 + 다해상도(초/분 롤업). 메모리 캡 적용(`deque(maxlen)` 하드 캡 + 유한 롤업 버킷).

---

## Question 4 — "요청수(Requests) 시계열"의 기준 소스
요청수를 시간축에 그릴 때 무엇을 기준으로 할까요? (Q3와 연결)

A) **세션 버킷(영속·coarse)**. hermes `api_call_count`를 세션 started_at/last_active 시각에 배치해 일/시간 버킷 합산. 재시작에도 생존하나 "언제 각 호출이 일어났는지"는 세션 단위 근사.

B) **Gateway 라이브(정밀·휘발)**. WS 피드의 per-request 타임스탬프로 정밀 버킷. 정확하지만 프로세스/세션 수명 한정.

C) **레이어드**: 영속 coarse 베이스라인(A) 위에 최근 구간은 정밀 라이브(B)를 오버레이.

D) Other (please describe after [Answer]: tag below)

[Answer]: A

---

## Question 5 — 시간 범위·해상도 프리셋
시계열 차트가 제공할 기간/버킷 옵션은?

A) 프리셋 **24h / 7d / 30d** + 범위별 자동 버킷(시간/일). 심플·표준.

B) 프리셋 위 3종 + **Live(최근 N분, 초·분 버킷)** 탭 추가(라이브 정밀 트래픽 전용).

C) 프리셋 + **커스텀 범위 지정**(from–to)까지.

D) Other (please describe after [Answer]: tag below)

[Answer]: B

---

## Question 6 — 지표 세트(카드/시리즈) 범위
제안하는 지표 묶음입니다. 어느 수준으로 넣을까요? (Session-per-tool breakdown은 사용자 요청대로 **제외**. 단 세션당 `tool_call_count` "합계"는 `/api/sessions`에서 공짜로 나오므로 **카운트 지표로는 포함 가능**)

제안 전체 목록:
- 활동/트래픽: **Requests(api_calls)**, **Errors**, **Error rate**, **Latency(avg/p50/p95)**, **Throughput(req/min)**
- 세션: **Sessions 수**, **Active sessions**, **평균 세션 길이(duration)**, **Messages 수**, **Tool calls 수(count)**
- 토큰/비용: **Tokens(in/out/cache/reasoning)**, **Cache hit ratio**, **Cost(est/actual)**
- 분포: **Model 분포**, **Source/채널 분포**

A) **Essential** — Requests, Errors/rate, Latency, Sessions, Tokens(in/out), Cost, Model 분포. (핵심만, 깔끔)

B) **Rich(권장)** — Essential + Latency p50/p95, Throughput, Active sessions, 평균 세션 길이, Cache hit ratio, Tool calls(count), Messages, Source 분포, cache/reasoning 토큰.

C) **Everything** — 위 전체 + 향후 여지(예: end_reason 분포, 세션당 avg tokens 등)까지 최대.

D) Other (please describe after [Answer]: tag below)

[Answer]: B

---

## (선택) Question 7 — 자동 갱신 방식
관측 페이지 열려있을 때 데이터 갱신은?

A) **주기 폴링**(예: 15초) + 수동 새로고침 버튼.

B) **라이브 트래픽만 WS 실시간** + 영속 통계는 주기 폴링(예: 30초).

C) **수동 새로고침 위주**(불필요한 fan-out 최소화).

D) Other (please describe after [Answer]: tag below)

[Answer]: A
