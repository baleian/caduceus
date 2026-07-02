# Caduceus — Component Methods (인터페이스 계약)

**Note**: 시그니처는 Python 3.11+ 타입 표기. 상세 비즈니스 규칙은 Functional Design(per-unit)에서 정의. 예외 계약: 모든 외부 호출 실패는 도메인 예외(`CaduceusError` 계열)로 변환 (SECURITY-15 fail-closed).

## 공통 타입 (발췌)

```python
AgentName = str  # ^[a-z0-9][a-z0-9_-]{0,63}$ (hermes profile 규칙과 동일)
NetworkMode = Literal["host", "bridge_hostgw", "none"]  # AD-2
DesiredState = Literal["running", "stopped"]

@dataclass(frozen=True)
class AgentSpec:      # 생성/편집 입력 (선언 상태)
    name: AgentName
    docker_image: str
    network_mode: NetworkMode = "host"
    cpu: float | None = None
    memory_mb: int | None = None
    disk_mb: int | None = None
    persona: str | None = None          # SOUL.md 초기 내용

@dataclass(frozen=True)
class AgentRecord:    # 레지스트리 저장 형태
    spec: AgentSpec
    profile_name: str
    api_port: int
    token_hash: str          # sha256; 평문은 profile .env에만 존재 (AD-6)
    desired_state: DesiredState
    created_at: str          # ISO 8601

@dataclass(frozen=True)
class AgentStatus:
    name: AgentName
    desired_state: DesiredState
    service: Literal["active", "inactive", "failed", "unregistered"]
    health: Literal["healthy", "unhealthy", "unreachable", "unknown"]
    container: Literal["running", "exited", "absent", "unknown"]
    detail: dict[str, Any]   # /health/detailed 발췌
```

## C1. ProxyPlane

```python
class ProxyPlane:
    async def handle(self, request: HTTPRequest) -> HTTPResponse: ...
        # /v1/* 전체. 401(토큰 불명), 502/504(업스트림 오류/타임아웃), SSE pass-through
    def resolve_agent(self, bearer: str) -> AgentName | None: ...   # Registry 위임, 해시 비교
    async def forward(self, agent: AgentName, request: HTTPRequest) -> HTTPResponse: ...
        # 업스트림 전달 + usage 메타 추출 → EventBus.emit(TrafficEvent)
```

## C2. AgentRegistry

```python
class AgentRegistry:
    def list(self) -> list[AgentRecord]: ...
    def get(self, name: AgentName) -> AgentRecord: ...              # KeyError → NotFound
    def add(self, spec: AgentSpec) -> tuple[AgentRecord, str]: ...  # (레코드, 평문 토큰 1회 반환)
    def update_spec(self, name: AgentName, patch: dict) -> AgentRecord: ...
    def set_desired_state(self, name: AgentName, state: DesiredState) -> None: ...
    def remove(self, name: AgentName) -> None: ...
    def resolve_token(self, bearer: str) -> AgentName | None: ...   # 상수시간 비교
    def rotate_token(self, name: AgentName) -> str: ...             # 새 평문 토큰 반환
    def allocate_port(self) -> int: ...                             # 사용중 포트 회피
    # 영속성: load()/save() 원자적 JSON, 스키마 버전 필드 포함 (round-trip PBT 대상)
```

## C3. Provisioner

```python
class Provisioner:
    async def create_agent(self, spec: AgentSpec) -> JobHandle: ...
        # 단계: validate → registry.add → hermes.create_profile → hermes.write_config
        #      → hermes.write_env(token, api_server) → svc.register → svc.start → health wait
    async def remove_agent(self, name: AgentName, *, purge: bool, confirmed: bool) -> JobHandle: ...
        # purge=True: 컨테이너+sandbox+profile 삭제. confirmed 필수 (파괴적)
    def get_job(self, job_id: str) -> JobStatus: ...
    # JobStatus: {id, kind, steps: [(name, state)], error?}; 진행은 EventBus로 스트림
```

## C4. LifecycleManager

```python
class LifecycleManager:
    async def start(self, name: AgentName) -> None: ...
    async def stop(self, name: AgentName) -> None: ...              # graceful (N4)
    async def status(self, name: AgentName | None = None) -> list[AgentStatus]: ...
    async def health(self, name: AgentName) -> AgentStatus: ...     # 즉시 probe
    async def logs(self, name: AgentName, *, follow: bool, lines: int) -> AsyncIterator[str]: ...
    async def reconcile_once(self) -> list[DriftFinding]: ...
    async def run_reconcile_loop(self, interval_s: float) -> None: ...  # 데몬 태스크
```

