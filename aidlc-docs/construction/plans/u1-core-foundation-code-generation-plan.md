# U1 Core Foundation — Code Generation Plan

**Date**: 2026-07-02
**단일 진실 원천**: 이 플랜이 U1 코드 생성의 유일한 실행 목록이다.

## Unit Context

- **구현 요구사항**: F1(설정·profile 생성 기반), F2/F3(terminal config 렌더), F4(토큰), F5(network_mode 변환), F7(soul/skills/toolsets 조작), F9(프로세스 관리 기반), N3/N4/N7/N9/N10
- **의존**: 없음 (최하층 유닛). hermes CLI·docker는 런타임 외부 의존 (포트 뒤로 격리)
- **제공 인터페이스**: component-methods.md C2/C6/C7 계약 → U2가 소비
- **코드 위치**: 워크스페이스 루트 `caduceus/core/` (승인된 unit-of-work.md 조직 — aidlc-docs/ 금지)
- **설계 입력**: functional-design/ (FD1~FD4, V/I/L/G/S/E 규칙, P1~P10), nfr-design/ (패턴·논리 컴포넌트·테스트 매핑), tech-stack (uv/pydantic/ruamel/Hypothesis)

## Generation Steps

- [x] **Step 1: 프로젝트 구조 셋업 (greenfield)** — `pyproject.toml` (uv, 런타임 deps: pydantic≥2·ruamel.yaml; dev: pytest·pytest-asyncio·hypothesis·mypy·ruff; 스크립트 엔트리 자리표시), `caduceus/__init__.py`, `caduceus/core/__init__.py`, `tests/{unit,property,integration}/__init__.py`, ruff/mypy strict 설정, `uv lock` 생성 (SECURITY-10)
- [x] **Step 2: 도메인 기반** — `caduceus/core/types.py` (AgentName 검증 V1, AgentSpec V2~V5, AgentRecord I4/I5 파생 검증, RegistryFile v1, NetworkMode, AgentStatus, CaduceusConfig), `errors.py`, `ports.py` (SubprocessRunner/FileStore/Clock/EventSink 프로토콜)
- [x] **Step 3: 도메인 기반 테스트** (29 passed) — PBT: P2(name↔profile round-trip, Hypothesis 전략 `agent_names()` 공용 모듈 tests/property/strategies.py — PBT-07 재사용), example: V1~V5 거부 케이스, 예약어 `default`
- [x] **Step 4: 토큰 서비스** — `tokens.py` (CSPRNG 발급 `cad-<name>-<32hex>`, sha256, 상수시간 resolve+캐시·무효화, 회전, SecretStr 마스킹)
- [x] **Step 5: 토큰 테스트** (8 passed) — PBT: P4 (issue→resolve 항등, 회전 후 구토큰 거부, 해시≠평문), example: repr/log 마스킹
- [x] **Step 6: 레지스트리** — `registry.py` (load fail-closed+`.corrupt-<ts>` 백업, 원자적 save(tmp+fsync+os.replace), CRUD, 불변식 I1~I5 저장 전 검증, 포트 할당 §logic-2, 스키마 마이그레이션 훅)
- [x] **Step 7: 레지스트리 테스트** (12 passed) — PBT: P1(save→load round-trip), P3(포트 불변식·결정성), 불변식 위반 저장 거부; example: 손상 파일 fail-closed, 빈 파일 초기화
- [x] **Step 8: 설정 렌더러** — `render.py` (ManagedConfigKeys 생성, network_mode→docker 인자 P10 테이블, workspace bind, ruamel round-trip 병합 G1, .env 라인 편집 0600, 드리프트 비교)
- [x] **Step 9: 렌더러 테스트** (13 passed — ruamel 따옴표 스타일 보존 확인 포함) — PBT: P5(병합 멱등)·P6(관리 키 일치)·P7(.env 멱등·보존)·P10(모드 전사); example: 주석·순서 보존 스냅샷 (hermes cli-config 형태 픽스처)
- [x] **Step 10: 워크스페이스·Caduceus 설정** — `workspace.py` (생성·V6/P9 경로 검증, 삭제 API 부재), `config.py` (`~/.caduceus/config.yaml` 로드/검증/원자적 저장, 기본값)
- [x] **Step 11: 워크스페이스·설정 테스트** (13 passed) — PBT: P9(임의 name→경로 격납·traversal 불가); example: config 기본값·검증
- [x] **Step 12: Hermes Adapter** — `hermes_adapter.py` (profile create/delete cad- 프리픽스 L5, config/env/SOUL/skills/toolsets 조작 — render 사용, preflight DoctorReport, 타임아웃 E1, stderr redact)
- [x] **Step 13: Hermes Adapter 테스트** (18 passed — skills.disabled/platform_toolsets/--yes 플래그는 hermes 소스에서 검증한 규약 사용) — example: 페이크 러너 argv·타임아웃·오류 변환 검증, L5 충돌 거부; (실물 통합은 Step 16)
- [x] **Step 14: Gateway Process Manager** — `process_manager.py` (asyncio spawn `hermes -p <profile> gateway`, exit 감시, 백오프 순수 함수 분리, crashloop L6, graceful stop SIGTERM→15s→SIGKILL, 로그 링버퍼, shutdown 전체 정지 L1, EventSink 방출)
- [x] **Step 15: Process Manager 테스트** (12 passed) — PBT: P8(백오프 수열); example: 페이크 프로세스(sleep 스크립트)로 재시작·정지·crashloop 시나리오
- [x] **Step 16: 통합 테스트 (marker `integration`)** — 실물 hermes: profile create→config 병합→.env 주입→delete 왕복; docker preflight (환경 없으면 skip)
- [x] **Step 17: 문서화** — `aidlc-docs/construction/u1-core-foundation/code/code-summary.md` (파일 목록, 계약 이행 매핑, PBT 커버리지 표)
- [x] **Step 18: 로컬 검증 실행** (ruff ✅, mypy --strict ✅, pytest 105 passed / 2 integration deselected) — `uv run ruff check`, `uv run mypy --strict caduceus`, `uv run pytest tests/unit tests/property` 전부 통과 (통합 테스트는 Build & Test에서)

## 확장 규칙 반영 지점
- PBT-02/03/04/05/07/08: Steps 3/5/7/9/11/15 (시드 로깅 pytest 설정 포함)
- SECURITY-03/05/12/15: Steps 2/4/8/12 (검증·마스킹·0600·fail-closed)
- RESILIENCY-10: Steps 12/14 (타임아웃)
