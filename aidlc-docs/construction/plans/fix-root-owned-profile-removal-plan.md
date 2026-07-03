# Code Generation Plan — 에이전트 삭제 실패(root 소유 프로필 아티팩트) 근본 해결

**Stage**: CONSTRUCTION / Code Generation (버그 수정)
**Units touched**: U1 C6 `HermesAdapter` (`caduceus/core/hermes_adapter.py`), U2 C3 `Provisioner` (`caduceus/control/provisioner.py`)
**Scan/Application/Functional/NFR Design**: 스킵 (기존 컴포넌트 경계 내, 새 데이터 모델·컴포넌트 없음)

---

## 1. 문제 요약

에이전트 제거 파이프라인(`gateway-stop → containers-remove → profile-delete → registry-remove`)이
`profile-delete`에서 exit 1로 실패한다. 원인은 hermes docker 샌드박스(백엔드 probe 포함)가
컨테이너를 **root로 실행**하며 프로필 안에 `root:root` 소유 디렉터리를 남기기 때문이다.
호스트 데몬은 비-root 사용자(`beom`)로 돌기 때문에 `hermes profile delete`의 `rmtree`/`chmod`가
권한 부족으로 실패한다. (표면의 `onexc` TypeError는 무관 — hermes가 이미 폴백 처리하는 연쇄 예외의 첫 고리.)

## 2. 핵심 충돌 — 이건 "추가"가 아니라 "결정 되돌리기"

root 소유 파일을 비-root가 정리하려면 방법은 둘뿐이다:
- (a) 호스트 `sudo` — 데몬 자동화 불가.
- (b) **권한 있는 docker 컨테이너로 chown/rm** — Docker 데몬이 root라 자기가 만든 root 파일을 정리 가능.

(b)가 유일한 자동화 경로인데, 이것은 다음 **기존 승인 결정**을 뒤집는다:
- `test_remove_pipeline_has_no_privileged_scrub` — 제거 파이프라인 4단계 고정 + `chown` 금지.
- `test_managed_config_renders_plain_root_backend` — 샌드박스는 container root(=`apt` 동작), 소유권 우회책 금지.
- `aidlc-state.md`: "알려진 회귀(승인됨): rootful 데몬 artifacts 호스트 소유권".

따라서 진행하려면 이 결정의 **명시적 재승인**이 필요하다.

## 3. 구현 이미지 선택 (결정됨, 질문 아님)

chown 컨테이너 이미지는 `record.spec.docker_image`(그 에이전트가 실제로 쓰던 이미지)를 재사용한다.
→ 로컬에 이미 pull돼 있어 네트워크/추가 이미지 의존성 없음. argv 배열 호출이라 명령 주입 없음(SECURITY 준수).
chown 명령: `docker run --rm -v <profile_dir>:/target <image> chown -R <uid>:<gid> /target`
(`<uid>/<gid>`는 `os.getuid()/os.getgid()`).

---

## 결정 질문

### Q1. 권한 스크럽 재도입 방식 — 기존 "no privileged scrub" 결정을 어떻게 처리할까?

- **A) Lazy 복구 (권장)**: 평상시 파이프라인은 그대로 4단계. `profile-delete`가 실패하면 **그때만**
  chown 복구 컨테이너를 1회 실행하고 delete를 1회 재시도. 성공 경로엔 오버헤드 0, 스크럽은 최후 복구로만 발생.
  `test_remove_pipeline_has_no_privileged_scrub`는 "정상 경로에선 chown 없음"으로 의미를 좁혀 갱신.

- **B) Eager 단계 추가**: `containers-remove`와 `profile-delete` 사이에 `reclaim-ownership` 단계를
  항상 삽입(모든 삭제마다 chown 컨테이너 1회 실행). 로직 단순·균일하나 불필요한 경우에도 docker run 1회.
  위 테스트는 5단계 + chown 허용으로 교체.

