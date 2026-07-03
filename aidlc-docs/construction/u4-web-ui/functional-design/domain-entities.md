# U4 Web UI — Domain Entities

**Date**: 2026-07-03
**결정 근거**: u4-web-ui-functional-design-plan.md (Q1=A, Q2=A, Q3=A, Q4=A, Q5=B, Q6=A, Q7=A, Q8=A) + 사용자 지시(세션 히스토리 단일 원천 = hermes api_server)
**기술 중립**: 화면·상태·계약 소비만 정의. 스택/상태관리 라이브러리는 NFR Requirements에서.

## 1. 라우트/화면 트리 (Q2=A — 4축)

```text
/                         → /agents 리다이렉트
├── (AuthGate)            토큰 미보유/401 시 전면 토큰 입력 화면 (Q1=A)
├── /agents               Agents 목록 (실시간 상태 배지) + 생성 폼 진입
│   └── /agents/{name}    에이전트 상세 — 탭:
│       ├── overview      상태 합성 카드, start/stop/삭제, dashboard 외부 링크
│       ├── logs          스냅샷 + follow 토글 (Q8=A)
│       └── settings      soul / skills / toolsets / approvals / token rotate (Q4=A)
├── /chat                 에이전트 선택
│   └── /chat/{name}      세션 사이드바(목록/새 세션/이름 변경/삭제 — Q5=B) + 대화 뷰
├── /gateway              업스트림 폼, 에이전트별 트래픽 요약, 최근 요청 목록 (Q7=A)
└── /system               deep status, 잡 이력, 드리프트/이벤트 로그 (Q2=A)
전역: 상단 네비 + 데몬 연결 상태 배지(WS 상태) + 토스트 영역
```

## 2. 클라이언트 상태 모델

모든 상태는 **서버 원천의 렌더 캐시**다 — 유일한 클라이언트 고유 영속 상태는 admin 토큰과 UI 환경설정(localStorage)뿐. 새로고침 시 전 상태는 REST 재조회 + WS 리플레이로 재구성 가능해야 한다.

| 엔티티 | 필드 (개념) | 원천 | 영속 |
|---|---|---|---|
| `AuthState` | token, status(unknown/valid/invalid) | localStorage ↔ 401 응답 | localStorage (토큰만) |
| `ConnectionState` | ws(connected/reconnecting/down), lastSyncAt | WS 소켓 상태 | 없음 |
| `AgentsState` | byName: {record(공개 필드만), status 합성, health} | `GET /api/agents` + WS `process.state`/`health.changed`/`registry.changed` | 없음 |
| `JobsState` | byId: {id, kind, agent, steps[{name, state}], error, done} | `GET /api/jobs[/{id}]` + WS `job.*` | 없음 |
| `ChatState` | agent, sessions[], activeSessionId, transcript[], runState(4-상태), activeRunId, pendingApproval | api_server 세션/메시지/runs (아래 §3) | 없음 (히스토리 비저장 — 단일 원천 규칙 W7) |
| `GatewayState` | upstream{base_url, api_key_env, default_model}, listen, trafficSummary byAgent, recentRequests(≤100) | `GET /api/gateway` + WS `traffic.request` | 없음 |
| `SystemState` | deepStatus, driftAlerts[], eventLog(바운디드) | `GET /api/status` + WS `drift.*`/`orphan.*` | 없음 |
| `UiPrefs` | thinking 펼침 기본값, 테마 등 | 사용자 조작 | localStorage |

## 3. Chat 도메인 (단일 원천 규칙 — 사용자 지시 2026-07-03)

**세션 히스토리의 단일 원천은 hermes api_server의 세션 저장소다.**

- 세션 진입(선택/재개/새로고침) 시 **항상** `GET {agent}/api/api/sessions/{id}/messages`로 전 히스토리를 로드해 transcript를 재구성한다. 로컬에 남아 있던 transcript는 폐기 — 캐시를 원천으로 삼지 않는다
- 스트리밍 중 수신한 델타는 화면 렌더 전용이며, turn 종료 후의 확정 기록 역시 서버가 보관한다 (turn 종료 시 마지막 메시지의 도구 실패 상세를 messages 재조회로 보강하는 것도 동일 원천 사용 — U3와 같은 패턴)
- turn 시작 시 `conversation_history`도 같은 엔드포인트에서 하이드레이션한 값으로 전달 (runs API는 자체 하이드레이션 없음 — U3 검증)

### Transcript 항목 (렌더 모델)

