# U1 Core Foundation — Functional Design Plan

**Date**: 2026-07-02
**Unit**: U1 Core Foundation (C2 Agent Registry, C6 Hermes Adapter, C7 Service Manager Adapter — `caduceus/core/`)

## Plan Steps

- [x] Step 1: 설계 질문 답변 수집·분석 (Q1=A cad- 프리픽스, Q2=A 병합, Q3=자식 프로세스 모델 확정(FD3), Q4=Other: rm=워크스페이스만 보존(FD4))
- [x] Step 2: `domain-entities.md` — 도메인 엔티티·관계·데이터 구조 (AgentSpec/Record, GatewayProcess, RegistryFile, CaduceusConfig, ManagedConfigKeys)
- [x] Step 3: `business-logic-model.md` — 핵심 로직 (레지스트리·포트·토큰, config 병합 렌더링, 자식 프로세스 관리, profile 수명주기, preflight)
- [x] Step 4: `business-rules.md` — 검증 규칙 V1~V6·불변식 I1~I5·수명주기 L1~L7·설정 공존 G1~G3·크리덴셜 S1~S4·오류 E1~E4
- [x] Step 5: **Testable Properties 섹션** — PBT-01 속성 P1~P10 식별 (business-logic-model.md §8)
- [x] Step 6: 완료 메시지 제시 및 승인 대기 (+ 상위 설계 문서 AMD-1/AMD-2 반영)

---

# 설계 질문 — U1

## Question 1: 에이전트 ↔ hermes profile 네이밍 (도메인 규칙)
Caduceus가 만드는 hermes profile의 이름 정책은? 사용자가 Caduceus 밖에서 직접 만든 profile과의 충돌·구분에 영향합니다.

A) **`cad-<agent>` 프리픽스 네임스페이스** (권장) — Caduceus 소유 profile임을 명시(고아 리소스 감지·정리 용이, 사용자 수동 profile과 충돌 없음). 에이전트 이름 최대 60자로 제한됨

B) **동일 이름 1:1** — agent `coder` = profile `coder`. 단순·직관(hermes CLI에서 `hermes -p coder`로 바로 접근), 대신 기존 profile과 충돌 시 생성 거부 규칙 필요

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 2: profile config.yaml 소유권 (통합 규칙)
Caduceus가 profile의 `config.yaml`을 어떻게 다룰까요? 사용자가 hermes dashboard/CLI로 직접 편집하는 경우(F8 보존)와의 공존이 관건입니다.

A) **관리 키만 병합 쓰기** (권장) — Caduceus는 자신이 소유한 키(`model.provider/base_url/default`, `terminal.*`, api_server 관련)만 병합·갱신하고 나머지 키는 보존. 사용자의 hermes-네이티브 편집과 공존. 단, 소유 키를 사용자가 바꾸면 reconcile에서 드리프트 경고 후 재적용

B) **전체 소유·재렌더** — config.yaml 전체를 Caduceus 템플릿에서 생성(단순·예측 가능), 사용자 직접 편집은 비지원(덮어씀)

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 3: 서비스 매니저 부재 시 폴백 (플랫폼 규칙, N9)
WSL2는 systemd가 비활성일 수 있습니다. C7의 동작 정책은?

A) **계층 폴백** (권장) — systemd user(Linux)/launchd(macOS) 사용 가능하면 등록(부팅 지속·OS 감독), 불가하면 **hermes 네이티브 백그라운드 gateway**(gateway.pid 기반 start/stop)로 폴백. 폴백 시 크래시 자동 재시작은 없음을 status에 명시하고 reconcile이 감지·알림

B) **서비스 매니저 필수** — 부재 시 에이전트 start 거부 (명확하지만 WSL2 기본 환경 배제 위험)

C) Other (please describe after [Answer]: tag below)

[Answer]: 

## Question 4: 에이전트 삭제 기본 의미론 (파괴적 동작 규칙, F2)
`caduceus agent rm <name>`의 기본 동작은?

A) **소프트 삭제 기본** (권장) — 정지 + 서비스 해제 + 레지스트리 제거. profile·워크스페이스·컨테이너는 보존(F2 산출물 보호). 완전 삭제는 `--purge` + 확인 프롬프트(컨테이너·sandbox·profile까지 제거)

B) **완전 삭제 기본** — rm이 곧 purge (확인 프롬프트 필수), 보존을 원하면 `--keep-data`

C) Other (please describe after [Answer]: tag below)

[Answer]: 에이전트 삭제 시 profile, 컨테이너는 완전 삭제. 워크스페이스만 보존 (hostpath가 bind mount 되어있기 때문에 알아서 보존됨). 에이전트 stop -> start 는 profile 도 복원. 컨테이너 유지. rm 의 경우는 workspace만 보존하고 리소스 모두 정리.
