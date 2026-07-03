# U4 Web UI — Business Logic Model

**Date**: 2026-07-03
**전제**: domain-entities.md (라우트/상태/계약 매핑), U3 chat 실 계약 승계

## 1. 인증 부트스트랩 (Q1=A)

```text
앱 로드
├─ URL fragment에 #token=... 존재 → 저장(localStorage) → history.replaceState로 fragment 즉시 제거
├─ localStorage에 토큰 존재 → GET /api/status로 검증
│   ├─ 200 → 정상 진입 (초기 REST 스냅샷 + WS 연결)
│   └─ 401 → 토큰 무효 — 토큰 입력 화면 (~/.caduceus/admin.token 경로 안내)
└─ 토큰 없음 → 토큰 입력 화면
```

- `caduceus ui`가 fragment 포함 URL을 열어주는 것이 정상 경로 (U3 `bootstrap.py` ui 커맨드에 fragment 부착 — **U3 1줄 변경**, Code Generation에서 반영)
- fragment는 서버에 전송되지 않고 저장 직후 주소창에서 제거 — 로그·Referer·북마크 비잔존

## 2. 페이지 플로우

### S-U4-1. 에이전트 생성 (Q3=A)

1. `/agents`의 "새 에이전트" → 단일 폼 (name 필수, 고급 접기: image/network/cpu/memory/persona 초기값)
2. 클라이언트 검증(business-rules W4) 통과 시 `POST /api/agents` → 202 `{job_id}`
3. 같은 화면에서 잡 카드 렌더: WS `job.step` 이벤트로 단계별 ✓/✗/스피너 (U2 create 9단계)
4. `job.done` → 목록에 새 에이전트 반영(이미 `registry.changed`/`process.state`로 도착) + 성공 토스트
5. `job.failed` → 실패 단계·redact된 사유 표시 + "레지스트리에 failed 상태로 남음 — 삭제로 정리" 안내 (U2 S1 계약: 자동 롤백 없음)
6. WS 두절 중이면 `GET /api/jobs/{id}` 1~2s 폴링 폴백 (동일 스냅샷 스키마)

### S-U4-2. 라이프사이클 조작

- start/stop 버튼 → `POST .../start|stop` → 202 즉시 "요청 접수" 표시(버튼 일시 비활성) → 실제 전이는 WS `process.state`/`health.changed`가 도착해야 반영. 30s 내 전이 이벤트 부재 시 REST 재조회 + 경고 배지 (사전 결정: 즉시 접수 계약)
- 삭제 → ConfirmModal(이름 타이핑 일치 — W1) → `DELETE` + `X-Confirm` → 202 잡 카드 (S-U4-1의 4단계 remove 파이프라인 표시, 워크스페이스 보존 문구)

### S-U4-3. 설정 편집 (Q4=A, S6 계약)

1. settings 탭 진입 시 4개 GET 병렬 로드 (soul/skills/toolsets/approvals)
2. 편집 → PUT 성공(204) → "게이트웨이 재시작 필요" 배너 게시 + [지금 재시작] 버튼(stop→start 순차 호출)
3. skills 토글은 항목별 즉시 PUT (실패 시 토글 원복 + 토스트)
4. toolsets/approvals: 구조화 폼이 원천 스키마를 보수적으로 다룸 — 알 수 없는 키는 raw 보기에 그대로 보존, 폼은 아는 필드만 수정 (라운드트립 무손실 — PU4-5)
5. token rotate: 확인 다이얼로그(간단 y/N 수준) → 204 → "재시작 필요" 배너 (rotate는 .env 재주입 — 원문 비표시 W2)

### S-U4-4. Chat (Q5=B + 단일 원천 규칙)

```text
/chat/{name} 진입
1. GET api/sessions → 사이드바 (최근순). 없으면 빈 상태 + [새 세션]
2. 세션 선택(또는 자동: 최근 세션) →
   GET api/sessions/{id}/messages   ← 단일 원천 하이드레이션 (로컬 잔존 transcript 폐기)
   → transcript 재구성 렌더 (user/assistant/reasoning/tool 구분)
3. Composer 제출 (runState=idle에서만):
   a. GET .../messages 재조회 → conversation_history 구성
   b. POST v1/runs {session_id, input, conversation_history} → run_id
   c. GET v1/runs/{run_id}/events SSE 구독 → 이벤트 렌더 (아래 §3)
4. Stop 버튼(streaming 중 표시) → POST v1/runs/{run_id}/stop (turn당 1회 — 상태 기계 보장)
5. approval.request → 인라인 카드 [once/session/always/deny] → POST .../approval
6. run.completed|failed|cancelled → idle 복귀. 실패한 tool이 있으면
   GET .../messages로 실패 상세 보강 (U3 tool_failure_summary 동일 규칙 — 원천 동일)
세션 관리(Q5=B): [새 세션]=POST api/sessions, 이름 변경=PATCH, 삭제=DELETE(ConfirmModal — W1 경량형)
```