| 종류 | 매핑 |
|---|---|
| `user` | messages role=user / Composer 제출 즉시 낙관 렌더 후 서버 기록이 원천 |
| `assistant` | messages role=assistant / 스트리밍 `message.delta` 누적 |
| `reasoning` | `reasoning.available` (접기 블록, 기본 접힘 — UiPrefs) |
| `tool` | `tool.started`/`tool.completed`(실패 시 messages의 content에서 실패 상세 추출 — U3 `tool_failure_summary` 동일 규칙) |
| `system-note` | run.failed/run.cancelled/stop 접수 등 메타 안내 라인 |

### Run 상태 기계 (U3 PU3-5 승계 — 순수 전이 함수)

상태 `idle / streaming / stopping / awaiting_approval`, 이벤트 `user_message / interrupt(Stop 버튼) / approval_request / approval_answered / stream_end / eof`. 불변식: **turn당 stop 최대 1회, 종료(세션 이탈 허용)는 idle에서만 경고 없음, 세션 파괴 호출은 명시 삭제 UI에서만**. UI 차이: interrupt는 Ctrl+C가 아닌 Stop 버튼, idle+interrupt는 no-op(종료 아님).

## 4. API/WS 계약 소비 매핑 (전 기능 ↔ 기존 U2 표면)

| UI 기능 | 메서드·경로 | 비고 |
|---|---|---|
| 에이전트 목록/상세 | `GET /api/agents[?probe]`, `GET /api/agents/{name}` | 공개 레코드(키/해시 제거 — S3) |
| 생성 (Q3=A) | `POST /api/agents` → 202 {job_id} | 진행률은 WS `job.*` |
| 삭제 | `DELETE /api/agents/{name}` + `X-Confirm: <name>` → 202 | 모달 확인 (W1) |
| start/stop | `POST /api/agents/{name}/start\|stop` → 202 {ok} | 즉시 접수 — 상태는 WS 반영 |
| 로그 (Q8=A) | `GET /api/agents/{name}/logs?last=N` | follow = 1~2s 폴링 tail |
| soul | `GET/PUT /api/agents/{name}/soul` | 전문 교체 |
| skills | `GET /api/agents/{name}/skills`, `PUT .../skills/{skill}` | 토글 |
| toolsets | `GET/PUT /api/agents/{name}/toolsets` | 구조화 폼 + raw 보기 |
| approvals | `GET/PUT /api/agents/{name}/approvals` | mode 셀렉트 |
| token rotate | `POST /api/agents/{name}/token/rotate` → 204 | 원문 비표시 (W2) |
| 업스트림 | `GET /api/gateway`, `PUT /api/gateway/upstream` | 핫스왑 |
| 트래픽 | `GET /api/gateway`(요약·링버퍼) + WS `traffic.request` | 본문 없음 — 메타만 |
| 잡 | `GET /api/jobs[/{id}]` + WS `job.*` | |
| deep status | `GET /api/status` | System 페이지 |
| 실시간 (Q6=A) | `WS /api/events?token=` | 리플레이 500 + 실시간 |
| 세션 목록/생성 | `GET/POST {agent}/api/api/sessions` | 리버스 프록시 경유 |
| 세션 이름 변경/삭제 (Q5=B) | `PATCH/DELETE {agent}/api/api/sessions/{id}` | 네이티브 (hermes-research §api_server) |
| 히스토리 로드 | `GET {agent}/api/api/sessions/{id}/messages` | **단일 원천** (§3) |
| turn 시작 | `POST {agent}/api/v1/runs` {session_id, input, conversation_history} | U3 계약 승계 |
| 스트림 | `GET {agent}/api/v1/runs/{id}/events` (SSE data-only) | 이벤트명은 payload `event` 필드 |
| stop / approval | `POST {agent}/api/v1/runs/{id}/stop\|approval` | approval choice: once/session/always/deny |
| SPA 서빙 | `GET /` (U2 자리표시자에 빌드 산출물 연결) | + SECURITY-04 헤더 (business-rules W5) |

**결론: 신규 서버 API 0건.** U4의 서버측 변경은 (a) 정적 서빙에 실제 빌드 산출물 연결, (b) SECURITY-04 응답 헤더 — 둘 다 기존 자리표시자의 완성이며 새 계약이 아니다 (P1/P2/P4).

### WS 이벤트 어휘 (코드에서 추출 — 리듀서 입력)

`job.queued/job.step/job.failed/job.done` · `process.state` · `registry.changed` · `health.changed` · `traffic.request` · `drift.detected/drift.remediated` · `orphan.detected` — 미지 kind는 EventLog에만 표시하고 무시(전방 호환).
