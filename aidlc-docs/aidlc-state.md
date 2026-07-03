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
- **Current Stage**: 개선 — U4 Web UI 전면 재설계 (2026-07-03, plan: web-ui-redesign/plan.md, 답변 Q1=A/Q2=A/Q3=B/Q4=A). Part 2 Generation 완료(S1~S14) — typecheck/lint/vitest 48/E2E 14/build 전부 통과. APPROVED & 커밋됨.
- **Next Stage**: Build and Test (전 유닛)
- **직전 완료**: 토큰 usage hermes-native 전환 — 커밋 15b122e/353067a 반영 완료.
- **Status**: 게이트웨이 프록시의 토큰 자체 집계/context_window/per-turn/ContextBar 전부 제거(Revision 1도 되돌림). TrafficStats는 requests/errors/latency만 유지. 대시보드=agent별 hermes 세션 usage 합(fan-out), 채팅=활성 세션 usage(turn 종료시 refreshSessions 갱신). ruff/mypy/pytest 474 + web typecheck/lint/vitest46 통과, vite build web_dist 갱신. 실기 fan-out 합산 확인. 조사결론: hermes /messages의 per-message token_count는 채우는 설정 없음(항상 null), 세션 단위 usage만 노출.
- **직전 개선 (2026-07-04)**: ~~알려진 회귀(승인됨): rootful 데몬 artifacts 호스트 소유권~~ → **해결됨**. 에이전트 삭제 시 root 소유 샌드박스 아티팩트로 `hermes profile delete`가 exit 1로 실패하던 문제를 lazy 소유권 회수로 해결. `HermesAdapter.reclaim_profile_ownership`(권한 docker 컨테이너 `chown -R`) + `delete_profile` 실패 시 회수 후 1회 재시도(Q1=A). provisioner 제거는 끝내 실패해도 registry 제거해 가시성상 삭제(Q2=B), 재생성 시 `profile-create`가 고아 프로필 자동 reclaim+삭제. plan: `construction/plans/fix-root-owned-profile-removal-plan.md`. ruff/mypy(45)/pytest 482 pass(통합 4 deselected).
- **Key Decisions**: AD-1 profile별 gateway, AD-2 기본 host 네트워크+에이전트별 격리 옵션, AD-3 자체 Web UI, AD-4 Python 3.11+, AD-5 단일 데몬 2-플레인, AD-6 토큰=.env
