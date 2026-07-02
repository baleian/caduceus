# U1 Core Foundation — Business Rules

## 1. 검증 규칙 (입력 경계 — SECURITY-05)

| ID | 규칙 |
|---|---|
| V1 | AgentName: `^[a-z0-9][a-z0-9_-]{0,59}$` 외 거부. 예약어 `default` 거부 (hermes default profile 보호) |
| V2 | docker_image: 비어있지 않은 문자열, 제어문자 금지, 길이 ≤512 |
| V3 | network_mode ∈ {host, bridge_hostgw, none} |
| V4 | cpu>0, memory_mb≥256, disk_mb≥1024 (설정 시) |
| V5 | persona ≤64KB, upstream base_url은 http(s) URL 형식 |
| V6 | 모든 파일 경로 조작은 정규화 후 허용 루트(`~/.caduceus`, profile dir) 내부 확인 (P9) |

## 2. 불변식 (레지스트리 저장 전 검증)

| ID | 불변식 |
|---|---|
| I1 | agent name 유일 |
| I2 | api_port 유일, listen.port와 불충돌 |
| I3 | token_hash 유일·비어있지 않음, 평문 토큰은 어떤 영속 구조에도 부재 |
| I4 | workspace_dir == `~/.caduceus/workspaces/<name>` (파생값 일치) |
| I5 | profile_name == `cad-<name>` |

## 3. 수명주기 규칙 (FD3/FD4)

| ID | 규칙 |
|---|---|
| L1 | gateway 수명 ⊆ caduceusd 수명. 데몬 종료 시 전 gateway graceful 종료 (부팅 지속·OS 서비스 등록 없음) |
| L2 | stop은 비파괴: profile·컨테이너·워크스페이스·세션 불변 |
| L3 | rm: gateway stop → 컨테이너 강제 제거 → profile 삭제 → 레지스트리 제거. **워크스페이스는 어떤 경로로도 삭제하지 않는다** (명시적 사용자 파일 조작만 허용) |
| L4 | rm은 확인 필수 (CLI: 인터랙티브 확인 또는 `--yes`; API: `X-Confirm` 헤더) — 파괴 단계 포함이므로 |
| L5 | create 시 동명 profile 존재 → 실패 (덮어쓰기 금지). 동명 워크스페이스 디렉터리 잔존 시 → 재사용 (이전 산출물 승계, 사용자 고지) |
| L6 | crashlooping (연속 5회 재시작 실패) → 자동 재시도 중단 + 이벤트. 사용자 start로 카운터 리셋 |
| L7 | 데몬 기동 시 desired_state=running 에이전트 자동 spawn |

## 4. 설정 공존 규칙 (FD2)

| ID | 규칙 |
|---|---|
| G1 | config.yaml에서 ManagedConfigKeys만 Caduceus 소유 — 비관리 키는 읽기·보존만 |
| G2 | 관리 키 드리프트 감지 시: 즉시 재적용하지 않고 DriftFinding 이벤트 → reconcile 정책(기본: 경고만; `caduceus agent apply <name>`으로 명시 재적용) |
| G3 | .env는 지정 키만 교체, 파일 모드 0600 유지 |

## 5. 크리덴셜 규칙 (AD-6, SECURITY-12)

| ID | 규칙 |
|---|---|
| S1 | 게이트웨이 토큰: CSPRNG ≥128bit, 평문은 발급 응답과 profile .env에만 존재. 레지스트리·로그·이벤트에는 해시/마스킹만 |
| S2 | 토큰 비교는 해시 기반 상수 시간. 미일치 = 401 (fail-closed) |
| S3 | API_SERVER_KEY: 에이전트별 CSPRNG 생성. 데몬이 chat 중계에 사용하되 클라이언트(브라우저/CLI 출력)에 비노출 |
| S4 | upstream api_key는 환경변수 참조(`api_key_env`)로만 — Caduceus 파일에 평문 저장 금지 |

## 6. 오류 정책 (SECURITY-15, RESILIENCY-10)

| ID | 규칙 |
|---|---|
| E1 | 모든 subprocess(hermes/docker) 호출: 타임아웃 필수, 비정상 종료 시 도메인 예외(stderr 요약 포함, 민감정보 redact) |
| E2 | 레지스트리 손상: fail-closed (백업 후 기동 중단·안내). 부분 손상 무시 진행 금지 |
| E3 | 외부 상태 조회 실패(docker ps 등): status에 `unknown`으로 정직하게 반영 (추측 금지) |
| E4 | 실패한 프로비저닝 잔존물: 자동 파괴 정리 금지 — 상태 `failed` 기록 + 사용자 안내 (L3/L4 보호와 일관) |

## 확장 규칙 매핑

- SECURITY-05→V1~V6, SECURITY-12→S1~S4, SECURITY-15→E1~E4, SECURITY-03(로그 비밀 금지)→S1
- RESILIENCY-06→(health는 U2), RESILIENCY-10→E1 타임아웃
- PBT: business-logic-model.md §8 (P1~P10)
