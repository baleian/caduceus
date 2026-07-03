# U3 CLI — Business Logic Model

**Date**: 2026-07-03
**전제**: CLI는 Admin API(U2)의 순수 HTTP 클라이언트. 비즈니스 판단(상태 합성, 검증, 파이프라인)은 전부 데몬 소유 — CLI 로직은 ①커맨드→API 매핑 ②대기·렌더 ③오류→종료코드 변환 세 가지로 한정한다.

## 1. 커맨드 → API 매핑 전표

| 커맨드 | HTTP | 대기 의미론 | 성공 출력 |
|---|---|---|---|
| `agent create` | `POST /api/agents` (202+job) | 잡 대기(§2) | 잡 진행률 → 완료 요약(이름/포트/상태) |
| `agent ls` | `GET /api/agents` | 즉시 | 표 / JSON |
| `agent status <n>` | `GET /api/agents/{n}` (+`GET /api/status`의 해당 트래픽) | 즉시 | 요약 / JSON |
| `agent start` | `POST /api/agents/{n}/start` (202+job) | 잡 대기 | 진행률 → ok |
| `agent stop` | `POST /api/agents/{n}/stop` (202+job) | 잡 대기 | 진행률 → ok |
| `agent rm` | `DELETE /api/agents/{n}` + `X-Confirm: <n>` (202+job) | 확인(§4) → 잡 대기 | 진행률 → 워크스페이스 보존 경로 안내 |
| `agent logs` | `GET /api/agents/{n}/logs?last=N` | 즉시 (`-f`는 §5) | 라인 그대로 |
| `agent soul` (출력) | `GET /api/agents/{n}/soul` | 즉시 | 본문 그대로 |
| `agent soul --edit` | GET → `$EDITOR` 임시파일 → 변경 시 `PUT /api/agents/{n}/soul` | 즉시 | 변경/무변경 안내 |
| `agent soul --set F\|-` | `PUT /api/agents/{n}/soul` | 즉시 | ok |
| `agent skills` | `GET /api/agents/{n}/skills` | 즉시 | enabled 표 / JSON |
| `agent skills --enable/--disable S` | `PUT /api/agents/{n}/skills/{S}` | 즉시 | ok |
| `agent toolsets` | `GET /api/agents/{n}/toolsets` | 즉시 | YAML/JSON |
| `agent toolsets --set F\|-` | `PUT /api/agents/{n}/toolsets` | 즉시 | ok |
| `agent token rotate` | `POST /api/agents/{n}/token/rotate` (204) | 즉시 | "rotated" (원문 미표시 — 새 토큰은 profile .env에만) |
| `chat` | agent 프록시 경유 (§3) | 대화형 | — |
| `gateway status` | `GET /api/gateway` + `GET /api/status` | 즉시 | 업스트림+트래픽 요약 / JSON |
| `gateway upstream get` | `GET /api/gateway` | 즉시 | base_url, api_key_env |
| `gateway upstream set` | `PUT /api/gateway/upstream` | 즉시 | 핫스왑 완료 안내 |
| `job ls` / `job status` | `GET /api/jobs[/{id}]` | 즉시 | 표·스텝 상태 / JSON |
| `job wait <id>` | 폴링 `GET /api/jobs/{id}` | 잡 대기 | 진행률 → 최종 상태 |
| `ui` | (로컬) 브라우저 오픈 | — | URL 안내 |

모든 요청 공통: `Authorization: Bearer <admin_token>` 헤더. 응답 401 → "토큰 불일치 — 데몬을 재기동했거나 admin.token이 교체되었는지 확인" 안내 + exit 3.

## 2. 잡 대기·진행률 렌더 (Q3=A)

```
submit → 202 {job}
loop:
  GET /api/jobs/{id}  (간격 0.5s, 총 타임아웃 없음 — 데몬이 잡 상태를 소유)
  스텝 상태 변화 diff → 렌더 갱신
until job.state ∈ {done, failed}
```

- **렌더 규칙**: 스텝별 1줄 — `pending` 공백 / `running` 스피너 / `ok` ✓ / `failed` ✗ / `skipped` ↷. 비-TTY면 상태 *전이 시에만* 한 줄씩 append (스피너 없음)
- **WS 미사용 결정**: 이벤트 지연 0.5s 폴링이면 CLI UX에 충분, 재연결·리플레이 처리 코드 회피 (P4). WS는 U4 Web UI의 소비 계약
- **종료 코드**: `done`→0, `failed`→1 (+ `error`(redact 완료본) stderr 출력)
- `--no-wait`: job id 1줄 출력 후 즉시 0 종료. 이후 `job wait <id>`로 이어받기 가능
- 대기 중 Ctrl+C: **잡은 취소되지 않음**(데몬이 계속 실행) — "잡은 계속 실행됩니다. caduceus job status <id>로 확인" 안내 후 exit 130

