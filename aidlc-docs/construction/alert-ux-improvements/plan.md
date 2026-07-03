# Code Generation Plan — Alert UX Improvements (드리프트·orphan 알림)

**Date**: 2026-07-04
**Requirements**: `requirements.md` (FR-1~FR-5) — 답변 Q1=A(주기 스냅샷) / Q2=A(sync 마커) / Q3=A(Dashboard 활성 기반) / Q4=A(조건부 재조회)
**Scope**: U2 데몬(`caduceus/control/`) + U4 웹(`web/src/`). Reconciler emission 정책·replay 버퍼·CLI 무변경.
**이 파일이 Code Generation의 단일 소스 오브 트루스입니다.**

## Unit Context

- **대상**: U2 Daemon (Reconciler 스냅샷 + `/api/alerts` + WS 마커), U4 Web UI (토스트 정책 + 활성 알림 동기화 + Dashboard 패널)
- **의존**: EventBus replay 계약(P4) 유지 — replay 이벤트 자체는 그대로 전송, 마커 1건만 추가.
- **보존 계약**:
  - CoreEvent 스키마 무변경. `events.synced`는 신규 kind 1개 — 웹/CLI 소비자는 잡음 없이 무시(NFR-1).
  - System 보드 "Drift / orphan alerts" 목록(이력, `ALERT_LIMIT` 100) 현행 유지(FR-5).
  - 기존 test-id (`toast-area`, `system-alerts-list`, `system-event-log`) 유지.
  - reducer 멱등 계약(WPT-3): replay+live 중복 수렴 유지.
- **condition 키 규칙** (데몬·웹 공유): `drift:{agent}:{reason}` / `orphan:{resource}:{name}`

## Steps

### 데몬 — FR-1 활성 스냅샷, FR-2 replay 마커 (Q1=A, Q2=A)

- [x] **S1. Reconciler 활성 condition 스냅샷** (`caduceus/control/reconciler.py`)
  - `_active: dict[str, dict[str, Any]]` + `_checked_at: str | None` 유지;
    `reconcile_once()`가 매 주기 새 dict를 구성해 완료 시 원자 교체
  - 지속 key는 이전 `since` 보존, 신규 key는 `clock.now_iso()`
  - dead-gateway: 재시작 성공(remediated) 시 활성에 미포함; 실패/R5 억제 시 포함
  - config-drift: `keys`(키 이름만, 값 미포함 — NFR-2) 포함; orphan: `resource`/`name`
  - `alerts_snapshot() -> dict[str, Any]`: `{"alerts": [payload...], "checked_at": ...}`
    (payload에 `key`, `kind`("drift"|"orphan"), `agent`/`reason`/`keys`/`resource`/`name`, `since`)
  - 감지 단계 예외 시 루프 생존 계약 유지 — 스냅샷은 마지막 성공 주기 것 보존(NFR-3)
- [x] **S2. API 노출 + WS 마커** (`caduceus/control/api.py`, `caduceus/daemon.py`)
  - `build_admin_router`에 `alerts_snapshot: Callable[[], dict]`, `clock: Clock` 주입
    (daemon.py 배선: `reconciler.alerts_snapshot`, `clock`)
  - `GET /api/alerts` → 스냅샷 그대로 반환 (기존 인증 미들웨어 적용)
  - `events_ws`: replay 루프 종료 직후
    `CoreEvent(kind="events.synced", agent=None, data={}, ts=clock.now_iso())` 1건 전송
- [x] **S3. 데몬 테스트**
  - `tests/unit/test_prober_reconciler.py`: 감지↔활성 일치 / 해소 시 다음 주기 제거 /
    지속 시 `since` 보존 / 재시작 성공 시 미활성 / orphan 입양 시 제거
  - `tests/property/`(Hypothesis, PBT 확장): 임의 감지 상태 시퀀스에 대해
    스냅샷 == 마지막 주기 감지 집합, key 유일성, 지속 구간 `since` 불변
  - `tests/integration/test_daemon_asgi.py`: `/api/alerts` 401/200·응답 shape,
    WS 순서(replay 전체 → `events.synced` → live) 보장

