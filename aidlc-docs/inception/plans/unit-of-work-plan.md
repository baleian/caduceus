# Unit of Work Plan — Caduceus

**Date**: 2026-07-02
**Prerequisite**: application-design.md v1.0 (approved, AD-1~AD-7)

## Plan Steps (Part 2에서 실행)

- [x] Step A: `unit-of-work.md` — 유닛 정의·책임·코드 조직 전략 (greenfield)
- [x] Step B: `unit-of-work-dependency.md` — 유닛 의존 매트릭스·구현 순서
- [x] Step C: `unit-of-work-story-map.md` — 요구사항(F/N)→유닛 매핑 (User Stories 생략 프로젝트이므로 스토리 대신 요구사항 ID 매핑)
- [x] Step D: 유닛 경계·의존성 검증 + 전체 요구사항 배정 완전성 확인 (F 11/11, N 10/10 배정)

## 사전 판단 (질문 생략 근거)

- **Team Alignment**: 단일 개발자 오픈소스 프로젝트(개인 로컬 도구) — 팀 경계 질문 생략
- **Business Domain**: 도메인 경계는 AD-5의 2-플레인(proxy/control) + 클라이언트(CLI/UI)로 이미 확정 — 재질문 생략
- **배포 모델**: 단일 데몬 + 단일 패키지 설치(AD-4/AD-5, N8) 확정 — 유닛은 배포 단위가 아닌 **개발 작업 단위**

---

# 분해 질문

## Question 1: 유닛 granularity (구성 단위 수)
컴포넌트 C1~C9를 몇 개의 작업 유닛으로 묶을까요? 유닛마다 Construction 루프(Functional Design→NFR→Code Gen, 각 승인 게이트)가 돌므로 개수는 진행 리듬을 결정합니다.

A) **4 유닛** (권장) — U1 Core Foundation(C2 Registry + C6 Hermes Adapter + C7 Service Mgr Adapter), U2 Daemon(C1 Proxy + C3 Provisioner + C4 Lifecycle + C5 Admin API), U3 CLI(C8), U4 Web UI(C9). 기반→데몬→클라이언트 순의 자연스러운 적층, 유닛당 응집도 높음

B) **3 유닛** — U1 Daemon 전체(C1~C7), U2 CLI, U3 Web UI. 게이트 수 최소화, 대신 U1이 큼(설계·리뷰 부담 집중)

C) **5 유닛** — A에서 Proxy Plane(C1)을 별도 유닛으로 분리 (게이트웨이 핵심 기능의 독립 검증 강화, R4 중요도 반영)

D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 2: 코드 조직 (greenfield 필수 결정)
워크스페이스 루트의 코드 구조는? (aidlc-docs/는 문서 전용 — 코드는 루트)

A) **단일 Python 패키지 모노레포** (권장) —
```
caduceus/            # Python 패키지 (daemon, cli, core 모듈)
  core/  proxy/  control/  cli/
web/                 # SPA 소스 (빌드 산출물은 패키지에 포함)
tests/               # unit / property / integration
pyproject.toml
```

B) src 레이아웃 다중 패키지 — `src/caduceus_core`, `src/caduceus_daemon`, ... (패키지 경계 강제, 대신 단일 배포 목표에 과잉)

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 3: 클라이언트 유닛 구현 순서
CLI(C8)와 Web UI(C9)의 순서는?

A) **CLI 먼저** (권장) — 데몬 API의 1차 검증 수단, E2E 테스트 기반 확보 후 Web UI

B) Web UI 먼저 — 시각적 피드백 우선

C) 병행 (한 유닛으로 묶지는 않되 Construction 루프를 교차 진행)

D) Other (please describe after [Answer]: tag below)

[Answer]: A
