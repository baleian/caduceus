# U4 Web UI — Frontend Components

**Date**: 2026-07-03
**전제**: domain-entities.md(라우트/상태), business-logic-model.md(플로우), business-rules.md(W1~W9)
**표기**: props/state는 개념 시그니처 — 구체 타입 문법은 스택 확정(NFR) 후 코드 생성에서.

## 1. 컴포넌트 계층

```text
App
├── AuthGate                          # Q1=A — 토큰 부트스트랩 (§2.1)
└── Shell
    ├── NavBar                        # 4축 링크 + ConnectionBadge + AgentQuickStatus
    ├── ToastArea                     # 전역 알림 (job 완료/실패, drift 경고)
    └── <Router>
        ├── AgentsPage
        │   ├── AgentTable → AgentRow*            # 실시간 상태 배지
        │   └── CreateAgentPanel
        │       ├── AgentForm                     # 단일 폼 + 고급 접기 (Q3=A)
        │       └── JobProgressCard               # 생성/삭제 잡 공용
        ├── AgentDetailPage (tabs)
        │   ├── OverviewTab: StatusCard, ActionBar(start/stop/delete/dashboard링크)
        │   ├── LogsTab: LogViewer                # 스냅샷+follow (Q8=A)
        │   └── SettingsTab
        │       ├── SoulEditor                    # 멀티라인 에디터
        │       ├── SkillsList → SkillToggle*
        │       ├── ToolsetsForm (+RawView)       # 라운드트립 무손실 (PU4-5)
        │       ├── ApprovalsForm                 # mode 셀렉트
        │       ├── TokenRotateButton
        │       └── RestartBanner                 # S6 — 편집 후 게시
        ├── ChatPage
        │   ├── AgentPicker                       # /chat — 에이전트 선택
        │   └── ChatView (/chat/{name})
        │       ├── SessionSidebar → SessionItem* # 목록/새 세션/이름 변경/삭제 (Q5=B)
        │       ├── Transcript
        │       │   ├── UserMessage* / AssistantMessage*
        │       │   ├── ReasoningBlock*           # 접기 (기본 접힘)
        │       │   ├── ToolCallBlock*            # ⚙ 이름+요약, 결과 접기, ✗ 실패 상세
        │       │   └── SystemNote*               # 중단/실패/절단 안내
        │       ├── ApprovalCard                  # once/session/always/deny
        │       └── Composer (+StopButton)        # runState 연동
        ├── GatewayPage
        │   ├── UpstreamForm                      # base_url/api_key_env/default_model
        │   ├── TrafficSummaryTable               # 에이전트별, WS 실시간
        │   └── RecentRequestsList                # 링버퍼 ≤100, 메타만
        └── SystemPage
            ├── DeepStatusPanel                   # GET /api/status
            ├── JobsTable → JobProgressCard
            └── EventLog                          # drift/orphan/미지 이벤트
공용: ConfirmModal(이름 타이핑 변형 포함 — W1), CollapsibleSection, StatusBadge
```

## 2. 컴포넌트 명세 (props / state / API 연동)

### 2.1 AuthGate
- state: `authStatus(unknown|valid|invalid|absent)`, `tokenInput`
- 로직: fragment 파싱→저장→제거 → `GET /api/status` 검증 (business-logic §1)
- API: `GET /api/status` | 실패 UX: W3

### 2.2 NavBar / ConnectionBadge
- props: `connection(ConnectionState)`, `driftCount`
- WS 상태 3색 배지(connected/reconnecting/down) + 마지막 동기 시각 툴팁

### 2.3 AgentTable / AgentRow
- props(row): `agent{name, status, health, image, network, createdAt}` — 서버 합성값 그대로 (W9)
- API: 초기 `GET /api/agents`, 이후 WS 리듀서 반영. 행 클릭 → 상세

### 2.4 AgentForm (생성)
- state: `spec{name, image?, network?, cpu?, memory?, persona?}`, `errors byField`, `submitting`
- 검증(W4): name 정규식 즉시 검증, 나머지 옵션은 제한 목록. 서버 422 → 필드 오류 병합
- API: `POST /api/agents` → job_id를 JobProgressCard로 전달

### 2.5 JobProgressCard
- props: `jobId`; state: `steps[{name, state(pending|running|ok|failed)}]`, `error?`
- 원천: WS `job.*` (두절 시 `GET /api/jobs/{id}` 폴링 폴백 — S-U4-1.6)
- 실패 시: 실패 단계 강조 + redact된 사유 + 정리 안내 문구

### 2.6 ActionBar
- props: `agent`, `busy(op별)`
- start/stop: 202 접수 → busy → WS 전이로 해제 (30s 타임아웃 시 재조회 — S-U4-2)
- delete: ConfirmModal(name 타이핑, 워크스페이스 보존 문구) → `X-Confirm` 헤더

### 2.7 LogViewer
- props: `agentName`; state: `lines[]`, `follow(bool)`, `lastTail`
- follow on: 1~2s 폴링 + tail dedup(PU4-6), gap 표시 라인. 화면 이탈 시 중지 (W8)
- API: `GET /api/agents/{name}/logs?last=N`

