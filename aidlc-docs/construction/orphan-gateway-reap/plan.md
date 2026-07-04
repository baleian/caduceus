# Code Generation Plan — Orphan Gateway 프로세스 방지

**Cycle**: 경량 CONSTRUCTION 개선
**Approved answers**: Q1=A(엄격 신원검증), Q2=A(경고 후 진행), Q3=A(+ orphan 알럿 수동 해소 UI 버튼)

## 설계 개요

- hermes 가 남기는 `<profile>/gateway.pid`(JSON `{pid, kind:"hermes-gateway", argv, start_time}`)를
  매니저 in-memory 상태와 **독립적인 진실원**으로 삼는다.
- 임의 PID 종료의 안전을 위해 신규 effect port `ProcessSignaller` 뒤로 `/proc` 조회 + `os.kill` 을
  숨겨 fake 주입 가능(PBT). **Q1=A 엄격 검증**: 살아있는 PID 의 `/proc` start_time 이 pidfile 의
  `start_time` 과 일치하고 **AND** live cmdline 이 `-p <profile> gateway`(프로파일명 + "gateway")를
  포함할 때만 신호. 불일치면 신호 안 보냄(PID 재활용 방어).
- remove 의 `gateway_stop` 은 매니저 stop(관리 중일 때) + **항상** pidfile 기반 reap(belt-and-
  suspenders). **Q2=A**: reap 실패/불확실 시 경고 로그 후 remove 계속.
- **Q3=A + UI**: 리컨사일러 자동 reap 은 추가하지 않음(감지/알럿 유지). 대신 신규
  `POST /api/alerts/orphan/resolve` + 대시보드 orphan 알럿의 "clean up" 버튼으로 사용자가 직접
  reap+삭제하여 알럿을 정상화.

## Steps

### S1 — 신규 effect port: ProcessSignaller
- [ ] `caduceus/core/ports.py`: `ProcessSignaller` Protocol 추가 —
      `alive(pid) -> bool`, `start_time(pid) -> int | None`(/proc/<pid>/stat field 22),
      `cmdline(pid) -> list[str] | None`(/proc/<pid>/cmdline, NUL split), `terminate(pid)`(SIGTERM),
      `kill(pid)`(SIGKILL). 신호 메서드는 `ProcessLookupError` 흡수.
- [ ] `RealProcessSignaller` 실제 구현(`os.kill(pid,0)` liveness, `/proc` 파싱). Linux 가정.
- [ ] `tests/unit/fakes.py`: `FakeSignaller` — pid→(alive, start_time, cmdline) 맵 + 받은 신호 기록,
      `terminate/kill` 이 상태 전이(옵션: kill 후 dead)까지 스크립팅 가능.

### S2 — HermesAdapter: pidfile 읽기 + reap
- [ ] `caduceus/core/hermes_adapter.py`: 생성자에 `signaller: ProcessSignaller = RealProcessSignaller()`
      주입(기본 실제 구현 → 기존 호출부/테스트 무변경).
- [ ] `GatewayPidInfo` dataclass(pid:int, kind:str, argv:list[str], start_time:int|None).
- [ ] `read_gateway_pidinfo(profile) -> GatewayPidInfo | None`: `<profile>/gateway.pid` 를 FileStore 로
      읽어 JSON 파싱. 파일 없음/JSON 손상/`kind != "hermes-gateway"`/pid 없음 → `None`(FR3).
- [ ] `async reap_gateway(self, profile, *, clock: Clock, grace_s: float = GATEWAY_REAP_GRACE_S) -> str`:
      - info 없음 → `"absent"`.
      - `not signaller.alive(pid)` → `"dead"`(stale pidfile).
      - **신원검증(Q1=A)**: `info.start_time is not None and signaller.start_time(pid) == info.start_time`
        **AND** cmdline 토큰에 `profile` 와 `"gateway"` 포함. 불일치 → `"mismatch"`(신호 X).
      - `signaller.terminate(pid)` → grace 동안 `clock.sleep` 폴링; 여전히 alive → `signaller.kill(pid)`
        → 재폴링. 최종 alive → `"survived"`, 아니면 `"terminated"`.
      - 예외는 내부에서 잡지 않음(호출부 Provisioner 가 Q2=A 로 처리). 단 순수 판독/신호 경로는 예외를
        던지지 않도록 방어.

