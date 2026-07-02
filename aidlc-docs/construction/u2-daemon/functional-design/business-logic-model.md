# U2 Daemon — Business Logic Model

기술 중립 로직 정의 (HTTP 프레임워크는 NFR 단계 확정). U1 core 공개 API만 사용 (상향 의존 없음).

## 1. Proxy Plane (C1)

### 1.1 요청 처리 파이프라인
```
수신(/v1/*) → Bearer 추출 → TokenResolver.resolve
  ├─ 미일치 → 401 OpenAI 오류 JSON (fail-closed, 로그엔 해시 프리픽스만)
  └─ agent 식별 → 업스트림 URL 재작성(base_url + 원경로) → 전달
       요청 본문 무변형(thin proxy), Authorization은 업스트림 키(api_key_env 참조)로 교체
       응답: 스트리밍(SSE)/논스트리밍 그대로 중계
       완료 시 TrafficSample 기록 + traffic.request 이벤트 (본문 비저장)
```
- 사용량 추출: 논스트림 → 응답 `usage` 필드 / 스트림 → 마지막 청크의 `usage`(있으면), 없으면 토큰 수 `null` (추정 금지 — E3 정직성)
- 타임아웃: connect 10s, 스트림 유휴(idle) 120s, 논스트림 총 600s (RESILIENCY-10; 설정 가능) — 초과 시 504
- 업스트림 연결 실패 → 502, OpenAI 호환 오류 스키마 `{error: {message, type, code}}` (내부 정보 비노출 — PU2-5 매핑 테이블)
- 경로 허용: `/v1/*`만. 그 외 404

### 1.2 업스트림 핫스왑 (S4)
`PUT /api/gateway/upstream` → UpstreamConfig 검증 → CaduceusConfigStore.save(원자적) → 프록시 클라이언트 원자적 교체(진행 중 요청은 구 클라이언트로 완주) → `upstream.changed` 이벤트. 에이전트 설정 변경 없음 (전 profile은 데몬 `/v1`만 바라봄)

## 2. Provisioner (C3)

- **직렬 실행**: 단일 asyncio 워커 큐 — CLI/Web UI 동시 요청 경합 제거. `POST /api/agents` 는 202 + job_id 즉시 반환
- **create 파이프라인** (JobStep 순서는 domain-entities.md): 각 단계 완료마다 `job.step` 이벤트. **registry-add는 프로필·설정·env가 모두 성공한 뒤** (FD7) → 이후 gateway-start(desired=running), health-wait(200 최대 60s)
- **실패 의미론 (E4)**: 실패 단계에서 즉시 중단, `job.failed`(redacted 사유 + 완료된 단계 목록). **자동 롤백 없음** — registry-add 이전 실패는 레코드 없음(고아 profile은 reconcile 감지), 이후 실패는 레코드 존재(사용자가 start 재시도 또는 rm --purge)
- **remove 파이프라인**: `X-Confirm` 필수(L4). purge=false면 profile-delete 단계 skip(soft) — 단 FD4 확정 의미론에 따라 **기본이 purge**(profile+컨테이너 삭제, 워크스페이스만 보존). purge 개념은 "워크스페이스 외 전부 정리"로 고정

## 3. Lifecycle & Health (C4)

### 3.1 start/stop
- start: 레코드 존재 확인 → `GatewayProcessManager.start(agent, hermes_adapter.gateway_argv(profile))` → desired_state=running 저장. crashlooping 상태에서 start = 카운터 리셋 재시도 (L6)
- stop (graceful, N4): api_server `GET /api/sessions`→활성 run 있으면 `POST /v1/runs/{id}/stop` best-effort(5s 예산) → `manager.stop` → desired_state=stopped 저장

### 3.2 health prober
- 주기 폴링(FD8) → 상태 전이 시 `health.changed` 이벤트 + 캐시 갱신. 프로세스 미기동 에이전트는 폴링 제외(`unknown`)

### 3.3 상태 합성 (PU2-1 oracle 테이블)

