# U1 Core Foundation — NFR Requirements

**Date**: 2026-07-02

## 성능
- 레지스트리 연산(load/save/조회): 로컬 파일 I/O — 목표 <50ms (에이전트 수백 규모에서도 단일 JSON로 충분, N10 상한 없음)
- `resolve_token`: O(에이전트 수) 해시 비교 — 프록시 핫패스이므로 인메모리 캐시 유지(레지스트리 변경 시 무효화), 목표 <1ms
- config 렌더·병합: 프로비저닝 경로(비핫패스) — 명시 목표 없음

## 신뢰성 (N4)
- 레지스트리 쓰기 원자성(tmp+fsync+rename) — 어떤 시점의 크래시에도 파일은 이전/새 버전 중 하나 (round-trip PBT + 크래시 주입 테스트)
- 손상 시 fail-closed (E2), 자동 복구 시도 금지
- subprocess 호출 타임아웃 기본값: hermes CLI 60s, docker 명령 30s (RESILIENCY-10; 설정 가능)
- 백오프 재시작: 1s 기하 증가, cap 60s, 연속 5회 실패 시 crashlooping 정지 (L6)

## 보안 (N3)
- business-rules.md S1~S4 그대로 (CSPRNG 토큰, sha256 해시, 상수시간 비교, .env 0600, upstream 키는 env 참조만)
- 경로 조작 방어 V6/P9, subprocess 인자 배열 전달(셸 문자열 금지 — 인젝션 방지), 로그 redaction (SECURITY-03)
- 의존성: uv.lock 커밋(SECURITY-10), 취약점 스캔은 CI에 포함(R7 — Build & Test 단계 정의)

## 유지보수성 (N7)
- 순수 로직(렌더링·할당·검증)과 부수효과(subprocess/파일 I/O) 계층 분리 — 어댑터 페이크로 단위 테스트
- 공개 API는 component-methods.md 계약 준수, 타입 힌트 100%, mypy strict 통과
- 테스트: 단위 + Hypothesis PBT(P1~P10) + hermes 실물 통합 테스트(옵트인 마커 — CI에서는 hermes 설치 잡에서만)

## 이식성 (N9)
- Linux(WSL2 포함)·macOS: 경로(Path), 프로세스 시그널(SIGTERM/KILL), 파일 모드 — 플랫폼 분기는 GatewayProcessManager 내부로 국소화 (FD3로 systemd/launchd 분기는 이미 제거됨)

## 확장 규칙 컴플라이언스 (이 단계)
- PBT-09 ✅ Hypothesis 선정·문서화 (tech-stack-decisions.md)
- SECURITY-10 ✅ lock 파일·버전 고정 방침
- RESILIENCY-10 ✅ 타임아웃 기본값 확정
- 기타 규칙: 코드 생성/Build&Test 단계에서 검증
