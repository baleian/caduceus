# Code Generation Plan — 에이전트 터미널 host 네트워크 (gateway TERMINAL_* env 주입)

Requirements: [requirements.md](requirements.md) · Decisions Q1=A / Q2=A / Q3=A

## 설계 요약
- 터미널 설정의 단일 소스는 `render.managed_config(...).terminal`. 여기서 파생한 **순수 함수 `render.terminal_env(spec, workspace_dir) → dict[str,str]`**를 새로 만들어 `TERMINAL_*` env를 생성한다(config.yaml과 항상 일치, FR-2).
- `HermesAdapter.gateway_env(spec, workspace_dir)`가 이 함수를 감싸 노출(P1/P3 — hermes 접촉은 어댑터로). `gateway_argv`와 짝.
- `GatewayProcessManager.start(agent, argv, *, env=None)`가 env를 `_Managed`에 저장하고 초기/재시작 spawn 모두 `spawner.spawn(argv, env=env)`로 전달(FR-4). spawner/Protocol은 이미 `env=` 지원 → 변경 불필요.
- 3개 호출부(provisioner/lifecycle/daemon startup)가 `hermes.gateway_env(record.spec, record.workspace_dir)`를 넘긴다(FR-5).

## Steps

### S1 — `render.terminal_env` 순수 함수 추가
- [x] `caduceus/core/render.py`에 `terminal_env(spec: AgentSpec, workspace_dir: str) -> dict[str, str]` 추가.
- [x] `managed_config`의 terminal 값과 동일 소스로 매핑: `TERMINAL_ENV=docker`, `TERMINAL_DOCKER_IMAGE`, `TERMINAL_DOCKER_EXTRA_ARGS=json.dumps(network_extra_args(spec.network_mode))`, `TERMINAL_CONTAINER_PERSISTENT=true`, `TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE=true`, `TERMINAL_CWD=workspace_dir`, `TERMINAL_DOCKER_VOLUMES=[]`(json).
- [x] cpu/memory_mb/disk_mb가 not None이면 `TERMINAL_CONTAINER_CPU/MEMORY/DISK` 문자열로 동반(형식은 hermes `_parse_env_var` 기대치: cpu=float-parseable, memory/disk=int).
- [x] hermes bool env 규약("true"/"false" 소문자) 및 JSON 문자열 규약 준수.

### S2 — `HermesAdapter.gateway_env` 노출
- [x] `caduceus/core/hermes_adapter.py` import에 `terminal_env` 추가.
- [x] `gateway_argv` 인접에 `def gateway_env(self, spec: AgentSpec, workspace_dir: str) -> dict[str, str]: return terminal_env(spec, workspace_dir)` 추가(문서 주석에 "TERMINAL_* 브리지" 근거 명시).

### S3 — `GatewayProcessManager` env 스레딩(재시작 안전)
- [x] `_Managed`에 `env: dict[str, str] | None = None` 필드 추가.
- [x] `start(self, agent, argv, *, env: dict[str, str] | None = None)` — `_Managed(agent=..., argv=..., env=env)` 저장.
- [x] `_spawn`에서 `self._spawner.spawn(managed.argv, env=managed.env)`로 전달(초기+backoff 재시작 공통 경로이므로 재시작에도 자동 적용, FR-4).

### S4 — 호출부 3곳에서 env 주입
- [x] `control/provisioner.py:165` — 최초 기동: `start(spec.name, hermes.gateway_argv(profile), env=hermes.gateway_env(spec, workspace_dir))`. provisioner가 보유한 spec/workspace 경로 사용(필드명 확인 후 반영).
- [x] `control/lifecycle.py:91` — `record`에서 spec/workspace_dir 취득하여 env 전달.
- [x] `daemon.py:104` — startup 재조정 spawn에도 동일 전달.
- [x] (검증) reconciler 등 다른 `manager.start` 호출부가 있으면 동일 처리(grep로 재확인).

### S5 — 테스트
- [x] `tests/unit`(또는 기존 render 테스트 파일)에 `terminal_env` 단위 테스트: host/bridge_hostgw/none 각각의 `TERMINAL_DOCKER_EXTRA_ARGS`, 이미지/persistent/cwd/mount 값.
- [x] `tests/property`에 PBT(AC-2/AC-3): 임의 spec에 대해 (a) `TERMINAL_DOCKER_EXTRA_ARGS` json 디코드 == `network_extra_args(spec.network_mode)`, (b) `managed_config().terminal`과의 일관성(image/persistent/cwd), (c) 전 조합 totality(예외 없음, 전부 str).
- [x] `GatewayProcessManager` 테스트(AC-4): fake spawner가 초기 spawn과 **재시작 spawn** 모두에서 주입 env를 기록하는지.
- [x] 호출부 테스트(AC-5): spec 기반 env가 start까지 전달되는지(기존 provisioner/lifecycle/daemon 테스트에 편승 또는 신규).

### S6 — 정적검사 + 실기 검증
- [x] `ruff check` / `mypy`(strict) / `pytest` 전량 통과(AC-6).
- [x] 실기 검증(AC-1): 데몬 기동 → 새 에이전트(host) 생성 → 터미널 사용 유발 → `docker inspect <default sandbox> -f '{{.HostConfig.NetworkMode}}'` == `host` 확인. (사용자 환경에서 수행; 절차/명령 문서화)

### S7 — 문서/상태
- [x] `code-summary.md` 작성(변경 파일·결정·검증 결과).
- [x] plan.md 체크박스 전부 [x], `aidlc-state.md` 갱신, `audit.md` 기록.

## Extension 준수
- **Resiliency**: `terminal_env`는 total 순수 함수(예외 경로는 기존 `network_extra_args`의 도메인 검증 재사용). 재시작 경로 env 유지(FR-4).
- **Security**: 주입 값에 시크릿 없음. 시크릿은 `.env`/config 경로 유지. env 값 로그 덤프 금지.
- **PBT**: S5의 속성 테스트(AC-2/AC-3)로 충족.
