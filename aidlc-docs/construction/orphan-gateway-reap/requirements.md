# Requirements — Orphan Gateway 프로세스 방지 (remove 시 gateway 무조건 종료)

**Cycle**: 경량 CONSTRUCTION 개선
**Date**: 2026-07-04
**Depth**: Minimal (명확한 단일 결함 하드닝 — 기존 컴포넌트 경계 내)

## 1. 배경 / 문제 (Intent Analysis)

에이전트를 remove 한 뒤에도 `orphan.detected {"resource":"profile","name":"cad-test2"}`
알럿이 매 리컨사일 사이클마다 반복 발생.

**근본 원인** (실기 진단으로 확정):
- remove 후에도 gateway 프로세스(`hermes -p cad-test2 gateway`, PID 69873)가 살아 있었음.
  이 프로세스가 `<profile>/cron/ticker_heartbeat` 등을 계속 write → 프로파일 디렉토리를
  지워도 즉시 재생성.
- 리컨사일러 orphan 판정은 단순 디렉토리 스캔이다
  ([reconciler.py:132-137](../../../caduceus/control/reconciler.py#L132-L137) →
  `HermesAdapter.list_profiles()` = `<home>/profiles` 하위 디렉토리 목록).
  레지스트리에서는 지워졌지만 디스크 디렉토리가 살아있는 프로세스 때문에 남아 있어
  "레지스트리에 없음 + 디렉토리 있음" = orphan 이 매 사이클 성립.
- remove 흐름의 gateway 종료 단계는 **매니저가 추적 중일 때만** 죽인다
  ([provisioner.py:204-206](../../../caduceus/control/provisioner.py#L204-L206)):
  ```python
  async def gateway_stop() -> None:
      if self._manager.is_managed(name):   # False → gateway 안 죽임
          await self._manager.stop(name)
  ```
  `GatewayProcessManager`는 gateway를 **in-memory `_managed` dict** 로만 추적하므로
  (process_manager.py:75), 데몬 재시작·크래시 후 재기동, 혹은 매니저 밖에서 뜬 gateway는
  `is_managed()`가 False → 종료되지 않고 orphan 으로 남는다.

**디스크 기반 진실원**: hermes 는 각 프로파일에 `<profile>/gateway.pid` (및 `gateway.lock`)를
남긴다 — JSON `{"pid", "kind":"hermes-gateway", "argv":[...], "start_time":<proc starttime>}`.
이는 매니저의 in-memory 상태와 **독립적인**, 실제 실행 중 gateway 의 durable 기록이다.

## 2. 목표

에이전트를 remove 할 때 담당 hermes gateway 프로세스가 **매니저 추적 여부와 무관하게 항상
종료**되도록 remove 경로를 보강한다. → orphan gateway(그리고 그로 인한 orphan profile 알럿)를
최대한 원천 차단.

## 3. 범위

**In scope**
- `remove_agent`의 `gateway_stop` 단계를 보강: 매니저가 관리 중이면 기존대로
  `manager.stop()`, 그리고 **항상** `<profile>/gateway.pid` 기반으로 살아있는 gateway를
  확인·종료(SIGTERM → grace → SIGKILL)하는 fallback sweep 추가.
- `HermesAdapter`에 pidfile 읽기 + (신원 검증 후) 프로세스 종료 기능 추가.
- PID 재활용(recycling) 안전장치: stale pidfile 의 PID 가 무관한 프로세스로 재사용된 경우를
  피하기 위한 신원 검증 (강도는 Q1로 결정).
- 신규 effect port(프로세스 시그널링) 도입 — 헥사고날 seam 유지, PBT/단위테스트에서 fake 주입.

**Out of scope** (Q3 답변에 따라 조정)
- 리컨사일러가 orphan 을 능동적으로 reap 하는 확장 (Q3 = B 선택 시 In scope 로 전환).
- create 경로(`profile-create`)의 기존 고아 프로필 reclaim+삭제 로직 — 이미 존재, 변경 없음.
- 웹/CLI 표면 변경 없음(순수 백엔드 하드닝). web_dist 리빌드 불필요.

## 4. 기능 요구사항

- FR1. remove 시, 매니저가 해당 에이전트를 관리 중이면 기존대로 graceful stop 한다.
- FR2. remove 시, 관리 여부와 무관하게 `<profile>/gateway.pid`를 읽어 기록된 PID 가
  **살아있고 이 프로파일의 gateway 가 맞으면**(신원 검증 — Q1) SIGTERM 후 grace 대기,
  살아있으면 SIGKILL 로 escalate 하여 확실히 종료한다.
- FR3. pidfile 이 없거나(=이미 종료) 기록된 PID 가 죽어있거나 신원 불일치면 no-op 로 조용히 통과.
- FR4. gateway 종료는 후속 `profile-delete` 단계보다 먼저 완료되어 삭제-재생성 레이스를 없앤다.
- FR5. 종료가 확인되지 않는 예외 상황의 처리 정책은 Q2 로 결정.

## 5. 비기능 / 제약

- **테스트 가능성 (PBT extension = Full enforcement)**: 프로세스 시그널링은 effect port 뒤로
  숨겨 fake 로 결정적 테스트. SIGTERM→grace→SIGKILL escalation, 신원검증 분기, stale/no-op
  분기 전부 커버.
- **안전성 (Security Baseline)**: 임의 PID 를 신호로 죽이는 행위이므로 신원 검증(Q1)이 핵심
  안전장치. 검증 실패 시 신호를 보내지 않는다.
- **회복탄력성 (Resiliency Baseline)**: reap 자체가 remove 를 깨선 안 됨 — Q2 정책에 따라
  실패해도 가시성(레지스트리 제거)은 보존(기존 `profile_delete` 철학과 정합).
- Linux 전용 가정 유지(프로젝트는 이미 `/proc`·rootless docker 기반 리눅스 환경).

## 6. 결정 필요 (→ requirements-questions.md)

- Q1: PID 신원 검증 강도 (재활용 안전장치)
- Q2: gateway 종료가 확인 안 될 때 remove 동작 (proceed vs hard-fail)
- Q3: 리컨사일러 능동 reap 포함 여부 (범위)

## 7. 수용 기준

- 매니저가 추적하지 않는 살아있는 gateway 도 remove 시 종료된다(신규 테스트로 증명).
- 종료 후 프로파일 디렉토리 삭제가 재생성으로 되돌려지지 않는다.
- 기존 remove/lifecycle 테스트 전부 통과, 신규 reap 단위+속성 테스트 추가.
- ruff / mypy(strict) / pytest 그린.
