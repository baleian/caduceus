# U4 Web UI — Business Rules

**Date**: 2026-07-03
**전제**: domain-entities.md, business-logic-model.md. 규칙 위반은 코드 생성 단계의 blocking 결함.

## W1. 파괴적 조작 확인 (A5 승계)

- **에이전트 삭제**: 모달에서 에이전트 이름을 정확히 타이핑해야 [삭제] 활성화 → `X-Confirm: <name>` 헤더 전송. 모달 문구에 "워크스페이스는 보존됩니다 (경로: ...)"를 명시. purge 없음 (L3)
- **세션 삭제** (Q5=B): 경량 확인(세션 제목 표시 + [삭제/취소]) — 이름 타이핑까지는 불요(에이전트 삭제보다 낮은 파급)
- **토큰 회전**: 확인 다이얼로그 필수 ("해당 에이전트 게이트웨이 재시작 필요" 고지)
- 확인 상태는 재사용 금지 — 모달 1회 = 요청 1회

## W2. 토큰·비밀 비노출 (S3 승계)

- admin 토큰·게이트웨이 토큰·API_SERVER_KEY·업스트림 api_key 원문은 **어떤 DOM/토스트/콘솔 로그에도 미표시** (upstream 폼은 api_key_env 변수명만 다룸 — 원문은 서버도 저장하지 않는 기존 계약)
- 스트리밍/로그 렌더 경로는 단일 redact 게이트를 통과 (U1 `redact` 규칙의 TS 동형 — PU4-7)
- admin 토큰의 유일한 저장처는 localStorage(사용자 브라우저) — sessionStorage/쿠키/URL 잔존 금지 (fragment는 저장 즉시 제거)
- WS 인증은 query param `?token=` (U2 실 계약) — WS URL을 로그·화면에 출력하지 않음

## W3. 인증 실패 UX (fail-safe, SECURITY-15)

- 401 수신 → 저장 토큰을 invalid 마크(삭제하지 않음 — 오타 재입력 배려) → 전면 토큰 화면. 자동 재시도 없음(재시도 폭풍 금지)
- 403/409/422 등은 조작 지점 인라인 오류로 표시 — 전역 로그아웃 아님
- 데몬 자체 다운(네트워크 오류): 전면 "데몬에 연결할 수 없음" 화면 + `caduceus serve` 안내 (U3 exit 3 메시지와 동일 문구 계열)

## W4. 입력 검증 (SECURITY-05)

- **클라이언트 검증은 UX용, 서버 응답이 항상 권위** — 서버 422를 그대로 필드 오류로 표시할 수 있어야 함
- 에이전트 이름: hermes profile 규칙 `^[a-z0-9][a-z0-9_-]{0,63}$`을 폼에서 선검증 (서버와 동일 정규식 — 단일 상수로 관리)
- cpu/memory/image/network: 서버 AgentSpec 스키마의 허용값을 폼 옵션으로 제한 (자유 텍스트 최소화)
- soul/persona 에디터: 크기 상한(서버 1MB 본문 제한 B1보다 여유 하향, 예: 512KB) 초과 시 제출 차단
- chat 입력: 빈 문자열 제출 금지 외 제한 없음 (내용 검열 없음 — 서버/hermes 소관)

## W5. 서빙 보안 헤더 (SECURITY-04 — 서버측, U4 범위)

caduceusd 정적 서빙·API 응답에 적용 (U2 자리표시자의 완성):

- `Content-Security-Policy`: `default-src 'self'; connect-src 'self' ws:` 계열 — 외부 오리진 금지(SPA는 완전 자급, CDN 불사용), `frame-ancestors 'none'`
- `X-Content-Type-Options: nosniff` (U2 기적용 — 유지 확인)
- `Referrer-Policy: no-referrer`
- `Cache-Control`: 해시된 정적 자산 long-cache, `index.html`·API는 no-store
- CORS 헤더는 **추가하지 않음** — 단일 오리진 설계이므로 부재가 곧 방어

## W6. 네트워크 경계 (N3)

- SPA의 모든 호출은 상대 경로 — 브라우저 주소의 오리진(= loopback caduceusd) 외 대상 없음
- 외부 리소스(폰트/스크립트/이미지 CDN) 로드 금지 — 오프라인(local-first, N2) 동작 보장

## W7. 세션 히스토리 단일 원천 (사용자 지시 2026-07-03)

- 대화 기록의 원천은 **hermes api_server 세션 저장소가 유일** — SPA는 히스토리를 localStorage/IndexedDB 등에 저장하지 않음
- 세션 진입·재진입·새로고침 시 항상 `GET api/sessions/{id}/messages`로 재하이드레이션
- 스트리밍 렌더 버퍼는 휘발성 렌더 캐시일 뿐이며, 서버 기록과 충돌 시 서버가 이긴다 (재하이드레이션으로 해소)

## W8. 실시간 정합 (N4/N5)

- WS 리듀서는 멱등이어야 함 (PU4-3) — 리플레이·재연결 중복 수신이 상태를 오염시키지 않음
- WS 두절 중 UI는 stale임을 표시(연결 배지) — stale 데이터로 파괴적 조작을 유도하지 않도록 조작 버튼에는 최종 동기 시각 기준 경고 없음(조작은 어차피 서버 검증) 단, 배지는 상시 노출
- 자원 규칙: 폴링(잡 폴백·로그 follow)은 해당 화면 표시 중에만, WS는 앱 전역 1개만

## W9. 표시 규칙

- 상태 배지는 U2 `synthesize_status` 합성값을 그대로 표시 — 클라이언트에서 상태를 재합성/추론하지 않음 (진실 테이블은 서버 소유)
- 트래픽 수치는 서버 카운터 원천 + WS 증분 — 불일치 시 REST 재조회가 권위
- 시각은 서버 ISO 8601 그대로 받아 로컬 표기 변환만

## 문서화된 예외

- **fragment 토큰 전달(Q1=A)**: URL에 비밀이 실리는 유일 지점 — fragment는 HTTP 요청에 미포함·저장 즉시 제거로 완화. 대안(수동 입력 전용) 대비 UX 이득으로 채택 (audit 2026-07-03)
- **localStorage 토큰 보관**: XSS 시 탈취 가능하나 W5 CSP(외부 오리진 전면 금지)+자급 SPA로 공격면 최소화. loopback 단일 사용자 도구라는 위협 모델에서 수용 (SECURITY-12와의 절충 기록)
