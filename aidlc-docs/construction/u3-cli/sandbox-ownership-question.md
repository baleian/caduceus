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
