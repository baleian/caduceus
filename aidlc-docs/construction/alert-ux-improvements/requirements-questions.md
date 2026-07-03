# Alert UX Improvements — Clarification Questions

각 질문의 `[Answer]:` 뒤에 알파벳(A/B/…)을 적어 주세요. 마음에 드는 보기가 없으면
"Other"를 고르고 뒤에 원하는 바를 서술하면 됩니다. 다 되면 알려 주세요.

---

## Question 1
`GET /api/alerts`가 반환할 "현재 활성 drift/orphan" 상태는 어떻게 만들까요?

A) **Reconciler 주기 스냅샷 (권장)** — Reconciler가 매 reconcile 주기(기본 30s)
   감지 결과로 활성 condition 집합을 메모리에 갱신하고, API는 그걸 그대로 반환.
   추가 부하 0, 응답 즉시. 단점: 최대 30s 이전 상태일 수 있음(`checked_at`으로 명시).

B) **요청 시 즉석 감지** — API 호출 시마다 detect-only 검사(레지스트리 순회 +
   프로필 파일 읽기 + docker ps)를 실행해 항상 최신 상태 반환. 단점: 페이지 로드마다
   파일/도커 I/O 비용, 감지 로직이 두 경로로 갈라짐.

C) Other (please describe after [Answer]: tag below)

[Answer]: A

---

## Question 2
WS 이벤트 스트림에서 replay와 live를 어떻게 구분할까요? (replay = 토스트 금지)

A) **데몬 sync 마커 (권장)** — 데몬이 replay 전송을 마친 뒤 `events.synced` 마커
   이벤트를 1개 보냄. 웹은 마커 수신 전 이벤트로는 토스트를 만들지 않음. 재접속마다
   정확히 동작하고 시계 차이와 무관. 웹/CLI는 이 kind를 조용히 무시(이력 미적재).

B) **클라이언트 시각 비교** — 데몬 무수정. 웹이 WS 연결 시각을 기록하고 `event.ts`가
   그보다 오래된 이벤트는 토스트 생략. 단점: 브라우저-데몬 호스트 간 시계가 어긋나면
   과거 알림이 다시 토스트되거나 새 알림이 묵살될 수 있음.

C) Other (please describe after [Answer]: tag below)

[Answer]: A

---

## Question 3
Dashboard의 알림 패널(현재: 이벤트 이력 최근 8개)은 어떻게 할까요?

A) **활성 스냅샷 기반으로 교체 (권장)** — Dashboard 패널은 `/api/alerts`의 "지금
   활성인 문제"만 표시(없으면 "no active alerts"). 역할 분리가 명확해짐:
   Dashboard = 현재 상태, System 보드 = 세션 이력(replay 포함).

B) **현행 유지** — Dashboard 패널도 System 보드처럼 이벤트 이력 표시를 유지하고,
   이번 개선은 토스트 정책만 변경.

C) Other (please describe after [Answer]: tag below)

[Answer]: A

---

## Question 4
페이지를 열어둔 동안 "해소됨" 반영(활성 알림이 사라지는 것)은 어떻게 갱신할까요?

A) **조건부 재조회 (권장)** — WS (재)접속 시 + drift/orphan live 이벤트 수신 시
   `/api/alerts` 재조회하고, 활성 알림이 1개 이상 남아 있는 동안에만 reconcile
   주기(30s)로 폴링. 문제가 없는 평상시엔 폴링 0회. 해소되면 다음 주기에 패널/맵에서
   사라짐.

B) **접속 시에만** — (재)접속·새로고침 시에만 스냅샷 동기화. 열어둔 페이지에서는
   해소가 반영되지 않음(새 알림은 live 이벤트로 계속 표시됨). 구현 최소.

C) Other (please describe after [Answer]: tag below)

[Answer]: A