- SSE 절단(네트워크/서버) 시: transcript에 system-note("스트림 끊김") + idle 복귀 + 세션 보존 — 재진입 시 어차피 서버 원천으로 재하이드레이션되므로 유실 없음 (U3 절단 시 세션 보존 복귀와 동일 철학)
- 다른 세션/페이지로 이탈 시 진행 중 run은 **중단하지 않는다** (서버에서 계속 실행·기록됨 — 단일 원천이므로 재진입 시 결과 확인 가능). streaming 중 이탈 시도에는 확인 다이얼로그
- multi-turn 동시 실행 금지: runState≠idle이면 Composer 비활성

## 3. SSE 이벤트 → 렌더 매핑 (U3 어휘 승계)

| payload.event | 렌더 |
|---|---|
| `message.delta` | assistant 말풍선에 델타 append (redact 통과 — W2) |
| `reasoning.available` | reasoning 접기 블록 (기본 접힘, UiPrefs) |
| `tool.started` | tool 블록 생성: ⚙ 이름 + 인자 1줄 요약 (펼치면 전체) |
| `tool.completed` | ✓/✗ 마크 + 결과 접기 (실패 상세는 turn 종료 후 messages 보강) |
| `approval.request` | 상태 기계 `approval_request` → 인라인 승인 카드 |
| `run.completed` | `stream_end` → idle |
| `run.failed` | system-note(redact된 사유) + `stream_end` → idle |
| `run.cancelled` | system-note("중단됨") + `stream_end` → idle |
| (미지 이벤트) | 무시 (전방 호환 — PU4-2 vocabulary 외 no-op) |

## 4. WS 이벤트 리듀서 + 재연결 (Q6=A)

```text
연결: WS /api/events?token=<admin> (연결 시 리플레이 500 → 실시간)
리듀서(순수 함수): (state, CoreEvent) → state
  job.*            → JobsState.byId[job_id] 갱신 (없으면 생성)
  process.state    → AgentsState.byName[agent].status 부분 갱신
  registry.changed → AgentsState 무효화 마크 → GET /api/agents 재조회 (디바운스)
  health.changed   → AgentsState.byName[agent].health 갱신
  traffic.request  → GatewayState 요약 카운터 증분 + recentRequests push (≤100 유지)
  drift.* / orphan.* → SystemState.driftAlerts + 전역 경고 토스트
  미지 kind        → SystemState.eventLog에만 기록
재연결: 지수 백오프(1s→2s→…≤30s) + 재연결 성공 시 REST 전량 재조회(agents/jobs/gateway/status)
        후 리플레이 적용 — 리듀서는 멱등이어야 함 (PU4-3)
두절 동안: ConnectionState=reconnecting 배지, 잡 카드는 폴링 폴백 (S-U4-1.6)
```

## 5. 로그 follow (Q8=A)

- 스냅샷 `GET logs?last=200` → follow 토글 시 1~2s 주기 재조회 → **U3 `tail.py` 중첩 dedup 규칙의 TS 포팅**: 직전 꼬리와 신규 응답의 최장 중첩으로 신규 라인만 append, 회전/gap은 gap 표시 라인 삽입 (침묵 유실 금지 — PU4-6)
- 탭 이탈/비표시 시 폴링 중지 (자원 규칙)

## 6. Testable Properties (PBT-01 — 순수 함수 대상, 프레임워크는 NFR에서)

| ID | 대상 (순수 함수) | 속성 |
|---|---|---|
| **PU4-1** | SSE 파서 (TS) | 임의 이벤트 열 직렬화→임의 청크 분할→파싱 = 원본 복원 (라운드트립). garbage/절단 주입 시에도 예외 없이 유효 이벤트만 산출 (PU3-3 동형) |
| **PU4-2** | chat run 상태 기계 | 임의 이벤트 열에 대해: stop 액션은 turn당 ≤1, idle 외 상태에서 Composer 제출 불가, 미지 (상태,이벤트) 쌍은 no-op, 모든 열은 결국 idle 도달 가능 (PU3-5 동형) |
| **PU4-3** | WS 이벤트 리듀서 | 멱등(같은 이벤트 재적용 = 불변), 리플레이+실시간 중복 구간이 있어도 REST 스냅샷과 수렴, recentRequests 길이 ≤100 불변 |
| **PU4-4** | 히스토리→transcript 매핑 | 전 함수(total): 임의 role/content 조합(미지 role 포함)에 예외 없음, 알려진 role은 무손실 매핑, 항목 수 보존(필터되는 항목은 명세된 종류만) |
| **PU4-5** | toolsets/approvals 폼 라운드트립 | parse(render(config)) = config — 폼이 모르는 키 포함 임의 구성에서 무손실 |
| **PU4-6** | 로그 tail dedup | 연속 스냅샷 열에 대해 무중복·무유실(gap은 명시 표시) — U3 PU3-6 동형 |
| **PU4-7** | redact 게이트 | 토큰형 문자열을 포함한 임의 입력이 렌더 경로 통과 후 원문 비포함 (W2의 속성화) |