| desired | process | health probe | container | → AgentStatus 요약 |
|---|---|---|---|---|
| running | running | healthy | running | 정상 |
| running | running | unreachable/unhealthy | any | 프로세스는 살았으나 API 이상 (degraded) |
| running | crashlooping | — | any | crashlooping (사용자 개입 필요) |
| running | absent(미관리) | — | any | drift: 기동 필요 (reconcile 대상) |
| stopped | absent | — | exited/absent | 정상 정지 |
| stopped | running | — | any | drift: 정지 필요 (경고) |
| any | any | 조회 실패 | 조회 실패 | 해당 필드 unknown (E3) |

### 3.4 reconcile 루프 (S5)
주기(interval_s)마다: ① desired=running ∧ process absent → 재기동 1회 시도 + `drift.detected` ② 관리 config 드리프트(`diff_managed`) → `drift.detected`(경고만, G2 — 재적용은 명시 `apply`) ③ **고아 감지**: `~/.hermes/profiles/cad-*` ∉ 레지스트리 또는 라벨 `hermes-profile=cad-*` 컨테이너 ∉ 레지스트리 → `orphan.detected` (자동 삭제 금지 — L3 정신)

## 4. Admin API + Chat 중계 (C5)

- 인증 미들웨어: FD6 admin 토큰 (deny-by-default, 공개는 /healthz만). 실패 시 401 즉시 (본문 파싱 전)
- REST 계약: component-methods.md C5 경로 그대로. 입력은 pydantic 스키마 검증(SECURITY-05), 본문 크기 제한 1MB
- **chat 리버스 프록시**: `ANY /agents/{name}/api/{path:*}` → `http://127.0.0.1:<record.api_port>/{path}` + `Authorization: Bearer <record.api_server_key>` 부착. 허용 대상 경로: `v1/*`, `api/sessions*`, `health*` — 그 외 404. SSE/청크 스트리밍 무버퍼 중계, 클라이언트 절단 시 상류 요청 취소 (turn stop은 api_server의 `/v1/runs/{id}/stop` pass-through로 처리)
- WS `/api/events`: 접속 시 링버퍼 리플레이(최근 500) 후 실시간 구독
- `GET /healthz`(공개): 데몬 자체 liveness (RESILIENCY-06)

## 5. Daemon 조립·수명주기 (daemon.py)

```
startup:  config 로드(없으면 종료+init 안내) → admin.token 로드 → registry 로드(손상 시 fail-closed)
          → TokenResolver rebuild → 컴포넌트 조립(2-플레인 접점 3개만) → listen 바인드(이중 실행 차단)
          → desired=running 에이전트 자동 spawn (L7) → prober/reconciler 태스크 시작
shutdown: SIGTERM/SIGINT → 신규 요청 중단 → 활성 run stop best-effort → manager.shutdown (L1)
          → 이벤트 플러시 → exit 0
```

## 6. Testable Properties (PBT-01 — 코드 생성으로 전달)

| # | 대상 | 속성 | 카테고리 |
|---|---|---|---|
| PU2-1 | 상태 합성 | `synthesize()` 결과 == §3.3 진실 테이블 (전 입력 조합 생성) | Oracle |
| PU2-2 | TrafficStats | 카운터 단조 증가, totals == Σ per-agent, 링버퍼 ≤N·순서 보존 | Invariant |
| PU2-3 | Job 상태 기계 | 임의 이벤트 시퀀스에서 유효 전이만 발생, 단계 순서 고정 — 단순 모델 비교 | Stateful (PBT-06) |
| PU2-4 | chat 프록시 경로 | 대상 URL이 항상 `127.0.0.1:<port>` 베이스에 격납, 허용 프리픽스 외 거부, path traversal 불가 | Invariant (보안) |
| PU2-5 | 오류 매핑 | 업스트림 오류 클래스 → (HTTP status, error.type) 전사 테이블 일치 | Oracle |
| PU2-6 | EventBus 링버퍼 | 최근 N 보존·FIFO 순서·리플레이 == 발행 순서 | Invariant |
| — | 프록시 스트리밍 중계 | 부수효과 지배적 — example+통합 테스트로 커버 (PBT-10 근거) | N/A |
