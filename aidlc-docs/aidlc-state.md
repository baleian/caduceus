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
- **Current Stage**: 개선 — 대시보드 REQUESTS/ERRORS 를 "유의미한 LLM 트래픽"으로 집계 (2026-07-04, 경량 사이클). 배경: OpenAI-호환 클라이언트가 시작 시 `/v1/props`·`/v1/models/{id}` 능력 프로브를 보내는데 업스트림(llama.cpp) 미제공으로 404 → 프록시가 모든 요청을 무차별 집계해 대시보드 Requests 부풀고 프로브 404가 Errors로 잡힘. 방향(사용자): props 특례 폐기, **요청을 추론 vs 메타/프로브로 분류**. Requests=실제 LLM 호출만, Errors=추론 실패만(⊆Requests). 결정 Q1=A(표준 추론세트: chat/completions·completions·embeddings·responses). 변경: `caduceus/proxy/service.py`만 — `_INFERENCE_PATHS`+`is_inference_path()`, `handle→relay/_fail→_record` path 스레딩, `_record` 진입에서 비추론이면 조기 return(requests/errors/recent/`traffic.request` 이벤트 전부 생략). `TrafficStats`/api/web 무변경(web_dist 재빌드 불필요), PBT 불변식 유지. 테스트 3건 신설. ruff·mypy(43)·pytest **499**(496+3). **코드 승인 대기(승인 시 커밋)**. docs: `construction/props-404-not-error/requirements.md`.
- **직전 Stage**: 개선 — 브라우저 로컬 접근 opt-in (`allow_private_urls`) (2026-07-03, 경량 사이클). per-agent opt-in(기본 off), AgentSpec.allow_private_urls / managed_config `security.allow_private_urls` 렌더 / CLI `--allow-private-urls` / web(생성폼·detail) + 생성 후 편집 `GET/PUT /api/agents/{name}/allow-private-urls`·SettingsTab 토글. **APPROVED & 커밋됨 1ce9b82 (2026-07-03)**. docs: `construction/browser-private-urls/`.
- **직전 Stage**: 개선 — 에이전트 터미널 host 네트워크 (gateway `TERMINAL_*` env 주입). caduceus가 gateway spawn 시 spec 파생 `TERMINAL_*` env를 주입해 `default` 샌드박스가 `network_mode`로 뜨게 함(hermes terminal_tool은 env만 읽음). render.terminal_env / gateway_env / process_manager env 스레딩(재시작 안전) / 3개 호출부. **APPROVED & 커밋됨 0161e4c (2026-07-03)**. docs: `construction/terminal-host-network/`.
- **직전 Stage**: 개선 — 채팅 transcript 렌더링 (2026-07-04 시작). Requirements APPROVED (Q1=A 접힘 카드 / Q2=A 스마트 포매팅 / Q3=A 라이브 통일). Plan(S1~S7) APPROVED(계획 커밋 bf3fc2f) → Part 2 Generation 완료 — tsc/eslint/vitest 73/E2E 14/build 전부 통과. **APPROVED & 커밋됨 (2026-07-04)**. docs: `construction/chat-transcript-rendering/`.
- **직전 Stage**: 개선 — 알림(드리프트·orphan) 토스트 UX. Requirements v1.0 APPROVED (Q1~Q4=A) → Plan(S1~S10) APPROVED(계획 커밋 d040c5f) → Part 2 Generation 완료 — ruff/mypy/pytest 488 + tsc/eslint/vitest 62/E2E 14/build 전부 통과, web_dist 갱신. **APPROVED & 커밋됨 (2026-07-04)**. docs: `construction/alert-ux-improvements/` (code-summary.md 포함). 그 직전: 채팅 UX 개선(지연 렌더/자동 스크롤 뱃지/포커스/입력창) — APPROVED & 커밋됨, docs: `construction/chat-ux-improvements/`.
- **Next Stage**: Build and Test (전 유닛)
- **직전 완료**: 토큰 usage hermes-native 전환 — 커밋 15b122e/353067a 반영 완료.
- **Status**: 게이트웨이 프록시의 토큰 자체 집계/context_window/per-turn/ContextBar 전부 제거(Revision 1도 되돌림). TrafficStats는 requests/errors/latency만 유지. 대시보드=agent별 hermes 세션 usage 합(fan-out), 채팅=활성 세션 usage(turn 종료시 refreshSessions 갱신). ruff/mypy/pytest 474 + web typecheck/lint/vitest46 통과, vite build web_dist 갱신. 실기 fan-out 합산 확인. 조사결론: hermes /messages의 per-message token_count는 채우는 설정 없음(항상 null), 세션 단위 usage만 노출.
- **직전 개선 (2026-07-04)**: ~~알려진 회귀(승인됨): rootful 데몬 artifacts 호스트 소유권~~ → **해결됨**. 에이전트 삭제 시 root 소유 샌드박스 아티팩트로 `hermes profile delete`가 exit 1로 실패하던 문제를 lazy 소유권 회수로 해결. `HermesAdapter.reclaim_profile_ownership`(권한 docker 컨테이너 `chown -R`) + `delete_profile` 실패 시 회수 후 1회 재시도(Q1=A). provisioner 제거는 끝내 실패해도 registry 제거해 가시성상 삭제(Q2=B), 재생성 시 `profile-create`가 고아 프로필 자동 reclaim+삭제. plan: `construction/plans/fix-root-owned-profile-removal-plan.md`. ruff/mypy(45)/pytest 482 pass(통합 4 deselected).
- **Key Decisions**: AD-1 profile별 gateway, AD-2 기본 host 네트워크+에이전트별 격리 옵션, AD-3 자체 Web UI, AD-4 Python 3.11+, AD-5 단일 데몬 2-플레인, AD-6 토큰=.env