## C5. AdminAPI (REST/WS 표면 — 경로 계약)

```
GET    /api/agents                       → list[AgentStatus]
POST   /api/agents                       body=AgentSpec → {job_id}
GET    /api/agents/{name}                → AgentRecord+AgentStatus
PATCH  /api/agents/{name}                body=spec patch → {job_id | applied}
DELETE /api/agents/{name}?purge=bool     (X-Confirm 헤더 필수) → {job_id}
POST   /api/agents/{name}/start|stop     → 202
GET    /api/agents/{name}/logs?follow    → text/event-stream
GET    /api/agents/{name}/soul           → {content}          # C6 위임 (F7)
PUT    /api/agents/{name}/soul           body={content}
GET/PUT /api/agents/{name}/skills, /toolsets                  # C6 위임 (F7)
ANY    /agents/{name}/api/{path:*}       → 해당 api_server 리버스 프록시 (chat/sessions/runs/stop/approval)
GET    /api/gateway                      → {upstream, listen, agents_traffic_summary}
PUT    /api/gateway/upstream             body={base_url, api_key_env?, default_model?}
POST   /api/agents/{name}/token/rotate   → 204 (토큰은 .env에 재주입, 응답에 비포함)
GET    /api/jobs/{id}                    → JobStatus
WS     /api/events                       → StatusEvent|JobEvent|TrafficEvent|DriftEvent
GET    /                                  → SPA
```

## C6. HermesAdapter

```python
class HermesAdapter:
    def preflight(self) -> DoctorReport: ...                        # hermes/docker 존재·버전
    async def create_profile(self, name: str) -> None: ...          # `hermes profile create`
    async def delete_profile(self, name: str) -> None: ...          # `hermes profile delete`
    def write_model_routing(self, profile: str, base_url: str) -> None: ...
        # config.yaml: model.provider="custom", base_url, default 모델 alias
    def write_terminal_config(self, profile: str, spec: AgentSpec) -> None: ...
        # terminal.backend="docker", container_persistent=true, 이미지/리소스,
        # network_mode 변환: host → docker_extra_args ["--network=host"]
        #                bridge_hostgw → ["--add-host=host.docker.internal:host-gateway"]
        #                none → network=false
    def write_api_server_env(self, profile: str, port: int, key: str) -> None: ...
        # .env: API_SERVER_ENABLED/PORT/KEY (127.0.0.1 바인딩)
    def write_gateway_token(self, profile: str, token: str) -> None: ...  # .env: OPENAI_API_KEY
    def read_soul(self, profile: str) -> str: ...
    def write_soul(self, profile: str, content: str) -> None: ...
    def list_skills(self, profile: str) -> list[SkillInfo]: ...
    def set_skill_enabled(self, profile: str, skill: str, enabled: bool) -> None: ...
    def get_toolsets(self, profile: str) -> dict: ...
    def set_toolsets(self, profile: str, config: dict) -> None: ...
    async def gateway_ctl(self, profile: str, op: Literal["start","stop","status"]) -> str: ...
```

## C7. ServiceManagerAdapter

```python
class ServiceManagerAdapter(Protocol):   # 구현: SystemdUserBackend, LaunchdBackend
    def register_agent_gateway(self, profile: str) -> None: ...
    def unregister_agent_gateway(self, profile: str) -> None: ...
    def ctl(self, unit: str, op: Literal["start","stop","status","enable","disable"]) -> ServiceState: ...
    def register_caduceusd(self) -> None: ...
```

## C8. CLI 커맨드 계약 (발췌)

```
caduceus init [--service]                 # 홈 생성, 설정 마법사, (옵션) 데몬 서비스 등록
caduceus serve [--host 127.0.0.1 --port N]
caduceus doctor
caduceus agent create <name> [--image ..] [--network host|bridge|none] [--cpu ..] [--memory ..] [--persona file]
caduceus agent ls|status [<name>] [--json]
caduceus agent start|stop|rm [--purge] <name>
caduceus agent logs <name> [-f]
caduceus agent soul|skills|toolsets <name> [...]
caduceus chat <name> [--session <id> | --new] [--resume]   # 스트리밍, Ctrl+C=turn stop
caduceus gateway status|upstream get|upstream set <base_url> [--api-key-env VAR]
caduceus ui                                # 브라우저 오픈
```
