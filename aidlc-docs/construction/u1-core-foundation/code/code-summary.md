# U1 Core Foundation — Code Summary

**Date**: 2026-07-03
**검증**: ruff ✅ · mypy --strict ✅ · pytest **105 passed** (통합 2건은 `-m integration` 옵트인)

## 생성 파일

### 애플리케이션 코드 (`caduceus/core/`)
| 파일 | 내용 | 설계 계약 |
|---|---|---|
| `types.py` | AgentName(V1)/AgentSpec(V2~V5)/AgentRecord(I4·I5)/RegistryFile(I1~I3)/CaduceusConfig/AgentStatus/CoreEvent, profile명 왕복 | domain-entities.md |
| `errors.py` | CaduceusError 계열 (fail-closed 도메인 예외) | E1~E4 |
| `ports.py` | CommandRunner/ProcessSpawner/FileStore/Clock/EventSink 프로토콜 + Real 구현 (원자적 쓰기 tmp+fsync+replace 포함) | Hexagonal 패턴 |
| `tokens.py` | CSPRNG 발급(`cad-<name>-<32hex>`), sha256, 전 엔트리 상수시간 resolve, IssuedToken repr 마스킹 | S1·S2, 로직 §3 |
| `registry.py` | RegistryStore(fail-closed 손상 백업)/Registry(CRUD·저장 전 불변식 검증·포트 할당·메모리 비변이 실패 처리) | 로직 §1·§2 |
| `render.py` | ManagedConfigKeys 렌더, network_mode 3종 변환(P10), ruamel round-trip 병합(주석·따옴표 보존), .env 라인 편집(인젝션 방어), 드리프트 diff | FD2/G1~G3, 로직 §5 |
| `workspace.py` | `~/.caduceus/workspaces/<name>` 격납 검증(P9)·생성·재사용(L5) — **삭제 API 없음(L3)** | FD4/AMD-2 |
| `config.py` | CaduceusConfigStore (load/save, 0600, init 힌트) | domain-entities.md |
| `hermes_adapter.py` | profile create/delete(--yes)/관리 config 적용/.env(API_SERVER_\*, OPENAI_API_KEY)/SOUL/skills(`skills.disabled`)/toolsets(`platform_toolsets`)/컨테이너 라벨 제거/gateway argv/preflight — **hermes 유일 접점, 소스 검증된 규약만 사용** | C6, 로직 §5~§7 |
| `process_manager.py` | 자식 프로세스 spawn/monitor, 백오프(1s→60s cap, P8), crashloop 정지(L6), graceful stop(SIGTERM→15s→SIGKILL, L2), shutdown(L1), 로그 링버퍼, 이벤트 방출 | FD3/AMD-1, 로직 §4 |

### 빌드/설정
- `pyproject.toml` — uv, 런타임 의존성 2개(pydantic·ruamel.yaml), ruff/mypy strict/pytest(`-m 'not integration'` 기본) 설정, `uv.lock` 커밋

### 테스트 (`tests/`)
| 구분 | 파일 | 커버 속성 |
|---|---|---|
| property | `strategies.py` (공용 도메인 전략 — PBT-07), `test_types_properties.py`(P2), `test_tokens_properties.py`(P4), `test_registry_properties.py`(P1·P3), `test_render_properties.py`(P5·P6·P7·P10), `test_workspace_properties.py`(P9), `test_backoff_properties.py`(P8) | **P1~P10 전부 구현** |
| unit | fakes.py(포트 페이크), test_types/test_tokens/test_registry/test_render/test_config_store/test_hermes_adapter/test_process_manager | V/I/L/G/S/E 규칙 example 검증 |
| integration | `test_hermes_real.py` — 실물 hermes profile 생성→설정 병합→env 주입→삭제 왕복, preflight (marker 게이트) | Build & Test에서 실행 |

## PBT 컴플라이언스 (PBT-02~08, 10)
- Round-trip: P1(레지스트리 JSON), P2(profile명) ✅
- Invariant: P3(포트), P4(토큰), P8(백오프), P9(경로) ✅
- Idempotence: P5(병합), P7(.env) ✅ / Oracle·verification: P6, P10 ✅
- 시드 재현: Hypothesis 기본(실패 시 시드 출력) + pytest 통합, PBT 실패 최소 예시의 example 고정 규약은 유지보수 규칙으로 code-summary에 명시 (PBT-08/10)
- PBT 부적합 영역: 프로세스/파일 부수효과 자체는 example+통합 테스트로 커버 (PBT-10, 근거는 logical-components.md)

## 확장 규칙 반영
- SECURITY-03(마스킹·redact)/05(V1~V6, env 인젝션 방어)/12(CSPRNG·해시·0600)/15(fail-closed) ✅ 코드 반영
- RESILIENCY-10: hermes 60s/docker 30s 타임아웃 상수 ✅

## 잔여 사항 (다음 유닛/단계)
- 통합 테스트 실행 및 CI 정의 → Build & Test 단계 (R7)
- EventSink 구현체(EventBus)·health 폴링·reconcile 루프 → U2
- pyproject `[project.scripts]` 엔트리 → U2(caduceusd)/U3(caduceus)
