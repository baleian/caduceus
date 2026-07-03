# Alert UX Improvements — Requirements (v1.0)

**Stage**: CONSTRUCTION / 개선 — 알림(드리프트·orphan) 토스트 UX
**Depth**: Standard (기존 U2 Daemon + U4 Web UI 경계 내 변경)
**Status**: **APPROVED 2026-07-04** — 답변 Q1=A(주기 스냅샷) / Q2=A(`events.synced` 마커) / Q3=A(Dashboard 활성 기반) / Q4=A(조건부 재조회)

## 1. 문제 정의 (Intent)

드리프트/orphan 알림이 "현재 상태(condition)"가 아니라 "이벤트 이력"으로만 존재한다:

1. `Reconciler`는 문제가 지속되는 동안 매 주기(기본 30s)마다 `drift.detected` /
   `orphan.detected`를 재발행한다 — 전이(발생→해소) 추적이 없다.
   (`caduceus/control/reconciler.py`)
2. `EventBus`는 최근 500개 이벤트를 replay 버퍼에 보관하고 WS 접속 시 전부
   재전송한다. 문제를 해소해도 과거 이벤트는 남는다. (`caduceus/control/events.py`,
   `caduceus/control/api.py` `/api/events`)
3. 웹 shell reducer는 replay/live를 구분하지 않고 drift/orphan 이벤트마다 토스트를
   만든다 → **새로고침할 때마다 이미 해소된 과거 알림이 전부 토스트로 재등장**.
   (`web/src/state/AppStore.tsx`)

## 2. 사용자 결정 범위 (2026-07-04 원문 반영)

> "replay 이벤트는 토스트하지말고, 방금일어난일 + 웹 페이지 첫 로딩 시점에 현재
> drift 상태를 조회해서 진짜 지금 문제가 있는 상황만 표시. replay 는 system
> 보드에만 표기하도록."

- 토스트 = (a) 접속 이후 실제로 새로 발생한 일 + (b) 첫 로딩 시점에 **지금도 활성인** 문제.
- replay 이력 = System 보드의 "Drift / orphan alerts" 목록에만.

## 3. 기능 요구사항

### FR-1 — 활성 condition 스냅샷 (데몬)
데몬은 "지금 활성인 드리프트/orphan condition 목록"을 REST로 제공한다.
- Reconciler가 매 reconcile 주기의 감지 결과로 활성 condition 집합을 갱신·보관한다
  (방식 → Q1).
- 새 엔드포인트 `GET /api/alerts` (기존 HTTP 인증 미들웨어 적용) 응답 예:
  ```json
  {
    "alerts": [
      {"kind": "drift", "agent": "my-agent", "reason": "gateway-not-running", "since": "..."},
      {"kind": "drift", "agent": "my-agent", "reason": "managed-config-drift", "keys": ["env.FOO"], "since": "..."},
      {"kind": "orphan", "resource": "profile", "name": "cad-old", "since": "..."}
    ],
    "checked_at": "<마지막 reconcile 완료 시각>"
  }
  ```
- condition 키(중복 판정 기준): drift는 `drift:{agent}:{reason}`,
  orphan은 `orphan:{resource}:{name}`. 웹과 동일한 키 규칙을 공유한다.

### FR-2 — replay 이벤트 토스트 금지 (데몬 + 웹)
WS `/api/events`의 replay 구간 이벤트로는 토스트를 만들지 않는다 (구분 방식 → Q2).
replay 이벤트는 지금처럼 reducer의 `alerts` 이력(=System 보드 목록)에는 반영한다.

### FR-3 — 첫 로딩/재접속 시 활성 상태 표시 (웹)
WS (재)접속 성공 시 `GET /api/alerts`를 조회해 활성 condition을 동기화하고,
**활성인 것만** 토스트로 1회 표시한다. 활성 알림 UI 표면(Dashboard 패널) 처리는 Q3.

### FR-4 — 지속 condition의 반복 토스트 억제 (웹)
페이지가 열려 있는 동안 동일 condition의 재감지 이벤트(reconcile 주기마다 재발행)는
재토스트하지 않는다.
- reducer가 활성 condition 맵(`key → alert`)을 유지한다.
- live drift/orphan 이벤트는 **맵에 없는 새 key일 때만** 토스트 + 맵에 추가.
- `drift.remediated`(자동 복구)는 해당 key를 맵에서 제거하고, live 수신 시에만
  정보성 토스트를 유지한다.
- 해소(스냅샷에서 사라짐) 반영 시점 → Q4.

### FR-5 — System 보드 이력 유지 (웹)
System 페이지 "Drift / orphan alerts" 목록은 지금처럼 replay + live 이벤트 이력을
누적 표시한다 (`ALERT_LIMIT` 100, 세션 한정). 변경 없음.

## 4. 비기능 요구사항

- **NFR-1 하위 호환**: 이벤트 스키마(CoreEvent) 변경 없음. Q2에서 마커 이벤트를
  도입할 경우, 웹 reducer와 CLI 이벤트 렌더러가 해당 kind를 잡음 없이 무시해야
  한다 (웹: `eventLog`/Unrecognized events에 쌓이지 않도록 명시 처리).
- **NFR-2 보안**: `/api/alerts`는 기존 `/api/*` 인증 미들웨어 뒤에 있다. 응답에
  시크릿 미포함 (drift `keys`는 키 이름만, 값 미포함 — 기존 `_config_drift`와 동일).
- **NFR-3 복원력** (Resiliency Baseline): `/api/alerts` 조회 실패 시 조용히
  스킵(연결 뱃지가 데몬 가용성을 이미 표시) — 토스트/패널은 마지막 성공 스냅샷 유지.
  Reconciler 스냅샷 갱신은 감지 실패 시에도 루프를 죽이지 않는 기존 계약 유지.
- **NFR-4 PBT** (Property-Based Testing): reducer 활성 맵 불변식(동일 key 재수신
  멱등, replay/live 순서 뒤섞임에도 토스트 정책 위반 없음), Reconciler 스냅샷이
  감지 결과 집합과 일치함을 속성 테스트로 검증.

## 5. 범위 제외 (Out of Scope)

- 토스트 자동 소멸 타이머 / 중복 병합(×N) 등 토스트 스타일링 개선
- Reconciler emission의 edge-trigger 전환, `drift.resolved` 이벤트 신설
- replay 버퍼 크기/보존 정책 변경, CLI 표시 변경

## 6. 영향 컴포넌트

| 영역 | 파일 | 변경 |
|---|---|---|
| U2 데몬 | `caduceus/control/reconciler.py` | 활성 condition 스냅샷 유지 |
| U2 데몬 | `caduceus/control/api.py` | `GET /api/alerts`, (Q2=A 시) replay 마커 전송 |
| U4 웹 | `web/src/api/client.ts` | `getAlerts()` 추가 |
| U4 웹 | `web/src/lib/reducer.ts` | 활성 condition 맵 + 토스트 정책 입력 분리 |
| U4 웹 | `web/src/state/AppStore.tsx` | replay 구분, 접속 시 alerts 동기화, 토스트 생성 규칙 |
| U4 웹 | `web/src/pages/dashboard/DashboardPage.tsx` | (Q3=A 시) 활성 스냅샷 기반 패널 |