### 웹 — FR-2/3/4 토스트 정책 + 동기화 (Q2=A, Q4=A), FR-5 이력 유지

- [x] **S4. 타입 + 클라이언트** (`web/src/lib/types.ts`, `web/src/api/client.ts`)
  - `ActiveAlert`(key/kind/agent/reason/keys/resource/name/since) + 스냅샷 응답 타입
  - `getAlerts(): Promise<AlertsSnapshot>` (`GET /api/alerts`)
- [x] **S5. 토스트 정책 + 활성 맵** (`web/src/lib/reducer.ts`, `web/src/state/AppStore.tsx`)
  - condition 키 헬퍼(이벤트·DTO 공용, 데몬과 동일 규칙)
  - `ShellState`에 `synced: boolean`, `activeAlerts: Record<string, ActiveAlert>` 추가
  - `events.synced`: `synced=true`, 이력·eventLog 미적재(reduceEvent 명시 무시 — NFR-1);
    WS 연결 단절 시 `synced=false` 리셋
  - drift/orphan 이벤트: 이력(`alerts`) 적재 현행 유지(FR-5);
    토스트는 **synced && 신규 key**일 때만 + `activeAlerts`에 추가(detected) /
    제거(`drift.remediated`, live 수신 시 info 토스트)
  - 새 액션 `alerts-snapshot`: `activeAlerts` 교체, 이전 맵에 없던 key만 토스트
    (첫 로딩 = 빈 맵 → 활성 전부 1회 토스트 — FR-3)
- [x] **S6. 접속 동기화 + 조건부 폴링** (`web/src/state/AppStore.tsx`)
  - `onConnected` → `refetchAgents`와 함께 `refetchAlerts`
  - drift/orphan live 이벤트 수신 시 `refetchAlerts`(디바운스)
  - `activeAlerts`가 비어있지 않은 동안만 reconcile 주기(30s) 폴링, 비면 중단(Q4=A)
  - 조회 실패는 조용히 스킵 — 마지막 성공 스냅샷 유지(NFR-3)
- [x] **S7. Dashboard 알림 패널 교체 (Q3=A)** (`web/src/pages/dashboard/DashboardPage.tsx`)
  - "Alerts" 카드 → `activeAlerts` 기반: subtitle "active now",
    빈 상태 "no active alerts", 항목에 reason/resource·`since` 표시,
    `data-testid="dashboard-active-alerts"`
- [x] **S8. System 보드 무변경 검증** (`web/src/pages/system/SystemPage.tsx`)
  - 이력 목록 현행 동작 확인(FR-5), `events.synced`가 Unrecognized events에
    노출되지 않는지 확인(NFR-1)
- [x] **S9. 웹 테스트**
  - `web/tests/unit/state.test.ts`: 마커 전 replay 무토스트 / 마커 후 신규 key 토스트 /
    동일 key 재수신 무토스트 / remediated 제거+info 토스트 / 스냅샷 diff 토스트 /
    재접속 시 synced 리셋
  - `web/tests/property/reducer.test.ts`(fast-check): 임의 인터리브(replay·마커·live·스냅샷)에서
    불변식 — 마커 전 토스트 0, 활성 지속 중 key당 토스트 ≤ 1,
    eventLog에 `events.synced` 없음, `alerts` 이력 bounded 유지
  - `web/tests/unit/client.test.ts`: `getAlerts` 요청 경로·토큰·에러 정규화
- [x] **S10. 검증 + 산출물**
  - 데몬: ruff / mypy / pytest 전체 통과
  - 웹: tsc / eslint / vitest / Playwright E2E / vite build → `web_dist` 갱신
  - `aidlc-docs/construction/alert-ux-improvements/code-summary.md` 작성,
    plan 체크박스·aidlc-state.md 갱신

## Extension 준수 계획

- **Resiliency**: S1(스냅샷은 실패 주기에도 마지막 성공분 보존), S6(조회 실패 조용히 스킵)
- **Security**: `/api/alerts` 기존 인증 미들웨어 경유, 응답에 시크릿 값 미포함(S1)
- **PBT**: S3(reconciler 스냅샷 속성), S9(reducer 토스트 정책 속성)
