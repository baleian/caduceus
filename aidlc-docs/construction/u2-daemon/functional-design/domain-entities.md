# U2 Daemon — Domain Entities

**확정 결정 (FD-U2)**: FD5 사용량=인메모리 집계(Q1=A) · FD6 Admin API=자동 생성 admin 토큰(Q2=A) · FD7 레지스트리 기록 후치(사전 결정) · FD8 health 판정 기본값(30s/연속 3회)

## Job (프로비저닝 작업 — 인메모리, 비영속)

| 필드 | 타입 | 비고 |
|---|---|---|
| id | str | `job-<8hex>` |
| kind | `create` \| `remove` | |
| agent | AgentName | |
| state | `queued` \| `running` \| `done` \| `failed` | 상태 기계: queued→running→(done\|failed) — 역전이 금지 (PU2-3) |
| steps | list[JobStep] | 순서 고정, 각각 `pending`→`running`→(`ok`\|`failed`\|`skipped`) |
| error | str? | redact 적용된 요약 (실패 시) |
| created_at / finished_at | ISO 8601 | Clock 주입 |

**JobStep 시퀀스 (create — S1 정련, FD7 반영)**:
`validate` → `workspace` → `allocate`(포트·토큰·api key) → `profile-create` → `config-apply` → `env-write` → `registry-add` → `gateway-start` → `health-wait`

**JobStep 시퀀스 (remove — FD4)**:
`gateway-stop` → `containers-remove` → `profile-delete` → `registry-remove` (워크스페이스는 어떤 단계에서도 비접촉 — L3)

## TrafficStats (FD5 — 인메모리 전용)

| 구조 | 내용 |
|---|---|
| AgentTraffic | `{requests: int, errors: int, input_tokens: int, output_tokens: int, last_request_at: str?}` — 단조 증가 카운터 (PU2-2) |
| TrafficSample (링버퍼, agent별 최근 N=100) | `{ts, model, status, latency_ms, input_tokens?, output_tokens?}` — **요청/응답 본문은 절대 비저장** (프롬프트 프라이버시, SECURITY-03) |
| totals | 전 에이전트 합 == per-agent 합 (PU2-2 불변식) |

## Event 스키마 (CoreEvent.kind 확장 — U1 process.\* 에 추가)

| kind | data |
|---|---|
| `job.step` / `job.done` / `job.failed` | job_id, step, state / error(redacted) |
| `traffic.request` | model, status, latency_ms, tokens (본문 없음) |
| `health.changed` | from, to (FD8 판정) |
| `drift.detected` | keys[(path, expected, actual)] — G2 |
| `orphan.detected` | resource(`profile`\|`container`), name — FD7 고아 감지 |
| `upstream.changed` | base_url (키 정보 비포함) |

**EventBus**: in-proc pub/sub + WS fanout + 최근 500건 링버퍼(재접속 리플레이, PU2-6). 발행 실패가 본 작업을 실패시키지 않음 (관측성은 부차 경로)

## StatusSynthesis 입력·출력 (PU2-1 oracle 테이블의 대상)

입력: `AgentRecord.desired_state` × `ProcessInfo.state | absent` × health probe(`200 ok` / `error` / `timeout`) × container 조회(`running/exited/absent/unknown`)
출력: `AgentStatus` — 진실 테이블은 business-logic-model.md §3.3에 정의 (E3: 조회 실패는 unknown으로 정직 반영)

## AdminAuth (FD6)

| 항목 | 값 |
|---|---|
| 토큰 파일 | `~/.caduceus/admin.token` (0600, `caduceus init` 시 CSPRNG 32B hex 생성) |
| 전달 | `Authorization: Bearer <token>` 또는 `X-Caduceus-Token` |
| 비교 | 상수시간 (S2와 동일 방식) |
| 적용 범위 | `/api/*`, `/agents/*` 전부 (deny-by-default). 공개: `GET /healthz`만. `/v1/*`은 에이전트 토큰 (별도 체계) |

## HealthState 판정 (FD8)

- 폴링 주기: `reconcile.interval_s` (기본 30s)
- `GET /health` 200 → `healthy` / 200 외 응답 → `unhealthy` / 연결 실패·타임아웃(5s) **연속 3회** → `unreachable` / 프로세스 미기동 → `unknown`
