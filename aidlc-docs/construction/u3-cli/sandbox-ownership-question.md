# 샌드박스 파일 소유권 — 네이티브 설정 조사 결과 및 결정 요청

**Date**: 2026-07-03
**배경**: `agent rm` 실패(프로필 내 root 소유 샌드박스 파일) 대응으로 sandboxes-scrub 단계를 추가했으나, 사용자가 네이티브 대안 조사를 요청.

## 조사 결과 (hermes 소스 확정)

hermes에 **정확히 이 문제를 위한 네이티브 설정이 존재합니다**:

```yaml
terminal:
  docker_run_as_host_user: true   # env: TERMINAL_DOCKER_RUN_AS_HOST_USER
```

- 구현: `tools/environments/docker.py` — 컨테이너를 `--user <호스트uid>:<호스트gid>`로 기동
- 소스 주석 원문: *"run the container as the host user so files written into bind-mounted dirs (/workspace, /root, docker_volumes entries) are owned by that user on the host instead of by root"*
- 이 설정이 켜지면 샌드박스·워크스페이스에 쓰인 모든 파일이 호스트 사용자 소유 → `hermes profile delete`가 네이티브로 성공 → **scrub 단계 불필요**
- 참고: PUID/PGID·HERMES_UID/HERMES_GID는 hermes 자체를 컨테이너로 배포할 때(docker compose)의 변수로, 터미널 샌드박스와 무관

## 트레이드오프 (결정 필요)

`--user`로 기동하면 컨테이너 안에서 **root가 아니므로 `apt-get install`이 불가**합니다.
이는 요구사항 **F3(환경 격리 — 에이전트별 apt-get 등 지속)**과 충돌합니다. hermes가 기본값을 root(false)로 둔 것도 같은 이유로 보입니다 (대신 root 모드에는 cap-drop 하드닝 적용).

pip/npm 등 사용자 레벨 설치는 host-user 모드에서도 동작합니다. 영향 범위는 시스템 패키지 설치(apt-get)뿐입니다.

## Question 1: 샌드박스 실행 사용자 기본값

A) **host-user 기본 + root 옵트인 (권장)** — `docker_run_as_host_user: true`를 관리 키 기본으로 렌더. root가 필요한 에이전트만 `agent create --system-packages`(가칭)로 옵트인 → 해당 에이전트만 root 모드. **scrub 단계는 root 옵트인 에이전트의 rm에만 실행**(host-user 에이전트는 네이티브 삭제). F3은 옵트인 기능으로 유지

B) **root 기본 유지 (hermes 기본과 동일) + scrub 유지** — F3(apt-get)이 기본 동작. scrub 단계는 root 모드의 구조적 결과를 정리하는 필수 단계로 문서화. per-agent `--host-user` 옵트인 추가

C) **host-user 전면 전환 + scrub 제거** — apt-get 요구(F3)를 요구사항에서 제외(pip/npm으로 충분하다고 판단 시). 가장 단순한 파이프라인

[Answer]: C

---

## 개정 결정 (2026-07-03, 사용자 지시)

**option C 철회 → root 백엔드 복귀.** host-user 모드 운용 결과 `apt-get` 불가가 실사용에서 불편했고, 실환경 테스트에서 **host-user 설정과 무관하게 `sandboxes/*/home/.hermes/skills`만 root 소유로 남아 삭제가 실패**하는 현상이 확인됨.

### 근본 원인 (hermes 소스로 확정)

`rm -rf`가 **skills에서만** 실패한 것이 결정적 단서였다:

1. hermes는 샌드박스 home을 컨테이너 `/root`에 bind (`docker.py:682`)
2. **추가로** 프로필 `skills/`를 컨테이너 `/root/.hermes/skills:ro`에 중첩 bind (`credential_files.py:203`, cache 디렉토리들도 `/root/.hermes/*`에 동일 패턴)
3. 중첩 마운트포인트가 없으면 **root로 도는 dockerd가 호스트 쪽** (`<sandbox>/home/.hermes/skills`)에 **mkdir** → root 소유 0755 디렉토리 잔류
4. 즉 이 잔여물은 **컨테이너가 명령 한 줄 실행하지 않아도** (probe 샌드박스 포함) 컨테이너 기동만으로 생기며, `docker_run_as_host_user`(컨테이너 **프로세스**의 uid만 변경)로는 막을 수 없다 — host-user 전환이 재발을 못 막은 이유

