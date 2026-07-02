# U1 Core Foundation — Logical Components

**Date**: 2026-07-02
**모듈 경로**: `caduceus/core/`

## 내부 논리 컴포넌트 (파일 단위 계획)

| 컴포넌트 | 파일 | 책임 | 순수/부수효과 |
|---|---|---|---|
| Domain Types | `types.py` | AgentName/Spec/Record/Status, NetworkMode, RegistryFile 스키마 (pydantic v2), SecretStr 토큰 | 순수 |
| Errors | `errors.py` | CaduceusError 계열 (ValidationError, NotFound, Conflict, HermesError, DockerError, RegistryCorrupt, Timeout) | 순수 |
| Ports | `ports.py` | SubprocessRunner / FileStore / Clock / EventSink 프로토콜 (테스트 페이크 주입점) | 인터페이스 |
| Registry Store | `registry.py` | load/save(원자적)/CRUD/불변식 검증/포트 할당/스키마 마이그레이션 훅 | 부수효과 (FileStore 경유) |
| Token Service | `tokens.py` | 발급(CSPRNG)/sha256/상수시간 resolve/회전 + 인메모리 캐시 | 순수 + 캐시 |
| Config Renderer | `render.py` | ManagedConfigKeys 생성, network_mode→docker 인자 변환, ruamel 병합, .env 라인 편집, 드리프트 비교 | 순수 (파일 I/O는 FileStore) |
| Hermes Adapter | `hermes_adapter.py` | profile create/delete, gateway argv 구성, SOUL/skills/toolsets 파일 조작, preflight | 부수효과 (SubprocessRunner/FileStore 경유) |
| Gateway Process Manager | `process_manager.py` | asyncio.subprocess spawn/monitor/backoff/graceful stop, per-agent 로그 링버퍼 | 부수효과 |
| Workspace Manager | `workspace.py` | `~/.caduceus/workspaces/<name>` 생성·경로 검증(V6/P9) — **삭제 API 없음** (L3 강제) | 부수효과 |
| Caduceus Config | `config.py` | `~/.caduceus/config.yaml` 로드/검증/저장 (upstream, listen, defaults) | 부수효과 |

## 컴포넌트 간 규칙

- `types/errors/ports` ← 모든 컴포넌트가 의존 가능 (최하층)
- `registry/tokens/render` ← 서로 독립, ports에만 의존
- `hermes_adapter/process_manager/workspace/config` ← ports + types 의존
- 상향 의존 금지: core는 U2(proxy/control) 를 알지 못함. 이벤트는 `EventSink` 프로토콜로만 방출

## 테스트 전략 매핑 (PBT-10 분리 규약)

| 대상 | PBT (Hypothesis) | Example-based | 통합(실물) |
|---|---|---|---|
| types/registry | P1(round-trip), P3(포트), I1~I5 위반 거부 | 손상 파일 fail-closed, 마이그레이션 | — |
| tokens | P4 | 회전 시나리오, 마스킹 확인 | — |
| render | P2, P5, P6, P7, P10 | 대표 config 픽스처(주석 보존 스냅샷) | — |
| process_manager | P8(백오프 수열 — 순수 함수 추출) | 페이크 프로세스 수명 시나리오 | 실제 hermes gateway 1회 왕복 |
| hermes_adapter | P9(경로) | 페이크 러너 argv 검증 | `hermes profile create/delete` 실물 (마커: `integration`) |
| workspace | P9 | 삭제 API 부재 (정적 검사) | — |

- PBT 시드: CI에서 `--hypothesis-seed` 로깅 (PBT-08), 실패 최소 예시는 example 테스트로 고정 (PBT-10)
