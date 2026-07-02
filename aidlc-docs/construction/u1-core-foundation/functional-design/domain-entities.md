# U1 Core Foundation — Domain Entities

**확정 결정 (FD-U1)**: FD1 `cad-<agent>` 프리픽스 · FD2 관리 키 병합 · FD3 자식 프로세스 모델(C7→GatewayProcessManager) · FD4 rm=워크스페이스만 보존, stop=비파괴

## 엔티티 및 관계

```text
CaduceusConfig 1 --- * AgentRecord (registry가 보유)
AgentRecord    1 --- 1 AgentSpec (선언 입력)
AgentRecord    1 --- 1 hermes profile "cad-<name>" (파생, FD1)
AgentRecord    1 --- 1 Workspace dir ~/.caduceus/workspaces/<name>/ (FD4, profile 밖)
AgentRecord    1 --- 0..1 GatewayProcess (런타임, 데몬 수명 내)
AgentRecord    1 --- 1 TokenCredential (해시만 저장; 평문은 profile .env)
AgentStatus    (합성 뷰 — 저장하지 않음)
```

## AgentName (값 객체)
- 규칙: `^[a-z0-9][a-z0-9_-]{0,59}$` (≤60자 — profile명 `cad-`+name ≤64, hermes 규칙 부합)
- 파생: `profile_name = "cad-" + name` / 역파생: `strip_prefix("cad-")` (왕복 항등)

## AgentSpec (선언 입력 — 불변)
| 필드 | 타입 | 기본 | 제약 |
|---|---|---|---|
| name | AgentName | 필수 | 레지스트리 내 유일 |
| docker_image | str | caduceus 기본 이미지 | 비어있지 않음 |
| network_mode | `host` \| `bridge_hostgw` \| `none` | `host` (AD-2) | |
| cpu / memory_mb / disk_mb | number? | 미설정=hermes 기본 | >0 |
| persona | str? | 없음 | SOUL.md 초기값 |

## AgentRecord (레지스트리 영속 — registry.json)
| 필드 | 타입 | 비고 |
|---|---|---|
| spec | AgentSpec | |
| profile_name | str | `cad-<name>` (FD1) |
| workspace_dir | path | `~/.caduceus/workspaces/<name>` (FD4) |
| api_port | int | 할당 시 고정, 유일 |
| api_key_ref | str | api_server 키 (profile .env의 `API_SERVER_KEY`와 동일 값을 데몬이 알아야 chat 중계 가능 — U1은 발급·주입만, 보관 정책은 business-rules §5) |
| token_hash | str | sha256(hex), 평문 비저장 (AD-6) |
| desired_state | `running` \| `stopped` | |
| created_at | str | ISO 8601 |

## GatewayProcess (런타임 전용 — 비영속, FD3)
| 필드 | 타입 | 비고 |
|---|---|---|
| agent_name | AgentName | |
| pid | int | 자식 프로세스 |
| state | `starting` \| `running` \| `stopping` \| `exited` \| `crashlooping` | |
| restart_count / last_exit_code / next_backoff_s | int/int/float | 백오프 재시작 (logic §4) |

## RegistryFile (영속 스키마)
```json
{
  "schema_version": 1,
  "agents": { "<name>": AgentRecord, ... }
}
```
- 원자적 쓰기(tmp+fsync+rename), 로드 시 스키마 검증·버전 확인 (round-trip PBT 대상)

## CaduceusConfig (`~/.caduceus/config.yaml`)
| 필드 | 기본 | 비고 |
|---|---|---|
| listen.host / listen.port | 127.0.0.1 / 4285 | 데몬 바인드 (N3 loopback) |
| upstream.base_url | 필수 (init 마법사) | OpenAI 호환 |
| upstream.api_key_env | 선택 | 환경변수명 참조 (평문 비저장) |
| upstream.default_model | 선택 | |
| agents.port_base | 42800 | api_server 포트 할당 시작점 (상한 없음 — N10) |
| agents.default_image | nikolaik/python-nodejs:python3.11-nodejs20 | hermes 예시와 정렬 |
| reconcile.interval_s | 30 | |

## ManagedConfigKeys (FD2 — Caduceus 소유 config.yaml 키)
`model.provider`, `model.base_url`, `model.default`, `terminal.backend`, `terminal.docker_image`, `terminal.container_persistent`, `terminal.container_cpu/memory/disk`, `terminal.docker_volumes`(workspace bind), `terminal.docker_extra_args`(network 변환), `terminal.cwd`
— 이외 키(사용자/hermes dashboard 편집)는 보존. `.env` 소유 키: `OPENAI_API_KEY`(게이트웨이 토큰), `API_SERVER_ENABLED/PORT/KEY`
