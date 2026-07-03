# U4 Web UI — Code Generation Plan

**Date**: 2026-07-03
**Unit**: U4 Web UI (C9) — 코드 위치: `web/` (SPA 소스), `caduceus/web_dist/` (빌드 산출물), 서버측 소폭 변경 `caduceus/daemon.py`·`caduceus/cli/bootstrap.py`
**입력 계약**: u4 functional-design 4종 + nfr-requirements 2종 + nfr-design 2종 (전부 APPROVED). **본 계획이 Code Generation의 단일 진실 원천.**
**요구 추적**: F11(Web UI 전체), F6(채팅 렌더·stop·approval — W7 단일 원천), F7(설정 편집), F9(라이프사이클 UI), F4(게이트웨이 UI), N3/N5, SECURITY-04/05/08/10/12/15, PU4-1~7 (PBT blocking)
**의존**: U1~U3 완료 (Admin API·chat 중계·페이크 hermes 테스트 인프라 재사용). 신규 서버 API 0건.
**전 단계 공통 규칙**: TS strict·eslint 존 규칙(WPT-1)·`dangerouslySetInnerHTML` 금지(WPT-6)·상호작용 요소 `data-testid`(`{component}-{element-role}` 명명, 자동화 친화 규칙)

## 생성 단계 (순차 실행, 각 단계 완료 즉시 [x])

### A. 스캐폴드·순수 코어

- [x] Step 1: `web/` 프로젝트 셋업 — package.json(정확 버전 고정+lockfile), vite.config.ts(React 플러그인, Tailwind, dev 프록시 `/api|/v1|/agents|/healthz`→4285, 빌드 출력 `../caduceus/web_dist`, 소스맵 off), tsconfig(strict), eslint(typescript-eslint + 존 규칙 + no-explicit-any + no-restricted-syntax(dangerouslySetInnerHTML)) + prettier, index.html, Tailwind 토큰(다크/라이트 이중 팔레트, class 전략)
- [x] Step 2: `lib/` 순수 모듈 7종 — reducer.ts(CoreEvent 리듀서, 바운디드 불변식), sse.ts(U3 sse.py 동형), chatMachine.ts(U3 전이표 동형), transcript.ts(messages 매핑+tool 실패 상세), tail.ts(U3 tail.py 동형), redact.ts(U1 redact 동형), forms.ts(W4 검증+라운드트립 merge) — React/DOM/fetch import 0
- [x] Step 3: `lib/` property 테스트 (28 passed) — **PU4-1~7 전부** (Vitest+fast-check): SSE 라운드트립+fuzz, 상태 기계 불변식, 리듀서 멱등+바운드, transcript 전 함수성, 폼 라운드트립 무손실, tail 무중복무유실, redact 게이트

### B. 클라이언트 인프라

- [x] Step 4: `api/` — client.ts(단일 fetch 게이트: 토큰 부착·오류 3형태 정규화·30s 타임아웃·401 신호·X-Confirm), ws.ts(백오프 재연결+재조회 시퀀스, 소켓 팩토리 주입), agentApi.ts(sessions CRUD/messages/runs/stop/approval 중계) + 단위 테스트(주입 transport — 계약·타임아웃·401)
- [x] Step 5: `state/` — AppStore(Context+useReducer 바인딩, 초기 REST 스냅샷), useAuth(fragment 파싱→저장→제거, 401 잠금), usePolling(가시성 연동 공통 훅), UiPrefs(테마/thinking 접기) + 테스트(가짜 소켓 재연결 시퀀스 포함)

### C. UI 컴포넌트·페이지

- [x] Step 6: 공용 컴포넌트 — Shell/NavBar/ConnectionBadge, ConfirmModal(이름 타이핑·경량 2변형, 포커스 트랩), StatusBadge, Toast, CollapsibleSection, JobProgressCard + Testing Library 테스트(W1 게이트: 이름 불일치 시 비활성)
- [x] Step 7: Agents — AgentTable/AgentRow(실시간 배지), CreateAgentPanel(AgentForm 검증+202→잡 카드), AgentDetailPage(OverviewTab/ActionBar: start/stop 202 접수·30s 타임아웃 재조회, 삭제 X-Confirm, dashboard 링크) + 폼 검증 테스트
- [x] Step 8: Agent 설정·로그 — SettingsTab(SoulEditor 512KB 게이트, SkillsList 낙관 토글+원복, ToolsetsForm 무손실 merge+RawView, ApprovalsForm, TokenRotate, RestartBanner), LogsTab(LogViewer: 스냅샷+follow 폴링 tail)
- [x] Step 9: Chat — SessionSidebar(목록/생성/이름 변경/삭제 — Q5=B), ChatView(**진입 시 항상 messages 재하이드레이션 — W7**, runs 플로우 SSE 스트리밍, thinking/tool 블록, StopButton, ApprovalCard, Composer idle 게이트, 절단 system-note, streaming 이탈 확인)
- [x] Step 10: Gateway·System — UpstreamForm(핫스왑 즉시 반영), TrafficSummaryTable(WS 증분), RecentRequestsList(≤100), DeepStatusPanel, JobsTable, EventLog(≤500) + 라우팅 연결·테마 토글 완성

### D. 서버측 연결·E2E·산출물

- [x] Step 11: 서버측 — daemon.py: web_dist 정적 서빙+SPA fallback(비-API→index.html)+SECURITY-04 헤더 미들웨어(CSP/frame-ancestors/Referrer-Policy/Cache-Control, 기존 nosniff 유지); bootstrap.py: `caduceus ui` fragment 부착(1줄) + pytest 확장(헤더 존재·fallback·no-store·ui URL)
- [x] Step 12: Playwright E2E — 실 데몬+페이크 hermes 하네스(U2/U3 인프라 재사용, uvicorn 스레드) 위 F11 전 플로우: 토큰 게이트→생성(잡 진행률)→start/stop→soul/skills 편집→chat(스트리밍/stop/approval/세션 관리/재하이드레이션)→gateway 핫스왑→로그 follow→삭제(X-Confirm)
- [x] Step 13: 산출물·패키징 — `npm run build`→`caduceus/web_dist/` 생성·커밋, pyproject package-data 등록, .gitignore 조정(node_modules 등), CI 재현 검증 스텝 정의(웹 lint/tsc/vitest/build 일치)
- [x] Step 14: 전체 검증·문서 — Python(ruff/mypy strict/pytest 전체 회귀) + Web(eslint/tsc/vitest/playwright) 통과, `aidlc-docs/construction/u4-web-ui/code/code-summary.md` 작성(파일 목록·검증 결과·설계 계약 추적·편차 기록)

## 실행 규약

- 단계 실패/설계 편차 발견 시: 편차 사유를 code-summary.md에 기록 (U3 FD 편차 기록 방식 승계), 계약 변경이 필요하면 중단 후 보고
- 검증 명령: `cd web && npm run lint && npm run typecheck && npm test` / `npx playwright test` / `uv run ruff check . && uv run mypy caduceus && uv run pytest`
