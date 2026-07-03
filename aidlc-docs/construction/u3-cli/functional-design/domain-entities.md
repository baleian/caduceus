# U3 CLI — Domain Entities

**Date**: 2026-07-03
**결정 근거**: u3-cli-functional-design-plan.md (Q1=A init 경량 유지, Q2=B serve -d 데몬화, Q3=A 잡 대기+진행률, Q4=A 마지막 세션 재개, Q5=A 전부 표시, Q6=A 폴링 tail, Q7=A --json 조회형+잡)

## 1. ClientConfig — 데몬 접속 컨텍스트

CLI의 모든 원격 명령이 사용하는 접속 정보. **해석 순서(위가 우선)**:

| 필드 | 1순위 | 2순위 | 3순위 (기본값) |
|---|---|---|---|
| `base_url` | env `CADUCEUS_URL` | `~/.caduceus/config.yaml`의 `listen.host:listen.port` | `http://127.0.0.1:4285` |
| `admin_token` | env `CADUCEUS_ADMIN_TOKEN` | `~/.caduceus/admin.token` 파일 | (없음 → 원격 명령 시 오류) |
| `timeout` | — | — | 연결 5s / 읽기 30s (스트리밍·chat은 읽기 무제한) |

- 토큰 파일이 없고 env도 없으면: 데몬 미초기화로 간주 → 부트스트랩 안내 + exit 3
- `admin_token`은 메모리에서만 취급, 어떤 출력·로그에도 원문 미표시 (rules CLI-P1)

## 2. 커맨드 트리 (전체 표면)

```
caduceus init                                # 홈/기본 config/admin 토큰 생성(멱등) + upstream 대화형 설정 + preflight 요약
caduceus serve [--host H] [--port N] [-d|--detach]
caduceus serve stop                          # detach 모드로 띄운 데몬 종료 (pid 파일 기반)
caduceus serve status                        # pid/health 요약
caduceus doctor                              # 환경 진단 (hermes/docker/홈/데몬 도달성/업스트림)
caduceus ui                                  # 기본 브라우저로 데몬 URL 오픈

caduceus agent create <name> [--image IMG] [--network host|bridge_hostgw|none]
                             [--cpu N] [--memory SIZE] [--persona FILE]
                             [--no-wait] [--json]
caduceus agent ls [--json]
caduceus agent status <name> [--json]
caduceus agent start <name> [--no-wait] [--json]
caduceus agent stop  <name> [--no-wait] [--json]
caduceus agent rm    <name> [--yes] [--no-wait] [--json]      # --purge 없음 (L3)
caduceus agent logs  <name> [-n N] [-f]                       # 기본 -n 200
caduceus agent soul  <name> [--edit | --set FILE|-]           # 무옵션 = 출력
caduceus agent skills <name> [--enable SKILL | --disable SKILL] [--json]
caduceus agent toolsets <name> [--set FILE|-] [--json]        # 무옵션 = 출력
caduceus agent token rotate <name>

caduceus chat <name> [--session ID | --new]

caduceus gateway status [--json]
caduceus gateway upstream get [--json]
caduceus gateway upstream set <base_url> [--api-key-env VAR]

caduceus job ls [--json]
caduceus job status <id> [--json]
caduceus job wait <id> [--json]              # --no-wait로 띄운 잡을 나중에 대기

caduceus --version / --help (전 서브커맨드 -h)
```

- 글로벌 플래그: `--json`(적용 커맨드는 위 표기), `--no-color`(env `NO_COLOR` 동등), `-q/--quiet`(stderr 진행률 억제)
- `--session`과 `--new`는 상호 배타 (동시 지정 = 사용법 오류 exit 2)
- `--edit`과 `--set` 상호 배타. `--set -` = stdin

## 3. 종료 코드 규약 (스크립팅 계약 — 고정)

| 코드 | 의미 | 예 |
|---|---|---|
| 0 | 성공 (잡 명령은 잡 `done` 포함) | |
| 1 | 일반 오류·잡 실패·데몬 측 5xx | create 잡 step 실패 |
| 2 | 사용법 오류 (인자·플래그·상호 배타 위반) | `--session`+`--new` 동시 |
| 3 | 데몬 접속 불가·미초기화 (연결 거부, 토큰 부재) | serve 안내 출력 |
| 4 | 대상 없음 (agent/session/job/skill 404) | |
| 5 | 확인 거부·충돌 (사용자 n 응답, API 409, X-Confirm 불일치) | 이미 존재하는 이름으로 create |