## 3. Chat 파이프라인 (F6, Q4=A·Q5=A)

모든 호출은 **데몬 agent 프록시 경유**: `…/agents/{name}/api/{subpath}` (CLI는 agent의 api_server 포트·키를 알 필요 없음 — 키는 데몬이 서버측 부착).

```
기동:
  GET /api/agents/{name}            → 존재·status 확인 (unreachable이면 경고 후 계속 시도)
  세션 결정 (Q4=A):
    --session ID → GET …/api/api/sessions/{ID} 검증
    --new        → POST …/api/api/sessions
    무옵션       → GET …/api/api/sessions → 최근 세션 or POST 생성
  헤더 라인 출력 → REPL 진입 (state=idle)

REPL turn:
  입력 수집 (idle) — `/exit` 즉시 종료
  POST …/api/api/sessions/{id}/chat/stream  (state=streaming)
  SSE 수신 루프: 이벤트 → ScreenElement 매핑 (domain-entities §5)
    - 알 수 없는 이벤트 타입: 무시하고 계속 (전방 호환 — PU3-3)
    - approval 요청: state=awaiting_approval → y/n 입력 → hermes approval 엔드포인트로 응답 POST → streaming 복귀
  스트림 종료(run 완료) → state=idle, 프롬프트 복귀

인터럽트 (PU3-5 상태 기계):
  streaming에서 Ctrl+C → run stop 엔드포인트 POST (1회) → state=stopping
  stopping: 상류가 스트림을 닫을 때까지 수신 유지 (부분 출력 보존) → idle
  idle에서 Ctrl+C / Ctrl+D → 종료 (exit 0)

연결 끊김(스트림 절단): "연결이 끊겼습니다 — 세션은 보존됩니다" 안내 → idle 복귀
(같은 세션 재전송으로 이어가기 — hermes 세션이 상태 소유)
```

- hermes api_server의 세션/runs/stop/approval 엔드포인트 경로는 **U2 프록시 허용 프리픽스(`v1/`, `api/sessions`, `health`) 안**에서 hermes-research.md 계약 그대로 사용 — CLI가 경로를 재발명하지 않음
- 렌더는 무버퍼 pass-through: 델타 수신 즉시 출력 (F6 스트리밍 체감)

## 4. 파괴적 명령 확인 (rm)

```
--yes 없으면 (TTY 필수 — 비-TTY에서 --yes 없이 rm = exit 2):
  "에이전트 '<n>'을 삭제합니다. profile과 컨테이너가 제거됩니다.
   워크스페이스는 보존됩니다: ~/.caduceus/workspaces/<n>
   계속하려면 에이전트 이름을 입력하세요:"
  입력 == name → DELETE + X-Confirm: <name>
  불일치/빈 입력 → "취소됨" exit 5
```

## 5. `logs -f` 폴링 tail (Q6=A)

```
state: last_lines = GET logs?last=N 출력분
loop (간격 1s):
  fetch = GET logs?last=2000
  신규분 = fetch에서 last_lines 접미사와 겹치는 부분 이후  (겹침 미발견 = 로그 회전 → 전체를 신규로 간주, 안내 1줄)
  신규분 출력, last_lines 갱신
Ctrl+C → exit 0
```
불변식(PU3-6): 로그가 단조 append되는 한 어떤 폴링 타이밍에서도 라인 중복 출력·유실 없음.

## 6. 부트스트랩 커맨드

### `init` (Q1=A — 멱등)
1. `~/.caduceus/` 홈·기본 config.yaml·admin.token 생성 (이미 있으면 건드리지 않고 현황 표시) — U1 config/U2 auth와 동일 로직 재사용(core import 허용 범위)
2. upstream 대화형 설정: base_url 입력(기본 제안 목록 없음 — 자유 입력), api_key_env 변수명 입력 + 해당 env 존재 여부 즉시 검사(값은 미표시)
3. preflight 요약 출력 (hermes CLI, docker 도달성 — core의 preflight 재사용)
- 비-TTY에서는 대화형 생략, 파일 생성만 (스크립트 설치 지원)

### `serve` (Q2=B)
- 포그라운드(기본): `caduceus.daemon`의 build/run 경로를 인프로세스 호출 — `caduceusd`와 완전 동일 (코드 중복 없음)
- `-d/--detach`: double-fork+setsid → pid 파일 기록 → stdout/stderr를 로그 파일로 리다이렉트 → 자식이 동일 run 경로 실행. 부모는 `/healthz` 응답 대기(최대 10s) 후 "running (pid N)" 출력하고 0 종료, 미기동 시 로그 경로 안내 + exit 1
- `serve stop`/`serve status`: domain-entities §6 의미론

