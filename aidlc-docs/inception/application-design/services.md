# Caduceus — Services & Orchestration

**서비스 계층 원칙 (AD-5)**: 상주 프로세스는 `caduceusd` 하나. 내부는 Proxy Plane(데이터)과 Control Plane(제어)의 2-플레인으로 분리하고 명시적 내부 인터페이스로만 통신 — 향후 프로세스 분리 여지 확보. 감독(크래시 재시작)은 OS 서비스 매니저에 위임.

## 프로세스/서비스 지형

| 프로세스 | 소유 | 감독 | 포트 (기본, loopback) |
|---|---|---|---|
| `caduceusd` (proxy + control + Web UI) | Caduceus | systemd user / launchd | 1개 (예: 4285 — /v1, /api, SPA 동일 포트) |
| hermes gateway × 에이전트 수 (api_server 활성) | hermes | systemd user / launchd (`gateway-<profile>`) | 에이전트별 할당 (registry 기록) |
| docker 컨테이너 × 에이전트 수 | hermes(docker backend) | hermes terminal tool (라벨 재사용) | — |
| (옵션) hermes dashboard | hermes | 사용자 수동 (`hermes dashboard`) | 9119 |

## 오케스트레이션 플로우

### S1. 에이전트 생성 (F1/F2/F3)
1. CLI/Web UI → `POST /api/agents` (AgentSpec)
2. AdminAPI → Provisioner 큐 등록 (직렬), `job_id` 즉시 반환 (202)
3. Provisioner 단계 실행, 각 단계마다 EventBus → WS 진행률:
   a. validate (이름 규칙, 이미지 문자열, 포트 여유)
   b. `AgentRegistry.add` — 포트 할당 + 토큰 발급
   c. `HermesAdapter.create_profile`
   d. `write_model_routing` (base_url = `http://127.0.0.1:<caduceusd>/v1`)
   e. `write_terminal_config` (docker, `container_persistent: true`, network_mode 변환)
   f. `write_api_server_env` + `write_gateway_token`
   g. `ServiceManagerAdapter.register_agent_gateway` + start
   h. health wait (api_server `/health` 200 until timeout)
4. 실패 시: 단계별 오류 이벤트 + 수행된 단계 기록 (레지스트리에 `state=failed` 잔존 — 파괴적 자동 롤백은 하지 않음, 사용자에게 `rm --purge` 안내)

### S2. 대화 (F6)
1. Web UI/CLI → `ANY /agents/{name}/api/...` (caduceusd 단일 오리진)
2. AdminAPI 리버스 프록시: 대상 = `127.0.0.1:<agent_port>`, `Authorization: Bearer <API_SERVER_KEY>` 서버측 부착, SSE/WS 그대로 중계
3. 세션 생성/재개/이력/fork/stop/approval = **api_server 네이티브 엔드포인트 그대로** (Caduceus는 라우팅만)
4. 에이전트의 LLM 호출: hermes → `caduceusd /v1` (Bearer=agent 토큰) → 업스트림 → 스트림 백. TrafficEvent 발행

### S3. 라이프사이클 (F9)
- start/stop: AdminAPI → LifecycleManager → ServiceManagerAdapter.ctl → desired_state 갱신
- status: 레지스트리(desired) ⊕ 서비스 상태 ⊕ health probe ⊕ 컨테이너 상태(라벨 `hermes-profile=<name>` 조회) 합성
- graceful shutdown: stop 시 진행 중 run에 대해 api_server `POST /v1/runs/{id}/stop` 시도 후 서비스 정지 (N4)

### S4. 업스트림 교체 (F4)
1. `PUT /api/gateway/upstream` → caduceus config 갱신 (원자적) → Proxy Plane 핫 리로드
2. 에이전트 설정 변경 불필요 (모든 profile은 caduceusd만 바라봄) — **한 곳 교체 요구 충족**

### S5. Reconcile 루프 (N4/N5)
- 주기(기본 30s): 레지스트리 desired=running인데 서비스 inactive/failed → DriftEvent (+설정 시 재시작 시도 1회 — 반복 재시작은 OS 매니저 소관), health unreachable 연속 N회 → unhealthy 이벤트, 고아 리소스(라벨은 있는데 레지스트리에 없는 컨테이너/서비스) → 경고 이벤트
- 모든 판단은 이벤트로 노출 (자동 파괴 조치 없음)

### S6. 에이전트 설정 편집 (F7)
- soul/skills/toolsets: AdminAPI → HermesAdapter (파일/CLI) → 변경 후 해당 gateway 재시작 필요 여부 안내 이벤트

## 2-플레인 내부 인터페이스 (분리 가능 경계)

```
ControlPlane → ProxyPlane:  reload_upstream(cfg), invalidate_token_cache(agent)
ProxyPlane  → ControlPlane: EventBus.emit(TrafficEvent)   # 단방향, 비동기
공유:        AgentRegistry (읽기: Proxy는 resolve_token만)
```
이 3개 접점만 유지하면 향후 별도 프로세스 분리(IPC 치환) 가능.
