# U4 Web UI — Code Summary

**Date**: 2026-07-03
**검증**: Python — ruff ✅ · mypy --strict ✅ (43 files) · pytest **472 passed** (신규 11 포함, 실물 integration 4건은 옵트인) / Web — eslint ✅ · tsc strict ✅ · prettier ✅ · Vitest **46 passed** (property 28 = PU4-1~7 전부) · **Playwright E2E 14 passed** (실 데몬+페이크 hermes) · 번들 **85.5KB gzip** (예산 500KB의 17%)

## 생성 파일 — `web/` (SPA, React 18 + TS strict + Vite + Tailwind)

| 계층 | 파일 | 내용 | 설계 계약 |
|---|---|---|---|
| lib (순수) | types / redact / sse / chatMachine / transcript / tail / reducer / forms | React·fetch import 0 (eslint 존 강제). U3 검증 로직 동형 포팅(SSE 파서·chat 전이표·tail dedup·redact) + CoreEvent 리듀서(멱등·바운디드) + W4 검증 | WPT-1/3/5/6, PU4-1~7 |
| api | client / ws / agentApi | 단일 fetch 게이트(토큰·오류 3형태·30s 타임아웃·401 신호·X-Confirm), WS 백오프 재연결+재조회 시퀀스(주입 가능), `/v1/runs` 채팅 플로우 헬퍼 | WPT-2/4/10 |
| state | AppStore / auth / prefs / usePolling | 전역 WS 1구독+순수 shellReducer, fragment 토큰 소비(저장 즉시 제거), 테마, 가시성 연동 폴링 훅 | Q1=A/Q6=A, WPT-8 |
| components | Shell / ConfirmModal / StatusBadge / Toast / Collapsible / JobProgressCard | 4축 네비+연결 배지+테마 토글, 이름 타이핑 확인 게이트(단일 지점), 잡 진행률(WS 우선+폴링 폴백) | W1, WPT-11/12 |
| pages | AgentsPage / AgentDetailPage / LogsTab / SettingsTab / ChatPage / ChatView / GatewayPage / SystemPage | 목록·생성 폼(고급 접기)·상세(202 접수+30s 폴백)·로그 follow·설정(soul/skills/toolsets/approvals/rotate+재시작 배너)·채팅(**W7 재하이드레이션**, 스트리밍/stop/approval/세션 관리, useBlocker 이탈 확인)·게이트웨이(핫스왑+트래픽)·시스템(deep status/잡/드리프트/이벤트 로그) | S-U4-1~8 전부 |
| tests | property 7 + unit 4 + e2e 1 | PU4-1~7 fast-check, API 게이트/WS/ConfirmModal/shellReducer, **F11 전 플로우 브라우저 E2E 14 시나리오** | PBT-02~08/10 |

전 상호작용 요소 `data-testid` 부여 (자동화 친화 규칙). 외부 오리진 참조 0 (완전 자급 — W6).

## 서버측 변경 (in-place)

| 파일 | 변경 | 근거 |
|---|---|---|
| `caduceus/daemon.py` | web_dist 정적 서빙(+`/assets` mount, SPA fallback 캐치올 — index.html 단일 파일만 서빙, traversal 구조적 불가) + SECURITY-04 헤더 세트(CSP `default-src 'self'`/frame-ancestors none/Referrer-Policy/no-store·immutable 캐시) + **미들웨어 순서 교정**(hardening을 최외곽으로 — 401 응답에도 헤더 적용) + `build_daemon(web_dist=)` 테스트 주입 시임 | U4-SEC-1, W5 |
| `caduceus/control/auth.py` | 보호 경로를 `/api/*` + **agent relay 정규식**(`^/agents/{name}/api(/\|$)`)으로 정밀화 — SPA 딥링크(`/agents/{name}`)가 공개 셸(index.html)로 서빙되도록. 데이터 표면 보호는 불변(모든 /api·relay 호출은 여전히 토큰 게이트) | FD 라우트 트리 |
| `caduceus/control/provisioner.py` | **버그 수정**: `spec.persona`가 SOUL.md에 기록되지 않고 무시되던 결함 — create 파이프라인 config_apply에 `write_soul` 추가 (브라우저 E2E가 발견) | F7 |
| `caduceus/cli/main.py` | `caduceus ui`가 admin 토큰을 **URL fragment**로 부착 (`#token=…`) — 서버로 전송되지 않고 SPA가 저장 즉시 제거. 토큰 파일 부재 시 bare URL | Q1=A |
| `pyproject.toml` | **런타임 의존 +1: `websockets`** — bare uvicorn은 WS 업그레이드를 거부(실 브라우저 E2E가 발견 — U2 TestClient는 in-process라 은폐). `/api/events` 실 서빙에 필수 | Q6=A |
| `.gitignore` | web/node_modules·test-results·playwright-report 무시. **web_dist는 의도적으로 커밋**(Node 없이 소스 설치 — N8) | tech-stack §4 |

