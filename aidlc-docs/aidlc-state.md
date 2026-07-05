# AI-DLC State Tracking

## Project Information
- **Project Name**: Caduceus
- **Project Type**: Greenfield
- **Start Date**: 2026-07-02T15:53:51Z
- **Current Stage**: INCEPTION - Requirements Analysis

## Workspace State
- **Existing Code**: No (README.md/LICENSE/assets만 존재 — 소스 코드 없음)
- **Reverse Engineering Needed**: No
- **Workspace Root**: /mnt/f/Workspace/Caduceus
- **Git Branch**: mig-profile-based

## Code Location Rules
- **Application Code**: Workspace root (NEVER in aidlc-docs/)
- **Documentation**: aidlc-docs/ only
- **Structure patterns**: See code-generation.md Critical Rules

## Extension Configuration
| Extension | Enabled | Decided At |
|---|---|---|
| Resiliency Baseline | Yes | Requirements Analysis |
| Security Baseline | Yes | Requirements Analysis |
| Property-Based Testing | Yes (Full enforcement) | Requirements Analysis |

## Execution Plan Summary
- **Stages to Execute**: Application Design (hermes 연구 스파이크 포함), Units Generation, [per-unit] Functional Design / NFR Requirements / NFR Design / Infrastructure Design(조건부) / Code Generation, Build and Test
- **Stages to Skip**: User Stories (단일 페르소나 개발자 도구 — 승인됨)

## Stage Progress
### 🔵 INCEPTION PHASE
- [x] Workspace Detection
- [x] Requirements Analysis (requirements.md v1.0 — APPROVED 2026-07-02)
- [x] User Stories — SKIPPED (approved)
- [x] Workflow Planning (execution-plan.md — APPROVED 2026-07-02)
- [x] Application Design — APPROVED 2026-07-02 (AD-1~AD-7)
- [x] Units Generation — APPROVED 2026-07-02 (INCEPTION PHASE COMPLETE)

## Units
1. U1 Core Foundation (C2 Registry, C6 Hermes Adapter, C7 Service Mgr Adapter) — `caduceus/core/`
2. U2 Daemon (C1 Proxy, C3 Provisioner, C4 Lifecycle, C5 Admin API) — `caduceus/proxy|control|daemon.py`
3. U3 CLI (C8) — `caduceus/cli/`
4. U4 Web UI (C9) — `web/`
Order: U1 → U2 → U3 → U4

### 🟢 CONSTRUCTION PHASE (per-unit loop)
- [x] U1 Functional Design — APPROVED (FD1~FD4, AMD-1/2)
- [x] U1 NFR Requirements — APPROVED (uv/pydantic/ruamel/Hypothesis)
- [x] U1 NFR Design — APPROVED (Infrastructure Design은 U1 스킵)
- [x] U1 Code Generation — APPROVED & committed d5bec4c (105 tests)
- [x] U2 Daemon — APPROVED & committed (proxy/control/daemon.py, 347 tests, ruff/mypy strict)
- [x] U3 CLI — APPROVED & committed a4ad6ae (431 tests; 이후 rootless docker 모델 하드닝 dd23bea/4a42d34, 461 tests)
- [x] U4 Web UI — APPROVED & committed 8641160 (FD/NFR/Code Gen 전체, Playwright E2E 14/14; 승인 게이트 중 수정 4건: ui 블록/토큰 fragment 출력/relay origin/세션 자동 생성)
- [ ] NFR Requirements — EXECUTE per-unit
- [ ] NFR Design — EXECUTE per-unit
- [ ] Infrastructure Design — CONDITIONAL per-unit
- [ ] Code Generation — EXECUTE per-unit
- [ ] Build and Test — EXECUTE

