# U1 Core Foundation — Business Logic Model

기술 중립(구현 프레임워크 무관) 로직 정의. 시그니처는 component-methods.md C2/C6/C7 기준 (C7은 FD3에 따라 GatewayProcessManager로 재정의 — application-design.md Amendments 참조).

## 1. Registry 영속성 (C2)

- **load**: 파일 없음→빈 레지스트리(v1) 생성 / 파싱 실패·스키마 불일치→**fail-closed** (기동 중단, 손상 파일은 `.corrupt-<ts>` 백업 후 안내 — 자동 덮어쓰기 금지)
- **save**: 직렬화→tmp 파일 fsync→rename (원자성). 저장 전 불변식 검증(§rules)
- **동시성**: 쓰기는 데몬 단일 프로세스 내 직렬화(단일 writer). 이중 데몬 방지는 listen 포트 바인드 실패로 자연 차단
- **버전**: `schema_version` 불일치 시 마이그레이션 훅(v1은 자기 자신)

## 2. 포트 할당 (C2)

```
allocate_port(registry, cfg):
  used = {r.api_port for r in registry} ∪ {cfg.listen.port}
  p = cfg.agents.port_base
  while p in used or os_port_in_use(p): p += 1   # 상한 하드코딩 없음 (N10)
  return p
```
- 결정성: 동일 (used, base) 입력 → 동일 결과. 해제된 포트는 재사용 가능

## 3. 토큰 수명주기 (C2, AD-6)

- **발급**: `cad-<name>-<random 32 hex (CSPRNG)>` → 평문은 1회 반환(프로비저닝이 profile `.env`에 주입), 레지스트리에는 `sha256(token)` 저장
- **검증**: `resolve_token(bearer)`: sha256(bearer)를 전 레코드 해시와 **상수 시간 비교** — 일치 없으면 None (fail-closed)
- **회전**: 새 토큰 발급→.env 재주입→해시 교체 (구 토큰 즉시 무효). 평문은 응답·로그에 비노출 (SECURITY-03/12)

## 4. Gateway 자식 프로세스 관리 (C7 재정의: GatewayProcessManager, FD3)

- **spawn**: `hermes -p cad-<name> gateway` 자식 프로세스 실행 (stdout/err → 데몬 로그 파이프, per-agent 링버퍼)
- **monitor**: 자식 exit 감지 → desired_state=running이면 **백오프 재시작**: 1s→2s→4s→…→cap 60s, 성공 유지 5분 후 카운터 리셋. 연속 N(기본 5)회 실패 시 `crashlooping` 상태 + 이벤트 (자동 재시도 중단, N4)
- **stop (비파괴, FD4)**: 진행 중 run stop 시도(U2 위임) 후 SIGTERM → grace 기간(기본 15s) 초과 시 SIGKILL. profile·컨테이너·워크스페이스 불변
- **shutdown**: 데몬 종료 시 전 자식 병렬 graceful stop — gateway 수명 ⊆ 데몬 수명
- **비책임**: 부팅 지속·OS 서비스 등록 없음 (FD3 사용자 확정 — systemd/launchd 통합 제거)

## 5. Profile 설정 렌더링 (C6)

### 5.1 config.yaml 병합 쓰기 (FD2)
```
render_managed(spec, ports, cfg) -> dict     # ManagedConfigKeys만 생성
merge_config(existing_yaml, managed) -> yaml # 관리 키는 교체, 비관리 키는 보존
```
- network_mode 변환: `host`→`docker_extra_args: ["--network=host"]` / `bridge_hostgw`→`["--add-host=host.docker.internal:host-gateway"]` / `none`→`network: false`
- workspace bind (FD4): `terminal.docker_volumes: ["<abs ~/.caduceus/workspaces/<name>>:/workspace"]`, `terminal.cwd: /workspace`
- 항상: `terminal.backend: docker`, `container_persistent: true`, `model.provider: custom`, `model.base_url: http://127.0.0.1:<daemon>/v1`
- **멱등**: merge(merge(x)) = merge(x). 드리프트 감지: 현재 파일의 관리 키 ≠ 기대값 → DriftFinding (재적용은 reconcile 정책)

### 5.2 .env 주입
- `set_env_kv(profile, key, value)`: 기존 키 교체/신규 추가, 타 키 보존, 파일 모드 0600
- 주입 키: `OPENAI_API_KEY`(게이트웨이 토큰), `API_SERVER_ENABLED=1`, `API_SERVER_PORT`, `API_SERVER_KEY`

### 5.3 SOUL.md / skills / toolsets (F7)
- read/write 파일 그대로 (hermes 규약 준수), 변경 후 "gateway 재시작 필요" 신호 반환

## 6. Profile 수명주기 (C6, FD4)

- **create**: `hermes profile create cad-<name>` (충돌 시 실패 — 기존 profile 덮어쓰기 금지) → 5.1/5.2 렌더
- **delete (rm)**: gateway stop → 컨테이너 제거(`docker rm -f`, 라벨 `hermes-profile=cad-<name>` 매칭) → `hermes profile delete cad-<name>` → 레지스트리 제거. **워크스페이스 디렉터리는 절대 삭제하지 않음** (rm 후에도 `~/.caduceus/workspaces/<name>/` 잔존 — 사용자가 명시적으로만 정리)
- **stop→start**: 프로세스만 정지/재개. 컨테이너는 hermes가 라벨 재사용으로 재기동(F3 지속)

## 7. Preflight (C6)

- 검사: hermes CLI 존재·버전, docker 데몬 접근, `~/.caduceus` 쓰기 가능, upstream base_url 형식
- 결과: `DoctorReport {checks: [(name, ok, detail)]}` — 실패 항목은 조치 안내 포함

## 8. Testable Properties (PBT-01 — 코드 생성으로 전달)

| # | 대상 | 속성 | 카테고리 |
|---|---|---|---|
| P1 | RegistryFile 직렬화 | `load(save(r)) == r` (임의 유효 레지스트리) | Round-trip |
| P2 | AgentName↔profile명 | `strip("cad-"+n) == n`, 유효성 보존 | Round-trip |
| P3 | 포트 할당 | 결과 ∉ used, 결정성(동일 입력→동일 출력), used 크기 불변 | Invariant |
| P4 | 토큰 | `verify(issue().plain) == agent`, 회전 후 구 토큰 검증 실패, 해시≠평문 | Invariant |
| P5 | config 병합 | `merge(merge(y,m),m) == merge(y,m)` (멱등), 비관리 키 보존 | Idempotence + Invariant |
| P6 | config 병합 | 관리 키 값은 렌더 결과와 일치 (YAML parse 후 비교) | Easy verification |
| P7 | .env 주입 | 대상 키 교체·타 키/순서 보존, `set(set(e,k,v),k,v) == set(e,k,v)` | Idempotence |
| P8 | 백오프 수열 | 단조 비감소, cap 이하, 리셋 후 초기값 | Invariant |
| P9 | 워크스페이스 경로 | 항상 `~/.caduceus/workspaces/` 하위, traversal 불가 (임의 name 입력) | Invariant (보안) |
| P10 | network_mode 변환 | 3모드 전사, 산출 인자 집합이 모드별 기대와 일치 | Oracle (테이블) |

- 속성 미식별 컴포넌트: GatewayProcessManager의 OS 프로세스 상호작용 자체는 PBT 부적합(부수효과) — 백오프 계산(P8) 등 순수 부분만 추출해 PBT, 나머지는 example-based+통합 테스트 (PBT-10)