### 채택한 구조 (3중 방어)

1. **원천 차단**: 관리 config `docker_extra_args`에 `--tmpfs /root/.hermes:rw,exec,size=64m` — 중첩 bind 마운트포인트가 tmpfs 안에서 생성되어 호스트에 실체화되지 않음 (skills/cache bind 자체는 각자 호스트 디렉토리로 정상 연결)
2. **감지 후 조건부 스크럽**: rm 파이프라인 `sandbox-scrub` 단계 — 프로필 트리 uid 스캔에서 외부 소유 파일이 **발견될 때만** 에이전트 자신의 이미지를 빌려 `docker run --entrypoint chown -R <uid>:<gid>`. 깨끗한 트리에서는 no-op (docker 엔진 차용 최소화)
3. **순서 보장**: 스크럽을 native delete **앞에** 배치 — 삭제가 트리 중간에서 EACCES로 죽으면 config.yaml만 사라진 반토막 프로필이 남는 것을 구조적으로 방지

트레이드오프: root 백엔드이므로 에이전트가 `/workspace`(bind)에 쓴 파일은 호스트에서 root 소유일 수 있음 — 워크스페이스는 삭제 파이프라인 밖(L3 보존)이라 rm은 막지 않으며, 필요 시 동일 chown 스크럽으로 정리 가능.

---

## 최종 결정 (2026-07-03, 사용자 지시): rootless docker 전환

setgid+umask 설계로 UX는 충족했으나, 사용자 판단으로 **구조적으로 가장 깨끗한 rootless docker**를 채택하고 모든 workaround 코드를 제거한다.

**rootless에서 apt-get?** 가능 — 컨테이너 네임스페이스 안에서 uid 0은 여전히 완전한 root이며(dpkg/apt 정상), 호스트 매핑만 daemon 소유 사용자(uid 0→사용자, 그 외→subuid)로 바뀐다. 산출물 소유 문제가 매핑 수준에서 소멸.

**적용 구조**:
- `docker.host` 설정(예: `unix:///run/user/1000/docker.sock`) → 데몬 자신의 docker 호출(HermesAdapter)과 모든 hermes 게이트웨이 자식 프로세스(GatewayProcessManager)에 DOCKER_HOST로 주입
- preflight `docker-rootless` 체크: rootful 데몬이면 에이전트 생성 거부(workaround 제거의 안전장치)
- 제거된 workaround: sandbox-scrub 단계(+scrub_ownership/undeletable_paths), `/root/.hermes` tmpfs, `BASH_ENV`/umask 002/mktemp shim 시딩, workspace 2770 setgid(0700 복귀·재사용 시 정규화)
- 유지: `.profile` PATH 시딩(/usr/games — Debian games 섹션 정책, 소유권과 무관한 별개 수정)

**전제조건**: uidmap 패키지(newuidmap/newgidmap, setuid) — 이 박스에서 유일한 미충족 항목(sudo 필요). 나머지(dockerd-rootless-setuptool.sh, slirp4netns, /etc/subuid·subgid, systemd --user)는 확인 완료. 기존 rootful 데몬과 공존(소켓 분리) — 다른 docker 사용에 영향 없음.

**알려진 트레이드오프**: (1) rootless 스토리지 분리로 이미지 재-pull 1회, (2) cgroup 위임이 없으면 cpu/memory 제한이 무시될 수 있음(WSL2 기본 하이브리드 cgroup — 에이전트 생성의 옵션 기능, 기본 플로우 무영향), (3) `--add-host=host.docker.internal:host-gateway`의 호스트 루프백 도달은 slirp4netns 설정(`--allow-host-loopback`) 필요할 수 있음 — 필요 시 서비스 env로 조정.