신규 테스트: `tests/unit/test_web_serving.py`(11 — SPA fallback/relay 게이트 유지/헤더 전수/캐시 정책/ui fragment), `tests/e2e_support/fake_daemon.py`(Playwright 백엔드 — 실 조립 데몬 + 상태ful 페이크 api_server: sessions CRUD/messages/runs SSE 스크립트(slow=stop 검증·approve=승인 플로우)).

## 설계 편차·발견 사항 (FD 편차 기록 방식 — U3 승계)

1. **U3 결정 대체**: `caduceus ui`의 "토큰을 URL에 싣지 않음"(U3)은 FD Q1=A(fragment 전달)로 공식 대체 — fragment는 HTTP 요청에 미포함, 저장 즉시 주소창에서 제거 (business-rules 문서화된 예외)
2. **U2 결함 2건 수정** (E2E 최초 발견): (a) persona 미기록 — CLI `--persona`도 동일하게 무효였음, (b) 실 WS 서빙 불가(`websockets` 미의존) — U2의 WS 검증이 전부 in-process TestClient였던 갭
3. **U2 auth 표면 정밀화**: `/agents/*` 전체 보호 → relay만 보호. SPA 셸은 원래 `/`에서 무인증 서빙되므로 노출 증가 없음
4. **FD 명세 보정**: 에이전트 이름 정규식은 서버 실값 `{0,59}`(FD 문서의 63은 오기), AgentRecord 필드는 `api_port`(FD의 api_server_port 표기 보정), toolsets는 dict가 아닌 `list[str]`(줄 단위 에디터로 구현 — 라운드트립 속성은 동일하게 성립)
5. **접근성 소보완 여지**: 세션 rename/delete 버튼은 hover 노출 — 키보드 전용 사용자는 세션 항목 포커스 후 접근 불가(후속 개선 후보, 기능은 전부 동작)
6. **승인 게이트 중 수정 — `caduceus ui` 터미널 블록** (사용자 실사용 보고): GUI 브라우저 부재 WSL에서 python `webbrowser.open()`이 콘솔 브라우저(w3m)를 터미널에 띄워 블록·URL 미표시. 수정 — URL 최우선 출력, `webbrowser` 모듈 제거, GUI 전용 오프너 fire-and-forget(WSL: wslview→explorer.exe / macOS: open / Linux: DISPLAY 시 xdg-open). U3 `open_ui`의 in-place 재작성 (신규 테스트 3건, 총 pytest 475)
7. **사용자 결정 — 출력 URL에 토큰 fragment 포함** (2026-07-03): 터미널에 인쇄되는 URL도 `#token=` 포함(오프너가 fragment를 소실해도 복사-붙여넣기로 동작). admin 토큰이 hex라 redact 게이트가 마스킹하므로 **ui URL 출력만 redact 우회하는 문서화된 예외** — 근거: 운영자 본인 크리덴셜을 본인 터미널에 표시(= `cat ~/.caduceus/admin.token`과 동일 신뢰 경계). U3 "토큰 원문 미표시" 규칙의 두 번째 명시 예외로 기록
8. **승인 게이트 중 수정 — relay Origin 403** (사용자 실사용 보고): hermes api_server의 CORS 미들웨어는 비허용 `Origin`에 403을 반환하는데, 브라우저가 POST에 자동 부착한 Origin을 relay가 그대로 전달해 세션 생성·turn 시작이 403. 수정 — relay가 브라우저 컨텍스트 헤더(origin/referer/cookie)를 스트립(단일 오리진 설계 정합 — relay는 CLI와 동일한 서버측 인증 클라이언트). 헤더 위생 테스트 신설
9. **승인 게이트 중 수정 — 세션 자동 생성 (CLI 패리티)**: 세션이 없어도 Composer 활성, 첫 메시지 제출 시 세션 lazy 생성 (U3 `resolve_session` 동형 — Q4=A). 진입 시 최근 세션 자동 재개는 기존 동작 유지. E2E를 자동 생성 플로우 검증으로 갱신

## 성공 기준 커버 (unit-of-work.md U4 완료 기준)

- **F11 플로우 전부 브라우저 E2E**: 토큰 게이트(오류/fragment)→생성(잡 9단계 진행률)→검증 미러→start/stop(WS 반영)→설정 편집(배너)→로그(follow)→채팅(스트리밍/재하이드레이션/stop/approval/세션 rename·delete)→게이트웨이 핫스왑→시스템 상태→삭제(X-Confirm 게이트) — **14/14 passed (loopback)**
- **SECURITY-04 헤더 적용 확인**: pytest 전수 검증(401 포함 전 응답) + CSP 외부 오리진 금지

## CI 재현 검증 정의 (Build & Test 단계 인계)

1. `cd web && npm ci && npm run lint && npm run typecheck && npm test && npm run build`
2. `git diff --exit-code caduceus/web_dist` — 커밋된 산출물과 재빌드 일치(드리프트 검출)
3. `uv run ruff check . && uv run mypy caduceus && uv run pytest`
4. (선택·무거움) `cd web && npx playwright install chromium && npm run e2e`
