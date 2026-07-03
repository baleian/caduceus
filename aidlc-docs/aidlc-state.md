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
- [ ] U4 Web UI — FD APPROVED (2026-07-03); NFR Requirements IN PROGRESS
- [ ] NFR Requirements — EXECUTE per-unit
- [ ] NFR Design — EXECUTE per-unit
- [ ] Infrastructure Design — CONDITIONAL per-unit
- [ ] Code Generation — EXECUTE per-unit
- [ ] Build and Test — EXECUTE

### 🟡 OPERATIONS PHASE
- [ ] Operations — PLACEHOLDER

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: U4 Web UI — Code Generation 완료 (승인 게이트)
- **Next Stage**: Build and Test (전 유닛)
- **Status**: U4 14단계 전부 완료 — SPA 45파일, 서버측 5파일 수정(E2E 발견 U2 결함 2건 포함), 검증 Python 472 / Web 46 / Playwright E2E 14/14, 번들 85.5KB gzip. code-summary.md 편차 5건 기록. 승인 대기
- **Key Decisions**: AD-1 profile별 gateway, AD-2 기본 host 네트워크+에이전트별 격리 옵션, AD-3 자체 Web UI, AD-4 Python 3.11+, AD-5 단일 데몬 2-플레인, AD-6 토큰=.env