- **C) 구현 안 함**: 현행 트레이드오프 유지. 삭제 실패 시 사용자가 수동 `sudo rm -rf`. (근본 해결 취소)

- **D) 기타**: 자유 기술.

[Answer]: A

### Q2. 스크럽 실패 시(예: 이미지 없음/타임아웃) 동작?

- **A) Best-effort (권장)**: 복구/재시도까지 실패하면 원래대로 `HermesError`를 올려 삭제 실패로 보고
  (워크스페이스는 보존, 현행 동작과 동일). 데이터 파괴 없음.

- **B) 부분 성공 허용**: 프로필 dir 삭제가 안 돼도 registry에서는 제거해 "논리적 삭제" 처리.
  (고아 디렉터리 잔존 위험 — 비권장)

- **C) 기타**: 자유 기술.

[Answer]: B 로 해서 caduceus의 visability 에서는 삭제시킴. 그러나 다음에 다시 같은 이름으로 에이전트를 생성하려고할때, 기존 프로필이 있다면, 기존 프로필 삭제 후 재생성 (이때는 어차피 권한 있는 컨테이너를 만들 것이므로, 활용할 수 있음)

---

## 4. 구현 계획 (승인 후 반영: Q1=A, Q2=B + 재생성 시 고아 정리) — ✅ 완료

- [x] `HermesAdapter.reclaim_profile_ownership(profile, *, image) -> bool` 추가 —
      `docker run --rm --network none -v <dir>:/target <image> chown -R <uid>:<gid> /target`로
      소유권 회수. profile dir 없으면 True 반환(no-op), 실패 시 False(never raises).
- [x] Q1=A: `HermesAdapter.delete_profile(profile, *, image=None)` — 첫 delete 실패 시
      `reclaim_profile_ownership` 후 delete 1회 재시도. image 없으면(통합 호출) 원래 실패 전파.
- [x] Q2=B: `provisioner.remove_agent`의 `profile-delete` 단계가 `HermesError`를 잡아 로그만 남기고
      진행 → registry-remove 수행(가시성상 삭제). 파이프라인 이름/단계 수는 4개 유지.
- [x] 재생성 고아 정리: `provisioner.create_agent`의 `profile-create` 단계가 create 전
      `delete_profile(image=spec.docker_image)`를 호출(멱등, 부재 시 no-op) — 남은 고아 프로필을
      reclaim+삭제 후 생성. validate()가 registry 무기록을 보장하므로 잔존 dir은 항상 고아.
- [x] 테스트:
      - `test_remove_pipeline_has_no_privileged_scrub` → `..._no_scrub_on_success_path`로 의미 명확화
        (성공 경로엔 chown 없음; 어서션 유지).
      - 신규 adapter: reclaim 후 재시도 성공 / 복구 실패 시 `HermesError`(stderr redacted) /
        image 없으면 reclaim 미시도 / reclaim no-op·docker 실패 반환값.
      - 신규 provisioner: reclaim 후 삭제 성공(4단계), dir 삭제 실패해도 registry 제거(Q2=B),
        재생성 시 고아 delete가 create보다 먼저.
- [x] `ruff`(pass) + `mypy --strict`(45 files, no issues) + `pytest`(482 passed, 통합 4 deselected) — 회귀 없음.
- [x] `aidlc-state.md` "알려진 회귀" 항목 갱신, `audit.md` 결과 기록.

## 5. Extension 준수 요약

- **Resiliency**: 삭제는 멱등/best-effort 유지, 워크스페이스 불변(L3), 타임아웃 `DOCKER_TIMEOUT_S` 재사용 — 준수.
- **Security**: argv 배열 호출(셸 없음), 이미지 문자열은 검증된 `AgentSpec.docker_image`, 시크릿 미노출 — 준수.
- **Property-Based Testing**: 이 변경엔 순수 함수/불변식 대상 없음 — N/A (예시 기반 단위 테스트로 커버).
