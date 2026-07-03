# Code Summary — 에이전트 터미널 host 네트워크 (gateway TERMINAL_* env 주입)

Requirements: [requirements.md](requirements.md) · Plan: [plan.md](plan.md) · Decisions Q1=A / Q2=A / Q3=A

## 문제 → 해결
hermes `terminal_tool._get_env_config()`는 터미널 백엔드·`docker_extra_args`·persistence를 **오직 `TERMINAL_*` env**에서 읽는데(없으면 backend=local, extra_args=[]), caduceus가 per-profile gateway를 띄울 때 `TERMINAL_*`를 주입하지 않아 `default` 샌드박스가 hermes 기본 **bridge**로 떴다. → caduceus가 gateway spawn 시 spec에서 파생한 `TERMINAL_*` env를 결정론적으로 주입하도록 수정.

## 변경 파일
| 파일 | 변경 |
|---|---|
| `caduceus/core/render.py` | `import json`; 순수 함수 **`terminal_env(spec, workspace_dir) → dict[str,str]`** 추가 — `managed_config`의 terminal 섹션과 동일 소스에서 `TERMINAL_ENV/DOCKER_IMAGE/DOCKER_EXTRA_ARGS/CONTAINER_PERSISTENT/MOUNT_CWD/CWD/DOCKER_VOLUMES` (+cpu/mem/disk 조건부) 생성. bool은 `"true"`, 리스트는 JSON 문자열. |
| `caduceus/core/hermes_adapter.py` | `terminal_env` import; **`gateway_env(spec, workspace_dir)`** 메서드 추가(`gateway_argv`와 짝, P1/P3 경계 유지). |
| `caduceus/core/process_manager.py` | `_Managed.env` 필드; `start(..., *, env=None)`; `_spawn`이 `spawn(argv, env=managed.env)` 전달 → **초기+backoff 재시작 공통 경로**라 재시작에도 유지(FR-4). |
| `caduceus/control/provisioner.py` | 최초 기동 `start(...)`에 `env=hermes.gateway_env(spec, state.workspace_dir)` 전달. |
| `caduceus/control/lifecycle.py` | `start()`에 `env=hermes.gateway_env(record.spec, record.workspace_dir)` 전달. |
| `caduceus/daemon.py` | startup 재조정 `start(...)`에 동일 env 전달. |

`ports.py`(spawner)·`ProcessSpawner` Protocol은 **이미 `env=` 지원** → 무변경. config.yaml 렌더(`managed_config`)도 그대로 유지(Q3=A) — 두 경로 동일 소스 파생.

## 테스트
| 파일 | 추가 |
|---|---|
| `tests/unit/test_render.py` | `terminal_env` host 매핑, network_mode별 extra_args, cpu/mem/disk 선택적. |
| `tests/property/test_render_properties.py` | **PBT**: 임의 spec에 대해 `terminal_env`↔`managed_config.terminal` 일관(extra_args JSON 디코드 == `network_extra_args`), 전값 문자열(totality), 리소스 키 조건부. |
| `tests/unit/test_process_manager.py` | `FakeSpawner.envs` 기록; 초기 spawn env 전달 + **재시작 시 저장 env 재사용**. |
| `tests/unit/test_provisioner_lifecycle.py` | `FakeManager`가 `env=` 수용/기록; happy-path에서 spec 기반 `TERMINAL_ENV=docker`/`--network=host`/`cwd` 전달 확인(실 HermesAdapter 경유, AC-5). |

## 검증 결과
- **ruff**: clean · **mypy(strict, 43 files)**: Success · **pytest**: **494 passed, 4 deselected**(실-hermes/docker 통합).
- **실기 실증(AC-1)**: `terminal_env(host spec)`가 만든 env를 **설치된 hermes `_get_env_config()`**에 주입 → `env_type=docker`, `docker_extra_args=['--network=host']`, `container_persistent=True`, `cwd=/workspace`, `host_cwd=<workspace>`로 해석 확인. 이후 hermes `DockerEnvironment`가 `docker_extra_args`를 `docker run`에 verbatim 부착(docker.py) → 컨테이너 `NetworkMode=host`. 전체 고리 검증됨.
- (앱 레벨 e2e: 사용자 환경 재구축 후 새 host 에이전트 생성 → `docker inspect <default sandbox> -f '{{.HostConfig.NetworkMode}}'`=`host` 확인 권장.)

## 범위 밖 (후속)
- `prompt-backend-probe` 컨테이너 정리(Q1=A). 이번 결과로 에이전트당 컨테이너는 여전히 2개지만 **둘 다 `network_mode` 반영**(probe도 같은 env 공유 → host). 클러터 제거는 별도 개선(caduceus reaper 등).
