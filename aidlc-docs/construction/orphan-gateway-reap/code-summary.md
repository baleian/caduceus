# Code Summary — Orphan Gateway 프로세스 방지

**Cycle**: 경량 CONSTRUCTION 개선 (2026-07-04)
**Answers**: Q1=A(엄격 신원검증), Q2=A(경고 후 진행), Q3=A(리컨사일러 자동 reap 없음) + orphan 알럿 수동 해소 UI 버튼

## 문제 → 해결

agent remove 후에도 gateway 프로세스가 살아 프로파일 디렉토리를 재생성 → 리컨사일러가 매
사이클 `orphan.detected` 반복. 원인: `remove`의 `gateway_stop`이 매니저 in-memory 추적
(`is_managed`)일 때만 종료 → 데몬 재시작/매니저 우회 gateway 미종료. 해결: `<profile>/gateway.pid`
(디스크 기반 실제 pid)를 진실원으로 써 매니저 상태와 무관하게 **항상** 종료.

## 변경 파일

### 백엔드
- **`caduceus/core/ports.py`**: 신규 `ProcessSignaller` Protocol(`alive`/`start_time`/`cmdline`/
  `terminate`/`kill`) + `RealProcessSignaller`(Linux `/proc` + `os.kill`). start_time 은
  `/proc/<pid>/stat` field 22, cmdline 은 `/proc/<pid>/cmdline`.
- **`caduceus/core/hermes_adapter.py`**:
  - 생성자에 `signaller: ProcessSignaller | None`(기본 `RealProcessSignaller`) 주입.
  - `GatewayPidInfo` dataclass, `read_gateway_pidinfo(profile)`(pidfile 파싱; 부재/손상/kind
    불일치/비정상 pid → None).
  - `reap_gateway(profile, *, clock, grace_s)` — **엄격 신원검증(Q1=A)**: pidfile start_time 이
    존재하고 live `/proc` start_time 과 일치하며 cmdline 토큰에 `profile` 와 `"gateway"` 포함할
    때만 신호. SIGTERM → grace 폴링 → SIGKILL 재폴링. 반환:
    `absent`/`dead`/`mismatch`/`terminated`/`survived`.
- **`caduceus/control/provisioner.py`**:
  - `remove_agent.gateway_stop`: 매니저 stop(관리 중) + **항상** `reap_gateway`(belt-and-
    suspenders). **Q2=A**: reap 예외/`survived` 시 경고만, remove 계속.
  - 신규 `resolve_orphan(resource, name) -> Job`: orphan-only 가드(cad- 프리픽스 + 레지스트리
    부재; 살아있는 에이전트 프로필이면 `ConflictError`). profile → `reap`/`containers-remove`/
    `profile-delete`, container → `containers-remove`.
- **`caduceus/control/jobs.py`**: `JobKind` 에 `"resolve-orphan"` 추가.
- **`caduceus/control/api.py`**: `POST /api/alerts/orphan/resolve`(pydantic `ResolveOrphan`
  {resource: profile|container, name}) → `provisioner.resolve_orphan` → `{job_id}`.

### 웹
- **`web/src/api/client.ts`**: `resolveOrphan(resource, name)`.
- **`web/src/state/AppStore.tsx`**: `alert-dismiss` 액션 + reducer 케이스(낙관적 제거, 미존재
  키는 no-op) + 스토어 `dismissAlert(key)` 노출.
- **`web/src/pages/dashboard/DashboardPage.tsx`**: "Alerts / active now" 의 orphan 항목에
  "clean up" 버튼 — `resolveOrphan` 호출 → 성공 시 `dismissAlert`+info 토스트, 실패 시 error
  토스트, pending 표시. `data-testid=dashboard-orphan-cleanup-<name>`.

### 테스트 (fakes: `tests/unit/fakes.py` 에 `FakeProc`/`FakeSignaller`)
- `tests/unit/test_hermes_adapter.py::TestReapGateway` — absent/malformed/wrong-kind/dead/
  mismatch(start_time·cmdline·start_time None)/graceful/escalate/survived/bool-pid.
- `tests/unit/test_provisioner_lifecycle.py` — 매니저 미추적 gateway reap / 관리+pidfile 동시
  reap / reap 실패 시 remove 지속 / resolve_orphan(profile·container·live-agent 거부·비프리픽스
  거부·unknown resource 거부).
- `tests/property/test_reap_gateway_properties.py` — SAFETY(신원 불일치 신호 0건) /
  EFFECTIVENESS(매칭 gateway 신호+killable 사망) / NO-OP(absent·dead 신호 0건).
- `web/tests/unit/state.test.ts` — `alert-dismiss` 낙관적 제거 + 미존재 키 no-op.

## 검증
- ruff clean · mypy(strict) 43 files clean · pytest **521 passed**, 4 deselected(이전 499).
- web tsc 0 · eslint(max-warnings 0) clean · vitest **86**(신규 1) · vite build → `caduceus/web_dist`
  갱신 · Playwright E2E **14/14**.
