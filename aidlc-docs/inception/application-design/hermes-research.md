# hermes 연구 스파이크 — 네이티브 동작과 한계

**Date**: 2026-07-02
**출처**: hermes 소스 (GitHub `NousResearch/hermes-agent`, shallow clone, 권위 있음) + 공식 문서 (hermes-agent.nousresearch.com/docs)
**목적**: requirements §7.1의 7개 영역에 대한 네이티브 동작·한계 파악 → D-a~D-e 결정 근거

> 파일 경로 인용은 hermes-agent 저장소 기준.

---

## 1. Profiles — 격리 경계

**출처**: `hermes_cli/profiles.py`, `hermes_constants.py`

- 각 profile은 **완전히 독립적인 HERMES_HOME 디렉터리** (`~/.hermes/profiles/<name>/`, default profile은 `~/.hermes` 자체):
  - 자체 `config.yaml`(모델·터미널·게이트웨이 설정), `.env`(크리덴셜), `SOUL.md`(persona), memories, sessions, skills, workspace, cron, logs, `home/`(컨테이너용 HOME)
- CLI: `hermes profile create <name>` (+`--clone` 설정 복사, `--clone-all` 전체 복사), `hermes profile use/delete`, `hermes -p <name> <cmd>`, profile별 wrapper alias 자동 생성
- profile 이름 규칙: `^[a-z0-9][a-z0-9_-]{0,63}$`
- **분리되는 것**: 설정, 크리덴셜(.env), persona, 메모리, 세션, 스킬, 워크스페이스, cron, 로그, 게이트웨이 상태
- **분리되지 않는 것**: hermes 코드/venv 자체(호스트 공유), 호스트 OS 환경(→ terminal backend가 담당)
- `home_mode: profile` 설정 시 tool 서브프로세스의 HOME도 `{HERMES_HOME}/home`으로 격리 가능

**결론**: F1(프로비저닝)·F2(독립 워크스페이스)·F7(skills/tools/persona per-agent)은 profiles로 **완전 네이티브 충족**. R1 후보 검증됨.

## 2. Terminal Backends — 실행 격리·영속성

**출처**: `cli-config.yaml.example`, `tools/environments/docker.py`, `tools/terminal_tool.py`

- 백엔드 6종: `local`, `ssh`, `docker`, `singularity`, `modal`, `daytona` — profile의 `config.yaml`의 `terminal:` 섹션으로 선택 (설정만으로 전환, P3 부합)
- **Docker 백엔드** (`DockerEnvironment`):
  - 하드닝 기본값: 모든 capability drop, no-new-privileges, PID 제한, 리소스 제한(`container_cpu/memory/disk`)
  - **영속성**: `container_persistent: true` 시 `~/.hermes/sandboxes/docker/<task_id>/`의 `home/`→`/root`, `workspace/`→`/workspace` 바인드 마운트. 컨테이너 자체도 라벨(`hermes-agent=1`, `hermes-task-id`, `hermes-profile=<name>`) 기반으로 **프로세스 횡단 재사용** (exited 상태면 `docker start`로 재기동, 삭제하지 않음)
  - **F3 충족 원리**: 컨테이너가 (task_id, profile) 단위로 장수(long-lived)하므로 `apt-get install`이 컨테이너 writable layer에 지속 + /root·/workspace는 바인드 마운트로 컨테이너 재생성에도 생존. 프로필별 컨테이너 분리로 상호 무영향
  - sandbox 경로는 HERMES_HOME 기준 → **profile별 sandbox 자동 분리**
  - `docker_extra_args`: `docker run`에 verbatim 플래그 추가 가능 (예: `--add-host=host.docker.internal:host-gateway`)
  - `docker_run_as_host_user`, `docker_forward_env`, `docker_volumes` 등 세부 제어
- **네트워킹**: 기본은 Docker bridge 네트워크 (`network: true`; `--network=none`도 가능). 컨테이너→호스트 도달:
  - macOS/Windows Docker Desktop: `host.docker.internal` 기본 제공
  - Linux: `docker_extra_args`로 `--add-host=host.docker.internal:host-gateway` 추가 (설정만으로 해결, 커스텀 코드 불요)
  - 대안: `--network=host` (격리 약화 트레이드오프)

**결론**: F3(환경 분리·지속)은 **profile별 docker backend + container_persistent로 완전 네이티브 충족**. F5(호스트 도달)는 bridge + host-gateway alias가 설정-온리 경로 (D-a 결정 필요: 호스트네임 `host.docker.internal` 사용 가능 여부).

## 3. Gateway / api_server — 프로그래매틱 대화 API

**출처**: `gateway/platforms/api_server.py` (4,892줄), `gateway/run.py`, `gateway/config.py`

