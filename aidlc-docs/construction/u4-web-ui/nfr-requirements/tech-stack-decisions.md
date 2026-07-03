# U4 Web UI — Tech Stack Decisions

**Date**: 2026-07-03
**결정 근거**: Q1=A, Q2=A, Q3=B, Q4=A, Q5=A + 사전 결정 (u4-web-ui-nfr-requirements-plan.md)

## 1. 확정 스택

| 영역 | 선택 | 근거 |
|---|---|---|
| 프레임워크 | **React 18 + TypeScript(strict)** | Q1=A — 생태계·문서 최대, 훅/리듀서 모델이 FD 상태 설계와 정합 |
| 빌드 | **Vite** | 표준 React+TS 툴체인, dev 프록시 내장 (§4) |
| 상태관리 | **내장만** — useReducer + Context | Q2=A — 외부 상태 의존 0 (P4). 리듀서는 `src/lib/` 순수 모듈로 분리 (U4-MNT-2) |
| 라우팅 | **react-router-dom** (런타임 의존 +1) | 4축·중첩 탭·URL 파라미터(FD 라우트 트리) — 수제 라우터는 P2 위반(성숙한 표준 존재 시 재구현 금지)으로 기각 |
| 스타일 | **Tailwind CSS** (빌드타임 전용) | Q3=B — 런타임 의존 0, 다크모드 변형 내장. 디자인 토큰은 Tailwind 테마 변수로 정의 (Q5=A 이중 팔레트) |
| 테마 | 다크/라이트 자동 + 토글 | Q5=A — `prefers-color-scheme` 기본, class 전략 토글, UiPrefs(localStorage) |
| 단위/속성 테스트 | **Vitest + fast-check** | 사전 결정 — PBT-09. PU4-1~7은 jsdom 불요(순수 모듈) |
| 컴포넌트 테스트 | Vitest + jsdom + Testing Library | 폼 검증·모달 게이트 등 상호작용 규칙(W1/W4) 검증 |
| E2E | **Playwright (chromium)** | Q4=A — F11 브라우저 E2E 완료 기준 직접 충족. 페이크 hermes + 실 데몬(U2/U3 테스트 인프라 재사용) 위에서 실행 |
| 린트/포맷 | eslint(typescript-eslint) + prettier | Python 측 ruff/mypy 대칭 (U4-MNT-5) |
| 패키지 매니저 | **npm** (+ package-lock.json 커밋) | 추가 도구 미도입 (P4), lockfile 무결성 CI 검사 (SECURITY-10) |
| Node 요구 | ≥ 20 LTS — **개발·CI 전용** | 최종 사용자 런타임 Node 의존 0 (사전 결정) |

## 2. 의존성 목록 (정확 버전 고정 — 설치 시점 최신 안정으로 lockfile 고정)

- **런타임 (3)**: react, react-dom, react-router-dom
- **개발**: vite, @vitejs/plugin-react, typescript, tailwindcss(+@tailwindcss/vite), vitest, fast-check, jsdom, @testing-library/react, @playwright/test, eslint, typescript-eslint, prettier
- 그 외 런타임 의존 추가는 P2 사유 문서화 필수 (예: 차트/마크다운 — §5 참조)

## 3. 코드 조직

```text
web/
├── src/
│   ├── lib/            # 순수 TS (React 무관) — PBT 지대
│   │   ├── reducer.ts        # WS 이벤트 리듀서 (PU4-3)
│   │   ├── sse.ts            # SSE 파서 (PU4-1 — U3 sse.py 동형 포팅)
│   │   ├── chatMachine.ts    # run 상태 기계 (PU4-2 — U3 chat.py 전이표 동형)
│   │   ├── transcript.ts     # messages→transcript 매핑 (PU4-4)
│   │   ├── tail.ts           # 로그 dedup (PU4-6 — U3 tail.py 동형)
│   │   ├── redact.ts         # redact 게이트 (PU4-7)
│   │   └── forms.ts          # 검증·라운드트립 (PU4-5, W4 정규식 단일 상수)
│   ├── api/            # REST/WS/SSE 클라이언트 (fetch 래퍼, 토큰 부착, 오류 매핑)
│   ├── state/          # Context/Provider (lib 리듀서의 React 바인딩)
│   ├── components/     # 공용 (ConfirmModal, StatusBadge, Toast, …)
│   ├── pages/          # agents/ agent-detail/ chat/ gateway/ system/
│   └── main.tsx / App.tsx
├── tests/              # Vitest unit/property, Playwright e2e/
├── index.html  package.json  vite.config.ts  tsconfig.json
```

## 4. 빌드·데몬 통합

- **프로덕션**: `npm run build` → `caduceus/web_dist/` 출력 → pyproject package-data로 wheel 동봉 → caduceusd 정적 서빙(U2 자리표시자 연결 + U4-SEC-1 헤더)
- **web_dist는 git에 커밋** — `pip install git+…`/소스 체크아웃 설치가 Node 없이 동작 (N8 손쉬운 설치). 재빌드는 릴리스/CI에서만, CI가 "src 변경 시 web_dist 재현 일치"를 검증 (드리프트 방지)
- **개발**: Vite dev server가 `/api`·`/v1`·`/agents`·`/healthz`를 로컬 caduceusd로 프록시 (HMR 개발 루프). SPA fallback: 데몬은 비-API 경로를 index.html로 서빙 (BrowserRouter 지원)

## 5. 기각·유예 결정 (P2/P4 기록)

| 항목 | 결정 | 사유 |
|---|---|---|
| 마크다운 렌더러 (채팅) | **v1 미도입** — plain text + pre-wrap | sanitizer 없는 HTML 렌더는 XSS 표면 (U4-SEC-2). 도입 시 sanitize 체인 필요 → 후속 검토 항목으로 유예 |
| 차트/그래프 (트래픽) | 미도입 — 수치 표만 | 의존·번들 대비 가치 낮음 (P4) |
| 상태관리/데이터 페칭 라이브러리 | 미도입 | Q2=A |
| 목록 가상화 | 미도입 | N10 준수는 상한 미하드코딩으로 충족, 실측 문제 시 후속 |
| i18n | 미도입 — UI 문안 영어 단일 | 로컬 개발자 도구 (P4) |