### 2.8 SoulEditor / SkillsList / ToolsetsForm / ApprovalsForm
- SoulEditor: state `content, dirty`; 512KB 상한(W4); 저장 → PUT → RestartBanner 게시
- SkillToggle: props `skill{name, enabled}`; 낙관 토글 → 실패 시 원복+토스트
- ToolsetsForm: state `parsed(아는 필드), unknownRest(원본 보존)`; 저장 = merge(parsed→원본) — PU4-5; RawView는 읽기 전용 표시 + "raw로 편집" 전환
- ApprovalsForm: mode 단일 셀렉트 (서버 어휘 그대로)
- 공통 API: 각 GET/PUT 엔드포인트 (domain-entities §4)

### 2.9 SessionSidebar / SessionItem
- state: `sessions[]`, `renamingId?`
- 새 세션 `POST api/sessions` → 즉시 선택 전환. 이름 변경 `PATCH`, 삭제 `DELETE`(경량 확인 — W1)
- API 전부 `/agents/{name}/api/api/sessions*` 리버스 프록시 경유

### 2.10 Transcript + ChatView 코어
- ChatView state: `activeSessionId`, `transcript[]`, `runState`, `activeRunId?`, `pendingApproval?`
- 세션 진입/전환/브라우저 복귀: **항상 `GET .../messages` 재하이드레이션 후 렌더 — 로컬 잔존분 폐기 (W7 단일 원천)**
- 제출(idle에서만): messages 재조회→history 구성→`POST v1/runs`→SSE 구독 (business-logic S-U4-4)
- SSE 이벤트→블록 매핑은 business-logic §3 표 그대로. 모든 텍스트는 redact 게이트 통과 (PU4-7)
- StopButton: streaming에서만 표시, 클릭 1회 후 비활성(상태 기계가 중복 차단 — PU4-2)
- streaming 중 라우트 이탈: 확인 다이얼로그 (run은 서버에서 계속 — 재진입 시 원천에서 복원)

### 2.11 ApprovalCard
- props: `request{tool, summary}`; 버튼 4개(once/session/always/deny) → `POST .../approval`
- stopping 상태 도착 시 자동 deny (상태 기계 액션 — U3 동형)

### 2.12 UpstreamForm / TrafficSummaryTable / RecentRequestsList
- UpstreamForm: state `{base_url, api_key_env, default_model}, dirty`; 저장 → `PUT /api/gateway/upstream` → 적용 결과(핫스왑) 즉시 재조회 표시. api_key 원문 필드 없음 (W2)
- TrafficSummaryTable: props `summary byAgent` — WS `traffic.request` 증분 (PU4-3 멱등)
- RecentRequestsList: 링버퍼 ≤100, 항목 = {ts, agent, model, tokens, latency, status} 메타만

### 2.13 DeepStatusPanel / JobsTable / EventLog
- DeepStatusPanel: `GET /api/status` 스냅샷 + 새로고침. 항목별 ✓/✗
- JobsTable: `GET /api/jobs` + WS — 최근순, 행 확장 시 JobProgressCard
- EventLog: 바운디드 버퍼(예: 500) — drift/orphan/미지 kind 표시, 지우기 버튼(클라이언트 전용)

## 3. 폼 검증 규칙 요약 (W4 구체화)

| 폼 | 필드 | 규칙 |
|---|---|---|
| AgentForm | name | `^[a-z0-9][a-z0-9_-]{0,63}$`, 필수, 기존 이름 중복 시 서버 오류 표시 |
| | image | 비어있으면 서버 기본값 사용 안내 표시 |
| | network | host/bridge/none 셀렉트만 |
| | cpu/memory | 양수 형식 선검증 (서버 스키마 권위) |
| | persona | 512KB 상한 |
| SoulEditor | content | 512KB 상한, 빈 저장은 확인 요구 |
| UpstreamForm | base_url | http(s) URL 형식, api_key_env는 env 변수명 패턴 `^[A-Z_][A-Z0-9_]*$` |
| ConfirmModal | confirmText | 대상 이름과 완전 일치 시에만 활성 |
| Composer | input | 비공백 필수, runState=idle 게이트 |

## 4. 컴포넌트 ↔ 요구사항 추적

| 요구 | 컴포넌트 |
|---|---|
| F9/F1 생성·중지·재실행·삭제 | AgentForm, JobProgressCard, ActionBar |
| F7 에이전트 설정 | SettingsTab 일체 |
| F6 스트리밍 채팅·재개·stop·approval | ChatView, Transcript, StopButton, ApprovalCard, SessionSidebar |
| F4 게이트웨이 설정·관찰 | GatewayPage 일체 |
| N5 상태 체크·관측 | StatusBadge, ConnectionBadge, SystemPage, LogViewer |
| F8 dashboard | ActionBar 외부 링크 |
| F11/N3 loopback·보안 | AuthGate, W5 헤더(서버측), 상대 경로 호출 |