- gateway는 메시징 플랫폼 통합 데몬 (`hermes gateway`). 플랫폼 어댑터 중 **`api_server`** 가 프로그래매틱 API:
  - `POST /v1/chat/completions` (OpenAI 호환, `X-Hermes-Session-Id`로 세션 연속성)
  - `POST /v1/responses` (stateful), `GET /v1/models`, `GET /v1/capabilities`
  - **세션 CRUD**: `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/{id}`, `/messages`, `/fork`
  - **`POST /api/sessions/{id}/chat[/stream]`** — 영속 세션과의 스트리밍 대화 (SSE)
  - **Runs**: `POST /v1/runs`(202 + run_id), `GET /v1/runs/{id}/events`(SSE 라이프사이클 이벤트), **`POST /v1/runs/{id}/stop`(turn 중단)**, `POST /v1/runs/{id}/approval`(승인 해결)
  - `GET /health`, `GET /health/detailed`
  - 스트리밍 이벤트에 **`reasoning.available`(thinking), `tool.started/completed/failed`(tool-call)** 포함
  - 인증: `API_SERVER_KEY` bearer, 포트/호스트/CORS는 `API_SERVER_PORT/HOST/CORS_ORIGINS` 또는 config (기본 `127.0.0.1:8642`)
- **멀티 프로필 서빙 — profile multiplexer** (`gateway.multiplex_profiles: true`):
  - **하나의 gateway 프로세스가 모든 profile을 서빙 가능**. default profile이 단일 리스너를 소유, `/p/<profile>/` URL 프리픽스로 라우팅
  - 턴 단위 `_profile_runtime_scope`: HERMES_HOME contextvar 오버라이드(config/skills/memory/SOUL/sessions) + secret scope(해당 profile `.env`만 노출, `os.environ` 비오염)
  - **한계 (중요)**: `TERMINAL_*` 설정은 gateway 시작 시 **default profile의 config.yaml에서 프로세스 전역 env로 브리지**됨 (`gateway/run.py` 모듈 로드 시). `tools/terminal_tool.py`는 `os.getenv("TERMINAL_ENV")`로 백엔드를 결정 → **multiplex 모드에서는 터미널 백엔드 종류/이미지 등이 모든 profile에 공유** (컨테이너 자체는 profile 라벨로 분리됨). profile별로 다른 docker 이미지/백엔드 설정이 필요하면 **profile별 gateway가 정도(正道)**
  - 포트 바인딩 플랫폼(api_server 등)은 multiplex 시 secondary profile에서 활성화하면 하드 에러 (default가 단독 소유)
- **profile별 gateway**: 각 profile은 자체 gateway 상태/서비스를 가짐. `hermes_cli/service_manager.py` — systemd(Linux)/launchd(macOS)/Windows Task/s6(컨테이너) 백엔드로 **per-profile gateway 서비스**(`gateway-<profile>`) 등록 지원

**결론**: F6(스트리밍·thinking·tool-call·세션 재개·turn 중단)은 api_server로 **완전 네이티브 충족**. F9의 health도 네이티브. 멀티 에이전트 서빙은 (a) profile별 gateway(포트 분리) 또는 (b) 단일 multiplexed gateway(터미널 설정 공유 한계) — **D-b 핵심 결정**.

## 4. Tool 실행 위치

**출처**: `tools/terminal_tool.py`, `tools/file_tools.py`, `tools/file_operations.py`, `toolsets.py`

- **terminal tool**: 선택된 backend 내부에서 실행 (docker면 컨테이너 안) ✓
- **file tools**: 동일 terminal environment를 통해 동작 (`ShellFileOperations` — docker backend면 컨테이너 내부 파일시스템 대상) ✓
- **browser/computer-use/이미지 생성 등**: 호스트 프로세스 또는 외부 서비스에서 실행 — **격리 경계 밖**. toolset 구성(`hermes tools`, profile config)으로 비활성화 가능
- toolset은 profile별 config으로 제어 (F7) — 대시보드 API `/api/tools/toolsets`도 존재

**결론**: 코어 작업 경로(터미널+파일)는 격리 경계 안. 경계 밖 tool은 profile별 toolset 축소로 통제 (D-c 연관). 설계 문서에 tool별 실행 위치 매트릭스 반영 필요.

## 5. 모델 라우팅 — 중앙 게이트웨이 연결

**출처**: `cli-config.yaml.example`, `hermes_cli/runtime_provider.py`, `agent/secret_scope.py`

- profile `config.yaml`:
  ```yaml
  model:
    provider: "custom"        # 모든 OpenAI 호환 엔드포인트
    base_url: "http://127.0.0.1:<caduceus-port>/v1"
    default: "<model-alias>"
  ```
  api_key는 profile `.env`(예: `OPENAI_API_KEY`) — **profile별 상이한 토큰 주입 가능** (multiplex 모드에서도 secret scope로 profile별 분리 유지)
- `default_headers`/`extra_headers`로 요청 헤더 커스텀 가능, `providers:` 맵으로 프로바이더별 타임아웃 제어
- 참고: hermes 자체 `hermes proxy`(`hermes_cli/proxy/`)는 "크리덴셜 부착 포워더"일 뿐 — 에이전트별 토큰 발급/식별, 중앙 제어(모니터링·감사·승인·버짓) 없음 → **R4(자체 게이트웨이) 요구를 대체 불가** (네이티브 대안 소진 확인, P2 근거)