### `doctor`
검사 항목(각 ✓/✗ + 조치 안내, 하나라도 ✗면 exit 1):
1. hermes CLI 존재·버전  2. docker 도달성(`docker info`)  3. `~/.caduceus/` 존재·권한(0600 파일들)  4. 데몬 도달성(`/healthz`)  5. 업스트림 설정 여부(`GET /api/gateway`) + api_key_env 환경변수 존재  6. 레지스트리 로드 가능(데몬 경유 `/api/agents`)
- 데몬 미가동 시 4~6은 `skip (daemon not running)` — 로컬 검사만으로도 유용하게

### `ui`
`ClientConfig.base_url`을 기본 브라우저로 오픈 (`xdg-open`/`open`, 실패 시 URL만 출력). 토큰을 URL에 포함하지 않음 — Web UI 인증 방식은 U4에서 확정.

## 7. 오류 → 메시지·종료 코드 매핑 (전사 — PU3-1)

| 상황 | 메시지 방침 | exit |
|---|---|---|
| 연결 거부/타임아웃 | "데몬에 연결할 수 없습니다 (URL). `caduceus serve`로 시작하세요" | 3 |
| 토큰 파일 부재 | "초기화되지 않았습니다. `caduceus init` 또는 `caduceus serve`를 먼저" | 3 |
| 401 | 토큰 불일치 안내 (사유 무구분 — 데몬과 동일 방침) | 3 |
| 404 (`{"error":{"code":"not_found"}}`) | "<kind> '<n>'을 찾을 수 없습니다" + 유사 시 `agent ls` 안내 | 4 |
| 409/conflict | API error message 그대로 (이미 redact됨) | 5 |
| 422/validation | 필드 오류 그대로 | 2 |
| 5xx/기타 | API error message + job/status 확인 안내 | 1 |
| 잡 failed | 실패 스텝 ✗ + error | 1 |
| 사용법 오류 | usage 출력 | 2 |

- API 오류 본문(`{"error":{"code","message"}}` — U2 계약)의 message는 데몬이 이미 redact 완료 → CLI는 재가공 없이 표시하되, 방어적으로 자체 redact(32+hex 마스킹)를 한 번 더 통과시킨다 (심층 방어)

## 8. Testable Properties (PBT-01 — PU3-*)

| ID | 속성 | 전략 |
|---|---|---|
| PU3-1 | **오류 매핑 전역성**: 임의의 (HTTP status, error code) 조합·연결 예외에 대해 §7 테이블대로 정확히 하나의 exit code가 결정되고 예외 전파 없음 | 상태·코드 생성 → 매퍼 oracle 대조 |
| PU3-2 | **잡 렌더 수렴**: 유효한 잡 스냅샷 시퀀스(U2 상태 기계가 생성 가능한 전이만)에 대해 렌더러가 항상 종료 상태에 도달하고 exit code가 최종 잡 상태와 일치 | 스냅샷 시퀀스 생성기(전이 규칙 준수) |
| PU3-3 | **SSE 렌더 전역성**: 임의의 이벤트 스트림(알 수 없는 타입·필드 결손 포함)에 대해 렌더 파이프라인이 예외 없이 소비하고, 텍스트 델타는 순서·내용 보존 출력 | 이벤트 fuzzing + 델타 재조립 oracle |
| PU3-4 | **--json stdout 순수성**: `--json` 지원 전 커맨드 × 임의 응답에 대해 stdout 전체가 단일 유효 JSON으로 파싱됨 (진행률·경고 불혼입) | 커맨드×응답 생성 → stdout 캡처 파싱 |
| PU3-5 | **chat 인터럽트 상태 기계**: 임의의 인터럽트·이벤트 인터리빙에서 (a) stop 요청 turn당 ≤1 (b) idle에서만 종료 (c) 세션 파괴 호출 부재 | RuleBasedStateMachine (U2 PU2-3 방식) |
| PU3-6 | **tail 무중복·무유실**: 단조 append 로그 + 임의 폴링 스냅샷 경계에 대해 출력 = 원본 접미사 연결과 일치 | 로그 성장 시퀀스·창 크기 생성 |
| PU3-7 | **인자 파싱 계약**: 커맨드 표면 전체에 대해 유효 조합은 의도한 호출로 파싱, 상호 배타 위반·미정의 플래그는 exit 2 | 유효/무효 커맨드라인 생성기 |
