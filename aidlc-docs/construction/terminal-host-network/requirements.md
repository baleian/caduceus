# Requirements — 에이전트 터미널 host 네트워크 (gateway TERMINAL_* env 주입)

## Intent Analysis
- **User request**: 에이전트의 `default` 터미널 샌드박스가 정상적으로 spec의 `network_mode`(현재 목표 에이전트는 `host`) 도커 컨테이너로 뜨게 한다. `container_persistent`는 `true` 유지.
- **Request type**: Bug Fix (기존 gateway 실행 경로의 터미널 네트워크 설정 누락)
- **Scope**: Single Component 중심 — `caduceus/core/`(render, hermes_adapter, process_manager) + gateway spawn 호출부(provisioner / lifecycle / daemon startup)
- **Complexity**: Moderate
- **Decisions**: Q1=A (이번 범위는 네트워크 수정만; `prompt-backend-probe` 정리는 후속 분리), Q2=A (`spec.network_mode` 반영), Q3=A (config.yaml 유지 + env 주입 추가)

## 근본 원인 (확정)
1. hermes `terminal_tool._get_env_config()`는 터미널 백엔드·`docker_extra_args`·`container_persistent`·이미지·cwd를 **오직 `TERMINAL_*` 환경변수**에서 읽는다(없으면 backend=`local`, extra_args=`[]` 폴백). config.yaml을 직접 읽지 않는다.
2. `_probe_remote_backend`(prompt_builder.py)도 동일하게 `_get_env_config()`를 사용 → probe와 terminal은 같은 `TERMINAL_*` env를 공유한다.
3. caduceus `GatewayProcessManager`는 gateway(`hermes -p <profile> gateway`)를 띄울 때 **`TERMINAL_*` env를 주입하지 않는다**. 그래서 터미널 네트워킹이 hermes의 불안정한 config→env 브리지에 의존 → `default` 샌드박스가 bridge로 떴다.
4. spawner(`RealProcessSpawner.spawn`)와 `ProcessSpawner` Protocol은 **이미 `env=` 파라미터를 지원**한다 — 현재 `GatewayProcessManager`가 사용하지 않을 뿐.

## Functional Requirements
- **FR-1**: caduceus가 에이전트 gateway를 spawn할 때, 해당 에이전트 spec에서 파생한 `TERMINAL_*` 환경변수를 프로세스 env로 주입한다. 최소 집합:
  - `TERMINAL_ENV=docker`
  - `TERMINAL_DOCKER_IMAGE=<spec.docker_image>`
  - `TERMINAL_DOCKER_EXTRA_ARGS=<json(network_extra_args(spec.network_mode))>` (host→`["--network=host"]`, bridge_hostgw→`["--add-host=host.docker.internal:host-gateway"]`, none→`["--network=none"]`)
  - `TERMINAL_CONTAINER_PERSISTENT=true`
  - `TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE=true`
  - `TERMINAL_CWD=<workspace_dir>` (호스트 워크스페이스 경로)
  - `TERMINAL_DOCKER_VOLUMES=[]` (config의 `docker_volumes: []`와 동일 의미 — hermes cwd 자동 마운트 억제 방지)
  - `spec.cpu/memory_mb/disk_mb`가 지정된 경우 `TERMINAL_CONTAINER_CPU/MEMORY/DISK` 동반
- **FR-2**: 주입되는 `TERMINAL_*` 값은 `managed_config`의 `terminal` 섹션과 **동일한 단일 소스에서 파생**되어야 한다(config.yaml과 env가 절대 어긋나지 않음).
- **FR-3**: `network_mode`를 그대로 반영한다(강제 host 금지) — AD-2의 에이전트별 격리 옵션 유지.
- **FR-4**: gateway **재시작(backoff-restart) 경로에서도** 동일한 env가 적용되어야 한다(초기 spawn과 재시작 spawn 모두).
- **FR-5**: 모든 gateway spawn 진입점(프로비저닝 최초 기동 / lifecycle start / daemon startup 재조정)에서 일관되게 주입한다.
- **FR-6**: config.yaml의 `terminal.*` 렌더는 현행 유지(Q3=A) — `hermes chat`·대시보드 PTY 등 직접 경로 호환.

## Non-Functional / Constraints
- **P1/P3 경계**: hermes는 어댑터·설정으로만 접촉. hermes 소스 패치 없음. env 매핑은 hermes의 `TERMINAL_*` 규약을 그대로 사용.
- **Resiliency Baseline**: env 파생 함수는 순수·전역(total) — spec 필드 조합 전체에서 예외 없이 문자열 dict 반환. 알 수 없는 `network_mode`는 기존 `network_extra_args`의 `DomainValidationError` 재사용.
- **Security Baseline**: 주입 값(이미지·네트워크·cwd·persistent·리소스)에는 시크릿이 없다. 게이트웨이 토큰 등 시크릿은 계속 `.env`/config 경로로만 흐르며 env 주입 대상 아님. 로그에 env 값 덤프 금지(비시크릿이지만 원칙 유지).
- **Property-Based Testing**: `terminal_env` 매핑에 속성 테스트 추가(아래 Acceptance 참조).

## Out of Scope (후속)
- `prompt-backend-probe` 컨테이너 정리(reap) — Q1=A로 이번 범위 제외. 결과적으로 에이전트당 컨테이너 2개(둘 다 `network_mode` 반영)로 유지됨. 별도 개선으로 분리.

## Acceptance Criteria
- **AC-1**: 새 에이전트(`network_mode=host`) 생성 후 첫 터미널 사용 시 `default` 샌드박스가 `NetworkMode=host`로 뜬다(수동/실기 검증).
- **AC-2**: `terminal_env(spec, ws)`의 값이 `managed_config(...).terminal`과 일관됨을 보이는 PBT: 임의 spec에 대해 `TERMINAL_DOCKER_EXTRA_ARGS`를 json 디코드하면 `network_extra_args(spec.network_mode)`와 같고, 이미지/persistent/cwd가 일치.
- **AC-3**: `terminal_env`는 모든 `network_mode`(host/bridge_hostgw/none) 및 cpu/memory/disk None·값 조합에서 예외 없이 문자열 dict 반환(totality).
- **AC-4**: `GatewayProcessManager`가 초기 spawn과 재시작 spawn 모두에서 저장된 env를 spawner에 전달함을 단위 테스트로 확인.
- **AC-5**: 3개 호출부가 spec 기반 env를 start에 전달함을 확인.
- **AC-6**: ruff / mypy(strict) / pytest 전량 통과, 회귀 없음.
