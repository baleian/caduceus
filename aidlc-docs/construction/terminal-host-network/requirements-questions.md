# Requirements Verification — 에이전트 터미널 host 네트워크 + probe 컨테이너 정리

## Intent Analysis
- **User request**: 에이전트의 `default` 터미널 샌드박스가 정상적으로 `--network=host` 도커 컨테이너로 뜨게 한다. `container_persistent`는 `true` 유지. 추가로, 에이전트당 컨테이너가 여러 개(특히 `prompt-backend-probe`) 지속적으로 떠 있는 것을 정리하고 싶다.
- **Request type**: Bug Fix / Enhancement (기존 gateway 실행 경로 수정)
- **Scope**: Single Component 중심 — `caduceus/core/`(process_manager, render, hermes_adapter, ports) + 3개 spawn 호출부(provisioner/lifecycle/daemon)
- **Complexity**: Moderate

## 확정된 근본 원인 (조사 완료 — 참고용)
- hermes `terminal_tool._get_env_config()`는 터미널 백엔드·`docker_extra_args`·`container_persistent`를 **오직 `TERMINAL_*` 환경변수**에서 읽는다. 없으면 backend=`local`, extra_args=`[]`로 폴백.
- caduceus는 gateway(`hermes -p <profile> gateway`)를 띄울 때 **`TERMINAL_*` env를 주입하지 않아서**, 터미널 네트워킹이 hermes의 불안정한 config→env 브리지에 의존 → `default`가 bridge로 뜬 것.
- **수정 방향(확정적)**: caduceus가 gateway spawn 시 spec에서 파생한 `TERMINAL_*` env(최소 `TERMINAL_ENV=docker`, `TERMINAL_DOCKER_EXTRA_ARGS`, `TERMINAL_DOCKER_IMAGE`, `TERMINAL_CONTAINER_PERSISTENT`, `TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE`, `TERMINAL_CWD`)를 결정론적으로 주입한다. 주입 지점(`ports.py` spawner `env=`)은 이미 존재.
- `prompt-backend-probe`는 hermes가 docker 백엔드일 때 프롬프트 빌드 중 항상 띄우는 내부 probe이며, config 토글로 끌 수 없고 persistent 여부가 terminal과 묶여 있음(같은 `TERMINAL_CONTAINER_PERSISTENT`). 따라서 "정확히 1 컨테이너"는 코드 개입이 필요.

---

## Q1. `prompt-backend-probe` 컨테이너를 이번 범위에서 어떻게 다룰까?
설정만으로는 "default는 지속 / probe만 휘발" 분리가 불가능하다(둘이 같은 env 공유, probe 비활성 토글 없음). 선택지:

- **A)** 이번 변경은 **네트워크 수정에만 집중**한다(`default`→host, persistent 유지). `prompt-backend-probe`는 그대로 둔다(그 결과 그것도 host+persistent → 에이전트당 2개 컨테이너). 정리는 별도 후속 과제로 분리.
- **B)** 네트워크 수정 **+ caduceus가 `prompt-backend-probe` 샌드박스를 정리(reap)**한다. `HermesAdapter`에 라벨(`hermes-task-id=prompt-backend-probe`) 기반 정리 메서드를 추가하고 reconciler/프로비저닝 이후 훅에서 호출. 정상 상태에선 사라지되 gateway 재시작 직후 잠깐 재생성될 수 있음(주기적 sweep으로 수렴). P1/P3(“hermes는 어댑터/설정으로만 접촉”) 경계 안에서 구현.
- **C)** Other (please describe after [Answer]:)

**권장**: 주 목표(호스트 네트워크)를 먼저 확실히 착지시키려면 A가 단순·안전. 컨테이너 클러터가 실사용에 계속 거슬리면 B를 후속으로. 한 번에 깔끔히 원하면 B.

[Answer]: A

---

## Q2. 터미널 샌드박스의 네트워크를 무엇에 맞출까?
- **A)** 에이전트 `spec.network_mode`를 그대로 반영: `host`→`--network=host`, `bridge_hostgw`→`--add-host=host.docker.internal:host-gateway`, `none`→`--network=none`. AD-2의 에이전트별 격리 옵션을 터미널 샌드박스까지 일관 적용. (이 에이전트는 `host`라 목표 달성 + 다른 에이전트의 격리 옵션도 보존)
- **B)** 항상 `--network=host` 강제(`network_mode` 무시)
- **C)** Other (please describe after [Answer]:)

**권장**: A (기존 설계 AD-2 유지, 현재 목표도 그대로 충족).

[Answer]: A

---

## Q3. config.yaml의 터미널 키(`docker_extra_args` 등)를 계속 유지할까?
env 주입이 gateway 경로의 권위 소스가 되면 config.yaml의 `terminal.docker_extra_args`는 gateway 터미널에는 사실상 중복이 된다. 다만 config.yaml은 `hermes` CLI 직접 경로(예: `hermes chat`, 대시보드 PTY)에도 쓰인다.

- **A)** config.yaml 렌더는 지금처럼 유지하고 env 주입을 **추가**한다(두 경로 모두 동일 소스에서 파생되어 항상 일치). (권장 — 안전, 회귀 위험 최소)
- **B)** env 주입만 하고 config.yaml의 터미널 network 키는 제거한다.
- **C)** Other (please describe after [Answer]:)

[Answer]: A