### S3 — Provisioner: remove 보강 + resolve_orphan
- [ ] `caduceus/control/provisioner.py` `remove_agent.gateway_stop`:
      매니저 관리 중이면 `manager.stop`, 그리고 **항상** `await hermes.reap_gateway(profile, clock=self._clock)`.
      **Q2=A**: `try/except Exception` 으로 감싸 실패 시 `logger.warning` 후 계속(remove 를 깨지 않음).
      reap 결과가 `"survived"` 여도 경고만.
- [ ] 신규 `resolve_orphan(self, resource: str, name: str) -> Job`:
      - 가드: `name.startswith(PROFILE_PREFIX)` 그리고 **레지스트리에 없음**(살아있는 에이전트 프로필을
        실수로 지우지 못하게) — 아니면 `DomainValidationError`.
      - `resource == "profile"`: steps `reap`(reap_gateway) → `containers-remove` → `profile-delete`
        (기존 `delete_profile`: 고아 root 소유 artifacts reclaim+retry, 실패해도 진행).
      - `resource == "container"`: step `containers-remove` 만.
      - 그 외 resource → `DomainValidationError`.
      - `self._jobs.submit("resolve-orphan", name, steps)` 반환.

### S4 — Admin API 엔드포인트
- [ ] `caduceus/control/api.py`: `POST /api/alerts/orphan/resolve`, status 202.
      요청 바디 pydantic 모델 `{resource: Literal["profile","container"], name: str}`.
      `job = provisioner.resolve_orphan(body.resource, body.name)` → `{"job_id": job.id}`.
      검증/도메인 오류는 기존 `_error_response`/예외 핸들러 패턴으로 매핑.

### S5 — Web UI: orphan 알럿 수동 해소 버튼
- [ ] `web/src/api/client.ts`: `resolveOrphan(resource, name): Promise<{ job_id: string }>` →
      `POST /api/alerts/orphan/resolve`.
- [ ] `web/src/pages/dashboard/DashboardPage.tsx`: "Alerts / active now" 리스트에서
      `alert.kind === 'orphan'` 항목에 "clean up" 버튼(onClick). 클릭 시 pending 표시 →
      `resolveOrphan(alert.resource, alert.name)` → 성공 시 해당 alert 키를 activeAlerts 에서 낙관적 제거
      + 다음 alerts-snapshot 이 확정 반영, 실패 시 error 토스트. `data-testid` 부여.
- [ ] activeAlerts 낙관적 제거용 액션이 없으면 `web/src/state/AppStore.tsx` 에 `alert-dismiss`(key) 액션
      추가(reducer 순수 유지). drift 알럿엔 버튼 미노출.

### S6 — 테스트 (PBT Full enforcement)
- [ ] `tests/unit/test_hermes_adapter.py`(또는 신규): reap_gateway — absent / dead(stale) /
      mismatch(start_time 또는 cmdline 불일치 → 신호 0건) / graceful(SIGTERM 후 사망) /
      escalate(SIGTERM 무시 → SIGKILL) / survived.
- [ ] `tests/unit/test_provisioner_lifecycle.py`: 매니저가 관리 안 하는 살아있는 gateway 도 remove 시
      reap 됨(FakeSignaller 신호 확인); reap 예외 시 remove 계속(Q2=A); `resolve_orphan` 잡 스텝/
      orphan-only 가드(레지스트리에 있는 이름 거부).
- [ ] `tests/property/`: reap 불변식 — 신원 불일치면 절대 신호 안 감; 종료 성공이면 최종 not alive;
      absent/dead 는 신호 0건.
- [ ] Web: `resolveOrphan` 클릭 → 낙관적 제거/에러토스트 vitest(또는 reducer `alert-dismiss` 속성).

### S7 — 검증
- [ ] `ruff check` clean, `mypy`(strict) clean, `pytest` 그린(신규 포함).
- [ ] Web `tsc` 0 / `eslint`(max-warnings 0) / `vitest` 그린 / `vite build` → `caduceus/web_dist` 갱신.
- [ ] Playwright E2E 14/14.

### S8 — 문서
- [ ] `construction/orphan-gateway-reap/code-summary.md` 작성.
- [ ] `aidlc-state.md` Current Status 갱신(완료·커밋 대기 반영).

## 표준 완료 후 (승인 게이트)
Part 2 Generation 완료 시 표준 2-옵션 메시지(Request Changes / Continue to Next Stage[=커밋]) 제시.