### 🟡 OPERATIONS PHASE
- [ ] Operations — PLACEHOLDER

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: 개선 — per-agent Chat UI를 sessions/chat/stream 으로 마이그레이션 (2026-07-05, 경량 사이클). 선행: hermes fork 패치(PR #58856, `/api/sessions/{id}/chat/stream`에 approval/stop 이식) → 로컬 `/home/beom/.hermes/hermes-agent` editable를 feat 브랜치로 재설치 + 라이브 HTTP 스파이크(실제 _run_agent+approval.py+/v1/runs 왕복) [A]approval/[B]stop 실증. 게이트웨이 3개(test/2/3) 재시작 완료(패치 라이브). **Requirements APPROVED (2026-07-05)** — Q1=A(per-agent만 전환, 룸 runs 유지 직교)/Q2=A(미사용 runs 클라 제거)/Q3=A(전송만, 이미지 후속)/**Q4=B(라이브 thinking 표시 FR-9)**/Q5=A. 스코프: `web/src/`(ChatView·agentApi·client·types·조건부 transcript) — 백엔드/proxy/hermes 무변경. **Code Gen(S1~S10) 완료 + ultracode 적대적 리뷰(5차원×refuter, 15에이전트) 반영**: 전환(runs→sessions/chat/stream 1-콜, named SSE, 네이티브 히스토리, 라이브 thinking) + 리뷰 수정 3건(Stop 레이스 pendingStopRef / 라이브 hex redact / sendApproval .catch) + 커버리지 3건. 검증 **tsc·eslint clean, vitest 110/110(1 기존 flaky), build(web_dist 갱신), E2E 19/19**. docs: `construction/chat-sessions-migration/`(requirements/requirements-questions/plan/code-summary). **Next: Code Gen 승인 게이트(미커밋).**
- **직전 Stage**: 개선 — Observability 전면 재설계 (2026-07-04, 경량 사이클). 사전 스파이크: hermes dashboard 실기동 검증 — analytics는 전부 세션 DB SQL 집계, 원천 per-session 행은 이미 relay 중인 `/api/sessions`가 제공(대시보드 상주 불필요, ~107MB×N 회피). Requirements v1.1(b8e9b31) + Plan S1~S10(018aad5) APPROVED → **Part 2 Generation 완료**. Backend: traffic.py 링 5000+분 롤업(1440, 캡≈0.9MB/agent)+백분위/시리즈/recent_merged, control/observability.py(순수 집계+fan-out 격리), `GET /api/observability/usage|gateway`. Frontend: `/observability`(+`/:agent`) 전용 메뉴 — Total(KPI 스트립 7타일+스파크라인+델타 / Activity / Token 4-스택 / Agent 랭킹 / Model 도넛+Source 바) + Agent(세션 테이블 행 클릭 **narrow-down** 클라 재계산; latency/errors는 agent 한정 명시) + Live 탭(15m 10s 버킷+recent), persistent/live·since 뱃지 상시, viz-4 토큰 신설(팔레트 6-체크 재검증). E2E가 실버그 1건 적발(`session_rows` 비수치 ts 500 → `_instant` 코어스+회귀 테스트). 검증: ruff/mypy(44)/pytest **573** · web tsc/eslint/vitest **100**/build(web_dist 갱신)/E2E **15/15** · 시각 스크린샷 검증(다크, empty/fleet/agent/narrowed/live). **APPROVED & 커밋됨 (2026-07-04)** — docs: `construction/observability-redesign/`(code-summary.md 포함).
- **직전 Stage**: 개선 — Orphan gateway 프로세스 방지 (2026-07-04, 경량 사이클). 문제: agent remove 후에도 `orphan.detected {resource:profile,name:cad-test2}` 알럿 반복 → 진단: remove 이후 gateway 프로세스(PID 69873)가 살아 `<profile>/cron` 하트비트로 프로파일 디렉토리를 재생성, 리컨사일러 디렉토리 스캔이 매 사이클 orphan 판정. 원인: `remove_agent.gateway_stop()`이 `manager.is_managed`(in-memory `_managed`)일 때만 종료 → 데몬 재시작/매니저 우회 gateway 못 죽임. 답변 Q1=A(엄격: /proc start_time==pidfile start_time AND cmdline 에 프로파일명+"gateway")/Q2=A(reap 실패 시 경고 후 remove 계속)/Q3=A(리컨사일러 자동 reap 없음)+orphan 알럿 수동 해소 UI 버튼. 해결: 신규 effect port `ProcessSignaller`(RealProcessSignaller,/proc·os.kill; FakeSignaller/FakeProc), `HermesAdapter.read_gateway_pidinfo`+`reap_gateway`(SIGTERM→grace→SIGKILL,신원검증), `remove.gateway_stop` belt-and-suspenders reap + 신규 `resolve_orphan(resource,name)` Job(orphan-only 가드), `POST /api/alerts/orphan/resolve`, web `resolveOrphan`+대시보드 "clean up" 버튼(`alert-dismiss` 낙관적 제거). 검증: ruff/mypy(43)/pytest **521**(499+22) + web tsc/eslint/vitest **86**/build(web_dist 갱신)/E2E **14/14**. **APPROVED & 커밋 대기** — docs: `construction/orphan-gateway-reap/`(plan.md, code-summary.md 포함).
- **직전 Stage**: 개선 — 채팅 스트리밍 렌더 순서 (2026-07-04, 경량 사이클). 문제: 라이브 스트리밍 턴(`ChatView.tsx` `LiveTurnBlock`)이 이벤트를 평면 버킷(`assistantText` 단일 문자열 + `tools[]`)으로 축적·고정 순서(tools 전부 위 → content 전부 아래)로 렌더 → `content→tool→content→tool` 교차 순서 소실(턴 종료 재-하이드레이트 시 정상 복구). 수정: 라이브 턴을 이벤트 순서 세그먼트(text|tool) 리스트로 전환 — 순수·total 리듀서 `web/src/lib/liveTurn.ts`(appendText coalesce/startTool/completeTool/fallbackText) 분리 + PBT, `LiveTurnBlock` 순서대로 렌더(커서는 마지막 세그먼트가 텍스트일 때만). 범위 web/ 한정, 백엔드/transcript 무변경. Requirements+Plan(S1~S5) APPROVED → Part 2 Generation 완료 — tsc/eslint/vitest **85**(신규 liveTurn 12)/E2E **14**/build 전부 통과, `caduceus/web_dist` 갱신. **APPROVED & 커밋됨 0b4e9e8 (2026-07-04)**. docs: `construction/chat-streaming-order/`(code-summary.md 포함).
- **직전 Stage**: 개선 — 대시보드 REQUESTS/ERRORS 를 "유의미한 LLM 트래픽"으로 집계 (2026-07-04, 경량 사이클). 배경: OpenAI-호환 클라이언트가 시작 시 `/v1/props`·`/v1/models/{id}` 능력 프로브를 보내는데 업스트림(llama.cpp) 미제공으로 404 → 프록시가 모든 요청을 무차별 집계해 대시보드 Requests 부풀고 프로브 404가 Errors로 잡힘. 방향(사용자): props 특례 폐기, **요청을 추론 vs 메타/프로브로 분류**. Requests=실제 LLM 호출만, Errors=추론 실패만(⊆Requests). 결정 Q1=A(표준 추론세트: chat/completions·completions·embeddings·responses). 변경: `caduceus/proxy/service.py`만 — `_INFERENCE_PATHS`+`is_inference_path()`, `handle→relay/_fail→_record` path 스레딩, `_record` 진입에서 비추론이면 조기 return(requests/errors/recent/`traffic.request` 이벤트 전부 생략). `TrafficStats`/api/web 무변경(web_dist 재빌드 불필요), PBT 불변식 유지. 테스트 3건 신설. ruff·mypy(43)·pytest **499**(496+3). **APPROVED & 커밋됨 f0e8868 (2026-07-04)**. docs: `construction/props-404-not-error/requirements.md`.
- **직전 Stage**: 개선 — 브라우저 로컬 접근 opt-in (`allow_private_urls`) (2026-07-03, 경량 사이클). per-agent opt-in(기본 off), AgentSpec.allow_private_urls / managed_config `security.allow_private_urls` 렌더 / CLI `--allow-private-urls` / web(생성폼·detail) + 생성 후 편집 `GET/PUT /api/agents/{name}/allow-private-urls`·SettingsTab 토글. **APPROVED & 커밋됨 1ce9b82 (2026-07-03)**. docs: `construction/browser-private-urls/`.
- **직전 Stage**: 개선 — 에이전트 터미널 host 네트워크 (gateway `TERMINAL_*` env 주입). caduceus가 gateway spawn 시 spec 파생 `TERMINAL_*` env를 주입해 `default` 샌드박스가 `network_mode`로 뜨게 함(hermes terminal_tool은 env만 읽음). render.terminal_env / gateway_env / process_manager env 스레딩(재시작 안전) / 3개 호출부. **APPROVED & 커밋됨 0161e4c (2026-07-03)**. docs: `construction/terminal-host-network/`.
- **직전 Stage**: 개선 — 채팅 transcript 렌더링 (2026-07-04 시작). Requirements APPROVED (Q1=A 접힘 카드 / Q2=A 스마트 포매팅 / Q3=A 라이브 통일). Plan(S1~S7) APPROVED(계획 커밋 bf3fc2f) → Part 2 Generation 완료 — tsc/eslint/vitest 73/E2E 14/build 전부 통과. **APPROVED & 커밋됨 (2026-07-04)**. docs: `construction/chat-transcript-rendering/`.
- **직전 Stage**: 개선 — 알림(드리프트·orphan) 토스트 UX. Requirements v1.0 APPROVED (Q1~Q4=A) → Plan(S1~S10) APPROVED(계획 커밋 d040c5f) → Part 2 Generation 완료 — ruff/mypy/pytest 488 + tsc/eslint/vitest 62/E2E 14/build 전부 통과, web_dist 갱신. **APPROVED & 커밋됨 (2026-07-04)**. docs: `construction/alert-ux-improvements/` (code-summary.md 포함). 그 직전: 채팅 UX 개선(지연 렌더/자동 스크롤 뱃지/포커스/입력창) — APPROVED & 커밋됨, docs: `construction/chat-ux-improvements/`.
- **Next Stage**: Build and Test (전 유닛)
- **직전 완료**: 토큰 usage hermes-native 전환 — 커밋 15b122e/353067a 반영 완료.
- **Status**: 게이트웨이 프록시의 토큰 자체 집계/context_window/per-turn/ContextBar 전부 제거(Revision 1도 되돌림). TrafficStats는 requests/errors/latency만 유지. 대시보드=agent별 hermes 세션 usage 합(fan-out), 채팅=활성 세션 usage(turn 종료시 refreshSessions 갱신). ruff/mypy/pytest 474 + web typecheck/lint/vitest46 통과, vite build web_dist 갱신. 실기 fan-out 합산 확인. 조사결론: hermes /messages의 per-message token_count는 채우는 설정 없음(항상 null), 세션 단위 usage만 노출.
- **직전 개선 (2026-07-04)**: ~~알려진 회귀(승인됨): rootful 데몬 artifacts 호스트 소유권~~ → **해결됨**. 에이전트 삭제 시 root 소유 샌드박스 아티팩트로 `hermes profile delete`가 exit 1로 실패하던 문제를 lazy 소유권 회수로 해결. `HermesAdapter.reclaim_profile_ownership`(권한 docker 컨테이너 `chown -R`) + `delete_profile` 실패 시 회수 후 1회 재시도(Q1=A). provisioner 제거는 끝내 실패해도 registry 제거해 가시성상 삭제(Q2=B), 재생성 시 `profile-create`가 고아 프로필 자동 reclaim+삭제. plan: `construction/plans/fix-root-owned-profile-removal-plan.md`. ruff/mypy(45)/pytest 482 pass(통합 4 deselected).
- **Key Decisions**: AD-1 profile별 gateway, AD-2 기본 host 네트워크+에이전트별 격리 옵션, AD-3 자체 Web UI, AD-4 Python 3.11+, AD-5 단일 데몬 2-플레인, AD-6 토큰=.env
