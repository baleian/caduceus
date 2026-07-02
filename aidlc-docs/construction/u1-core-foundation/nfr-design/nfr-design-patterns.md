# U1 Core Foundation — NFR Design Patterns

**Date**: 2026-07-02

## 적용 패턴

| 패턴 | 적용 지점 | 설계 |
|---|---|---|
| **Ports & Adapters (Hexagonal)** | 모듈 전체 | 순수 도메인(types, 렌더링, 할당, 검증)과 부수효과 포트(`SubprocessRunner`, `FileStore`, `Clock`) 분리. 테스트는 페이크 포트 주입 — hermes/docker 없이 단위·PBT 실행 (N7) |
| **Write-Ahead 원자성** | RegistryStore | tmp 파일 fsync → `os.replace` (동일 파일시스템 rename 원자성). 저장 전 불변식(I1~I5) 검증 → 위반 시 저장 거부 (fail-closed) |
| **Read-through 캐시 + 명시 무효화** | TokenResolver | 기동/변경 시 `{sha256: agent}` 맵 재구축. 레지스트리 쓰기 성공 후에만 무효화 이벤트 (stale 캐시로 인한 유령 인증 방지 — 제거된 토큰은 즉시 캐시에서도 제거) |
| **Supervisor with capped exponential backoff** | GatewayProcessManager | exit 감지 → desired=running이면 1s×2ⁿ (cap 60s) 재시작, 안정 5분 후 리셋, 연속 5회 실패 시 crashlooping 정지+이벤트. stop/shutdown 경로는 감시 해제 후 SIGTERM→15s→SIGKILL |
| **Single-attempt with actionable error** | HermesAdapter 호출 | 자동 재시도 없음 — 타임아웃/비정상 종료 시 stderr 요약(민감정보 redact)을 담은 도메인 예외. 근거: 프로비저닝 단계는 멱등이 아닐 수 있어 자동 재시도가 부분 상태를 악화시킴. 상위(사용자/Provisioner)가 재시도 판단 |
| **Fail-closed defaults** | 전 경계 | 토큰 미일치→거부, 레지스트리 손상→기동 중단(백업 후), 검증 실패→저장/실행 거부, 경로 이탈→거부 (SECURITY-15) |
| **Comment-preserving merge** | ConfigRenderer | ruamel.yaml round-trip: 관리 키만 교체, 문서 여백·주석·순서 보존 (G1). 멱등성 PBT(P5)로 보증 |
| **Secret hygiene** | 전 모듈 | 평문 토큰 타입을 `SecretStr`(pydantic)로 래핑 — repr/log 자동 마스킹. .env 쓰기 시 0600 유지, 디렉터리 0700 |

## 명시적 비적용 (근거)

- **서킷브레이커/벌크헤드**: 외부 의존이 로컬 subprocess·파일뿐 — 타임아웃+fail-closed로 충분 (RESILIENCY-10의 로컬 적용)
- **큐/외부 캐시/DB**: 규모 특성상 불요 (JSON+인메모리로 충분, P4)
- **분산 락**: 단일 데몬 writer + listen 포트 바인드로 이중 실행 차단 — 파일 락 불요

## 관측성 설계 (N5, SECURITY-03)

- 구조화 로그: `ts, level, event, agent, correlation_id(작업/요청 ID), detail` — 토큰·키 필드는 포맷터 레벨에서 마스킹
- U1은 이벤트 **발행 인터페이스**(콜백/프로토콜)만 정의 — EventBus 구현은 U2. 발행 지점: 프로세스 상태 전이, 레지스트리 변경, 드리프트 감지, 백오프/crashloop
