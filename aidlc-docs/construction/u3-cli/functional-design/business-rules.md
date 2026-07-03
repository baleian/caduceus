# U3 CLI — Business Rules

**Date**: 2026-07-03
**표기**: CLI-P(프라이버시·토큰) / CLI-C(확인·파괴성) / CLI-O(출력·스크립팅) / CLI-E(오류·안내) / CLI-D(의존·경계)

## CLI-P — 토큰·프라이버시

| ID | 규칙 |
|---|---|
| CLI-P1 | admin 토큰·에이전트 토큰 원문은 어떤 출력 경로(stdout/stderr/로그/오류 메시지)에도 표시하지 않는다. `token rotate` 성공 메시지도 "rotated — profile .env에 반영됨"까지만 |
| CLI-P2 | 표시 직전 모든 오류·응답 유래 텍스트를 core `redact()`(32+hex 마스킹)에 통과시킨다 — 데몬이 이미 redact하지만 심층 방어로 이중 적용 |
| CLI-P3 | chat 대화 내용을 CLI가 파일로 저장하지 않는다 (세션 영속은 hermes 소유). 셸 히스토리 외 로컬 흔적 없음 |
| CLI-P4 | `init`의 api_key_env 검사는 env 존재 여부만 보고하고 값은 읽은 즉시 폐기·미표시 |

## CLI-C — 확인·파괴성

| ID | 규칙 |
|---|---|
| CLI-C1 | `agent rm`은 대화형 이름 재입력 확인 후에만 `X-Confirm` 헤더를 전송한다. `--yes`가 유일한 우회 |
| CLI-C2 | 비-TTY(파이프·스크립트)에서 `--yes` 없는 `rm`은 즉시 exit 2 — 묵시적 삭제 금지 |
| CLI-C3 | 확인 문구에 워크스페이스 보존 사실과 경로를 반드시 포함한다 (L3 가시화) |
| CLI-C4 | `--purge`류 워크스페이스 삭제 옵션을 제공하지 않는다 (L3). rm 완료 출력에 보존 경로 안내 |
| CLI-C5 | 잡 대기 중 Ctrl+C는 잡을 취소하지 않는다 — 데몬 측 잡은 계속 실행됨을 안내 (E4: 중단·롤백 없음) |
| CLI-C6 | `serve stop`은 SIGTERM만 보낸다 (graceful — L1 데몬 자체 종료 시퀀스에 위임). SIGKILL 에스컬레이션은 사용자 판단에 맡기고 CLI가 자동 수행하지 않음 |

## CLI-O — 출력·스크립팅

| ID | 규칙 |
|---|---|
| CLI-O1 | `--json` 모드에서 stdout은 단일 JSON 문서만 (PU3-4). 진행률·경고·안내는 전부 stderr |
| CLI-O2 | JSON 출력은 Admin API 응답 구조를 재가공 없이 전달 — 필드 계약의 소유자는 API. CLI 자체 스키마를 만들지 않는다 |
| CLI-O3 | 종료 코드 테이블(domain-entities §3)은 공개 계약 — 변경은 breaking change로 취급 |
| CLI-O4 | 색·스피너·유니코드 장식은 TTY에서만. `NO_COLOR` env 또는 `--no-color`로 항상 비활성 가능. 비-TTY 진행률은 전이 시 라인 append |
| CLI-O5 | `-q/--quiet`는 stderr 진행률만 억제하고 오류는 항상 출력 |

## CLI-E — 오류·안내

| ID | 규칙 |
|---|---|
| CLI-E1 | 데몬 접속 불가 시 항상 다음 행동을 안내한다: 미초기화 → `caduceus init`, 미기동 → `caduceus serve`, 401 → admin.token 확인 (완료 기준 "친절한 오류" 계약) |
| CLI-E2 | 오류 매핑은 business-logic-model §7 테이블이 전사 — 매핑 밖 상황은 exit 1 + 원문 메시지 (silent failure 금지) |
| CLI-E3 | 404에는 가능한 경우 탐색 명령(`agent ls`, `job ls`)을 안내 |
| CLI-E4 | 스택트레이스는 사용자에게 노출하지 않는다 (`--debug` 플래그에서만 전체 표시) |

## CLI-D — 의존·경계

| ID | 규칙 |
|---|---|
| CLI-D1 | `caduceus.cli`는 `caduceus.core`만 import 가능. `proxy`/`control` import 금지 — 데몬 기능은 HTTP로만 소비 (unit-of-work 의존 규칙) |
| CLI-D2 | **문서화된 예외 1 — `serve`**: 데몬 인프로세스 기동을 위해 `caduceus.daemon`(composition root)만 추가로 import 허용. 로직 재구현 금지 — `caduceusd` 엔트리와 동일 경로 호출 |
| CLI-D3 | **문서화된 예외 2 — `init`/`doctor`**: 데몬 없이 동작해야 하므로 core의 config/auth 파일 생성·preflight를 직접 호출 (홈 디렉토리 로컬 파일 한정, 레지스트리 쓰기 금지) |
| CLI-D4 | hermes api_server 엔드포인트는 데몬 agent 프록시 경유로만 호출 — CLI가 에이전트 포트·API_SERVER_KEY를 직접 다루지 않는다 (S2) |
| CLI-D5 | `serve -d`(detach)는 POSIX 전용 — **문서화된 예외**: Windows 네이티브 미지원 (N1 범위는 Linux/WSL2/macOS) |
| CLI-D6 | CLI는 로컬 상태 파일을 만들지 않는다 (pid 파일·detach 로그 제외 — 이는 데몬 실행 산물). 모든 조회는 API 경유 |
