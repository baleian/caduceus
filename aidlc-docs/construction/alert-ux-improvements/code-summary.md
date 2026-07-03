# Alert UX Improvements — Code Summary

**Plan**: `plan.md` (S1~S10 전체 완료) · **Requirements**: `requirements.md` v1.0
**답변**: Q1=A(주기 스냅샷) / Q2=A(`events.synced` 마커) / Q3=A(Dashboard 활성 기반) / Q4=A(조건부 재조회)

## 변경 파일

### U2 데몬
- **수정**: `caduceus/control/reconciler.py` — 활성 condition 스냅샷.
  `reconcile_once()`가 매 주기 활성 맵(`drift:{agent}:{reason}` / `orphan:{resource}:{name}`)을
  새로 구성해 완료 시 원자 교체(실패 주기는 마지막 성공분 보존 — NFR-3). 지속 key는 `since` 보존.
  dead-gateway는 재시작 성공 시 활성 미포함, 실패/R5 억제 시 포함. `alerts_snapshot()` 노출.
- **수정**: `caduceus/control/api.py` — `GET /api/alerts`(기존 인증 미들웨어 뒤),
  `events_ws`가 replay 종료 직후 `events.synced` 마커 1건 전송.
- **수정**: `caduceus/daemon.py` — `build_admin_router`에 `alerts_snapshot`/`clock` 배선.

### U4 웹
- **수정**: `web/src/lib/types.ts` — `ActiveAlert`, `AlertsSnapshot`.
- **수정**: `web/src/api/client.ts` — `getAlerts()`.
- **수정**: `web/src/lib/reducer.ts` — `conditionKey`/`activeAlertFromEvent`/`alertLabel` 헬퍼(데몬 키 규칙 공유),
  `events.synced`는 이력·eventLog 미적재(명시 무시 — NFR-1).
- **수정**: `web/src/state/AppStore.tsx` — 토스트 정책 재구성:
  - `synced` 플래그: 마커 수신 시 true, 연결 상태 전이 시 false — **replay 이벤트는 절대 토스트 안 함**(FR-2)
  - `activeAlerts` 맵: post-sync live detected는 신규 key일 때만 warn 토스트+맵 추가(FR-4),
    `drift.remediated`는 key 제거+info 토스트
  - `alerts-snapshot` 액션: 맵 교체, 이전에 몰랐던 key만 토스트(첫 로딩=활성 전부 1회 — FR-3)
  - (재)접속 시 `refetchAlerts`, drift/orphan 이벤트 시 500ms 디바운스 재조회,
    활성 알림 존재 동안만 30s 폴링(`ALERTS_POLL_MS`, Q4=A), 조회 실패 조용히 스킵(NFR-3)
- **수정**: `web/src/pages/dashboard/DashboardPage.tsx` — Alerts 카드를 활성 스냅샷 기반으로 교체
  (subtitle "active now", 빈 상태 "no active alerts", `data-testid="dashboard-active-alerts"`, Q3=A).
- **무변경 확인**: `web/src/pages/system/SystemPage.tsx` — 이력 목록(FR-5) 그대로; 마커는 Unrecognized events에 미노출.

### 테스트
- **수정**: `tests/unit/test_prober_reconciler.py` — 스냅샷 4건(빈 스냅샷/remediated 미활성/R5 억제 활성→해소/config drift since 보존·해소), `TickingClock`.
- **생성**: `tests/property/test_reconciler_snapshot_properties.py` — 임의 orphan 시퀀스에 대해
  활성==마지막 주기 감지, key 유일성, 지속 구간 `since` 불변 (Hypothesis).
- **수정**: `tests/integration/test_daemon_asgi.py` — WS 순서(replay→마커→live), `/api/alerts` 401/빈/orphan 노출.
- **수정**: `web/tests/unit/state.test.ts` — 새 토스트 정책 8케이스.
- **수정**: `web/tests/property/reducer.test.ts` — 임의 인터리브 불변식(마커 전 토스트 0, 활성 key 재토스트 0,
  스냅샷=활성 집합, eventLog에 마커 없음, bounded) (fast-check).
- **수정**: `web/tests/unit/client.test.ts` — `getAlerts` 경로/토큰.

## 검증
- 데몬: ruff clean · mypy 43 files clean · pytest **488 passed** (4 deselected)
- 웹: tsc 0 err · eslint 0 warn · vitest **62/62** · Playwright E2E **14/14** · vite build → `caduceus/web_dist` 갱신

## Extension 준수
- **Resiliency**: 스냅샷은 실패 주기에 마지막 성공분 보존, 웹 조회 실패 조용히 스킵(연결 뱃지가 가용성 표시)
- **Security**: `/api/alerts`는 기존 인증 미들웨어 뒤, 응답에 시크릿 값 미포함(drift `keys`는 키 이름만)
- **PBT**: reconciler 스냅샷 속성 + 웹 토스트 정책 속성 각각 신규
