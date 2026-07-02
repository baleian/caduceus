# U2 Daemon — Business Rules

## 1. 인증·인가 (FD6, SECURITY-08)

| ID | 규칙 |
|---|---|
| A1 | `/api/*`, `/agents/*` 전 요청은 admin 토큰 필수 (deny-by-default). 공개 경로는 `GET /healthz` 단 하나 |
| A2 | `/v1/*`는 에이전트 토큰(U1 TokenResolver)으로만 인증 — admin 토큰으로 LLM 호출 불가 (권한 분리) |
| A3 | 토큰 비교는 상수시간. 인증 실패 응답은 사유 무구분 401 (존재 탐지 방지) |
| A4 | admin.token / registry.json / config.yaml 파일 모드 0600 유지, 로그·이벤트·오류에 토큰/키 평문 금지 (redact) |
| A5 | 파괴적 연산(DELETE /api/agents)은 `X-Confirm: <agent-name>` 헤더 필수 (L4) — 값 불일치 시 400 |

## 2. 입력 검증 (SECURITY-05)

| ID | 규칙 |
|---|---|
| B1 | 모든 요청 본문은 pydantic 스키마 검증 — 미지 필드 거부(extra=forbid), 본문 ≤1MB |
| B2 | 경로 파라미터 `{name}`은 V1(AgentName) 재검증 후 사용 |
| B3 | chat 중계 대상 경로는 허용 프리픽스(`v1/`, `api/sessions`, `health`)만 — 그 외 404, `..`/절대경로 거부 (PU2-4) |
| B4 | 검증 실패 응답은 필드·사유만 (내부 경로·스택 비노출 — SECURITY-09) |

## 3. 프라이버시·관측성 (FD5, SECURITY-03)

| ID | 규칙 |
|---|---|
| P1 | LLM 요청/응답 **본문은 어떤 저장소·로그·이벤트에도 기록하지 않음** — 메타데이터(모델·상태·latency·토큰 수)만 |
| P2 | 사용량은 인메모리 한정 (FD5). 데몬 재시작 시 초기화 — status API에 `since`(데몬 기동 시각) 명시 |
| P3 | 구조화 로그: ts/level/event/agent/correlation(job_id·request_id). 상관 ID는 응답 헤더 `X-Request-Id`로 반환 |
| P4 | 이벤트 발행 실패는 본 작업에 비전파 (관측성 부차 경로) |

## 4. 신뢰성·오류 (SECURITY-15, RESILIENCY-10)

| ID | 규칙 |
|---|---|
| R1 | 모든 외부 호출(업스트림·api_server·subprocess)에 명시 타임아웃 — 값은 §logic-1.1/FD8, 설정 오버라이드 가능 |
| R2 | fail-closed: 인증·검증·레지스트리 손상 → 요청 거부/기동 중단. fail-open 경로 없음 |
| R3 | 클라이언트 오류 응답은 일반화된 메시지 (스택·내부 경로·버전 비노출) |
| R4 | graceful shutdown 순서 준수 (§logic-5) — 강제 종료는 grace 초과 시에만 |
| R5 | reconcile의 자동 조치는 "죽은 desired=running 재기동 1회"로 한정 — 삭제·재적용 등 파괴/변경 조치는 항상 명시적 사용자 명령 |

## 5. 문서화된 예외 (확장 규칙 대비)

| 규칙 | 예외·근거 |
|---|---|
| SECURITY-11 rate limiting | loopback 전용 단일 사용자 컨트롤 표면 — 공개 엔드포인트 부재로 N/A. 게이트웨이 `/v1`의 버짓/제한은 후속 버전 로드맵(R4)에 위임 |
| SECURITY-02 (LB/CDN 로깅) | 네트워크 중개자 부재 — N/A (P3 애플리케이션 로깅으로 충족) |
| SECURITY-04 헤더 | U2는 API만 서빙(SPA는 U4에서 연결) — U4 정적 서빙 연결 시점에 적용 의무 이관, U2는 `X-Content-Type-Options: nosniff`만 선제 적용 |
| CORS | 미허용 (같은 오리진만) — `Access-Control-Allow-Origin` 헤더 자체를 반환하지 않음 |