**결론**: F4의 hermes 측 연결은 **설정만으로** 충족. Caduceus 게이트웨이가 OpenAI 호환 `/v1`을 노출하고 에이전트별 토큰을 식별하면 됨.

## 6. Dashboard — 네이티브 웹 UI

**출처**: `hermes_cli/web_server.py` (13,800+줄 FastAPI), `web/README.md`, `hermes_cli/dashboard_auth/`

- `hermes dashboard` → FastAPI 서버, 기본 `127.0.0.1:9119`, React SPA 서빙 (loopback 기본, N3 부합; 비-loopback 접근은 OAuth 게이트)
- **profile 관리 API 내장**: `GET/POST /api/profiles`, `DELETE /api/profiles/{name}`, `GET/PUT /api/profiles/{name}/soul`(persona 편집), `/model`, `/description`, `GET /api/profiles/sessions`(프로필 횡단 세션 목록)
- **skills/toolsets API**: `/api/skills`(toggle/content/생성), `/api/tools/toolsets`
- **임베디드 채팅**: `WS /api/pty?profile=<name>&resume=<session>` — 지정 profile로 `hermes chat`을 PTY로 스폰 (프로필별 대화 UI 네이티브 제공)
- 세션 조회/검색/삭제/내보내기, config/env 편집, gateway start/stop, cron, MCP, 로그, 분석(usage/models)까지 광범위
- 한계: 대시보드는 단일 HERMES_HOME(활성 profile) 중심 + profile 관리·횡단 조회 일부. Caduceus 게이트웨이(토큰·업스트림·버짓) 관리 UI는 당연히 없음

**결론**: F8은 물론, **F11(Web UI)의 상당 부분(프로비저닝·상태·대화·설정 편집)이 hermes dashboard로 네이티브 충족 가능** — D-d에서 "대시보드를 Caduceus의 Web UI로 채택할지" 결정 필요.

## 7. Approvals / 무인 운용 / 하드닝

**출처**: `tools/approval.py`, `gateway/platforms/api_server.py`(runs approval), `docs/` security

- 위험 명령 승인 시스템: 패턴 감지 + 세션별 승인 상태 + CLI 대화형/gateway 비동기 프롬프트 + 보조 LLM 스마트 승인 + config.yaml 영구 allowlist
- api_server의 run에서 approval pending 시 `POST /v1/runs/{id}/approval`로 해결 (프로그래매틱 승인 — Caduceus UI/CLI에서 중계 가능)
- `HERMES_YOLO_MODE`(모듈 임포트 시 고정 — 런타임 우회 방지), tirith 사전 실행 명령 스캐닝(옵트인)
- 컨테이너 하드닝 기본값(§2) + `security_audit` CLI 존재

## 8. 설계 함의 요약 (D-a~D-e 매핑)

| 결정 | 네이티브 경로 | 남는 선택지 |
|---|---|---|
| **D-a** (localhost 도달) | docker bridge + `docker_extra_args: --add-host=host.docker.internal:host-gateway` (Linux) / Docker Desktop 기본 (macOS). 셸·코드·브라우저 모두 도달 | `host.docker.internal` 호스트네임 수용 vs `--network=host`(격리 약화) vs 커스텀 포워딩(P2 위배 소지) |
| **D-b** (토폴로지·전송) | (a) profile별 gateway + api_server (포트 분리, per-profile 터미널 설정 완전 지원, systemd/launchd per-profile 서비스 네이티브) (b) 단일 multiplexed gateway (`/p/<name>/` 프리픽스, 터미널 설정 공유 한계) | a vs b vs 단계적 |
| **D-c** (풋프린트) | toolset 축소(설정), 컨테이너 리소스 제한(설정), scale_to_zero 모듈 존재(gateway) | 필요 시에만 |
| **D-d** (대시보드 통합) | hermes dashboard가 profile 관리+채팅+설정 편집 포함 | dashboard를 Caduceus Web UI로 채택 vs 별도 thin UI vs 하이브리드 |
| **D-e** (스택) | hermes는 Python 3.11+/FastAPI/aiohttp 생태계 | Caduceus도 Python 정렬이 자연스러움 (확정은 NFR 단계) |

**P2 기록 — 커스텀 도입이 불가피한 것 (네이티브 대안 소진 확인)**:
1. **중앙 AI-Gateway** (R4 사용자 확정): hermes `proxy`는 크리덴셜 포워더일 뿐 에이전트별 토큰·중앙 제어 없음 → Caduceus 자체 구현 정당
2. **에이전트 CRUD 오케스트레이션 CLI/glue**: `hermes profile` + config 쓰기 + 서비스 등록을 묶는 thin 계층 (각 단계는 hermes CLI/config 그대로 사용)
3. 그 외(채팅, 세션, 중단, health, 격리, persona/skills/toolsets, 대시보드)는 **전부 hermes 네이티브 경로 존재** — 재구현 금지