- 부분 성공 없음: 잡 명령은 잡 최종 상태 하나로 종료 코드 결정
- `chat`: 정상 종료(/exit, 유휴 Ctrl+C) = 0, 접속 실패 = 3, 세션 대상 없음 = 4

## 4. 출력 모드

### 사람 모드 (기본)
- `agent ls` 표 컬럼: `NAME  STATUS  DESIRED  GATEWAY  API PORT  NETWORK` (STATUS는 U2 상태 합성 결과 그대로)
- `agent status`: 레코드 요약 + health + 최근 트래픽 카운터
- 진행률·안내·경고는 **stderr**, 데이터는 stdout
- TTY가 아니면(파이프) 색·스피너 자동 비활성 (`NO_COLOR`/`--no-color` 동등)

### `--json` 모드
- stdout = **단일 JSON 문서만** (Admin API 응답 구조 그대로 — 별도 재가공 스키마를 만들지 않음, 필드 계약은 API가 소유)
- 잡 명령의 `--json` 출력 = 최종 잡 스냅샷 (`{id, kind, agent, state, error, steps[], created_at, finished_at}` — U2 `Job.snapshot()` 그대로)
- 진행률은 stderr로만 (stdout 순수성 — PU3-4)

## 5. Chat 렌더 도메인

### ScreenElement (SSE 이벤트 → 화면 요소)
| 요소 | 근원 이벤트 | 렌더 |
|---|---|---|
| `UserPrompt` | (로컬 입력) | `you ›` 프롬프트 |
| `AssistantDelta` | 텍스트 델타 | 즉시 append (무버퍼) |
| `ThinkingBlock` | `reasoning.available` | dim 색, `∴ thinking` 헤더 아래 스트리밍 |
| `ToolCallLine` | `tool.*` 시작 | `⚙ <tool> <args 1줄 요약(120자 절단)>` |
| `ToolResultMark` | `tool.*` 완료 | 같은 라인에 ✓/✗ + 소요 표시 |
| `ApprovalPrompt` | approval 요청 이벤트 | `⚠ approval: <요청 요약> [y/N]` — 입력 즉시 응답 전송 |
| `Notice` | run 시작/종료, stop 접수, 재연결 | dim 한 줄 |

### ChatInputState (Ctrl+C 상태 기계 — PU3-5)
| 상태 | Ctrl+C | Ctrl+D 또는 `/exit` |
|---|---|---|
| `idle` (프롬프트 대기) | chat 종료 (exit 0) | chat 종료 (exit 0) |
| `streaming` (turn 진행 중) | **run stop 요청 전송** → `stopping` | (무시) |
| `stopping` (stop 접수 대기) | (무시 — 중복 stop 금지) | (무시) |
| `awaiting_approval` | 거부(n)로 응답 후 `streaming` 복귀 | (무시) |

불변식: 어떤 인터럽트 시퀀스에서도 (a) 세션은 삭제·손상되지 않는다, (b) turn당 stop 요청은 최대 1회, (c) `idle`에서만 프로세스가 종료된다.

### 세션 선택 (Q4=A)
```
--session ID 지정 → 해당 세션 (404 시 exit 4)
--new           → 새 세션 생성
(무옵션)         → 세션 목록 조회 → 최근(updated 최신) 세션 재개, 없으면 새로 생성
```
시작 시 헤더 1줄: `chat with <agent> — session <id 축약> (resumed|new)`

## 6. Detach 실행 상태 (Q2=B)

| 항목 | 값 |
|---|---|
| pid 파일 | `~/.caduceus/caduceusd.pid` (내용: pid 1줄) |
| 로그 파일 | `~/.caduceus/logs/caduceusd.log` (stdout/stderr 리다이렉트, append) |
| stale 판정 | pid 파일 존재 + 해당 pid 프로세스 부재(or 다른 이미지) → stale로 간주, 안내 후 덮어씀 |
| 이중 실행 차단 | pid 살아있으면 `serve`(전 모드) 거부 exit 1 + 안내. 데몬 자체 포트 바인딩 실패도 동일 안내 |
| `serve stop` | pid 읽기 → SIGTERM → 최대 15s 대기 → 미종료 시 경고 출력(강제 종료는 하지 않음, 사용자 판단) |
| `serve status` | pid 존재 여부 + `/healthz` 응답 → `running (pid N, healthy)` / `not running` |

- detach는 POSIX 전용 (double-fork + setsid). N1 범위(Linux/WSL2/macOS) 내 — Windows 미지원은 문서화된 예외
