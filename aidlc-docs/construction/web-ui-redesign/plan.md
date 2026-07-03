# U4 Web UI 전면 재설계 — 설계서 & 코드 생성 계획

**Status**: GENERATED — 승인 게이트 대기 (Q1=A, Q2=A, Q3=B, Q4=A 반영)
**Date**: 2026-07-03
**Scope**: `web/` 프레젠테이션 레이어 전면 교체. 로직 레이어(api/, lib/, state/)는 보존.

---

## 1. 배경 및 목표

현재 U4 Web UI는 기능적으로 완성(E2E 14/14)되었으나 시각 디자인·레이아웃·정보 구조가
최소 수준이다. 사용자 요청: **상용 오픈소스 제품 수준의 디자인 퀄리티**, **데스크톱(16:9)
최적화**, **시각화 라이브러리 도입 허용**, **brand assets 활용 검토**, **기존 구조 전면 교체 허용**.

## 2. UX 감사 — 현재 구조의 문제점

| # | 문제 | 위치 |
|---|------|------|
| P1 | `max-w-6xl`(1152px) 중앙 고정 — 1920px 화면에서 좌우 40%가 빈 공간 | Shell.tsx |
| P2 | 랜딩이 Agents 테이블 — 시스템 전체 상태(트래픽/비용/헬스)를 한눈에 볼 곳이 없음 | App.tsx 라우팅 |
| P3 | 상단 텍스트 탭 내비 — 데스크톱 관리도구 관례(사이드바)와 다르고 확장성 없음 | Shell.tsx |
| P4 | Agents가 맨 테이블: 검색/필터 없음, 행에서 start/stop/chat 불가(상세 진입 강제) | AgentsPage.tsx |
| P5 | Create 폼이 인라인 확장 — 목록을 밀어내고 컨텍스트 상실 | AgentsPage.tsx |
| P6 | 채팅: 마크다운 미렌더(코드블록·표·목록이 plain text), 세션 패널 224px에 밀착, 대화 영역 시각 위계 부재 | ChatView.tsx |
| P7 | Gateway 지표가 전부 숫자 테이블 — 토큰/비용/트래픽은 차트가 본질적으로 적합 | GatewayPage.tsx |
| P8 | 브랜드 부재: 유니코드 `☤` 텍스트 로고, assets(그라디언트 로고/아이콘) 미사용 | Shell, TokenGate |
| P9 | 로딩·빈 상태가 한 줄 텍스트 — 스켈레톤/일러스트 빈 상태 없음 | 전 페이지 |
| P10 | 상태 뱃지가 회색 텍스트 위주로 스캔 어려움; 아이콘 체계 없음 | StatusBadge 외 |

## 3. 재설계 원칙

1. **Desktop-first, 16:9 최적**: 전폭 사용. 1440–1920px에서 정보 밀도 극대화, 12-col 그리드.
2. **Observability 제품 문법**: 사이드바 셸 + 대시보드 홈 + 카드/차트 (Grafana·Vercel·Portainer 계열 관례).
3. **로직 불가침**: `api/`, `lib/`, `state/`의 검증된 동작(W7 재수화, 상태머신, redact, tail, WS 재연결)은
   그대로 사용. 프레젠테이션만 교체.
4. **브랜드 일관성**: assets 그라디언트(#56b3fa→#7c6cf0→#cf63ee)를 액센트 시스템으로 승격.
5. **E2E 계약 유지**: 기존 `data-testid` 전부 보존(라우팅 변경분만 스펙 수정).

## 4. 정보 구조 & 레이아웃

```text
+--------------------------------------------------------------+
| SIDEBAR (240px,   |  CONTENT (fluid, full-bleed)             |
| 64px로 접힘)      |                                          |
|                   |  Dashboard  : 스탯 타일 4-6개 + 차트 2열 |
|  [logo]           |  Agents     : 툴바(검색) + 리치 테이블   |
|  Dashboard        |  Agent 상세 : 히어로 헤더 + 탭           |
|  Agents           |  Chat       : 세션(280px)|대화|메타(우측)|
|  Chat             |  Gateway    : 설정 카드 + 사용량 차트    |
|  Gateway          |  System     : 헬스 카드 + 잡/이벤트      |
|  System           |                                          |
|  ----------       |                                          |
|  ● connected      |                                          |
|  theme / token    |                                          |
+--------------------------------------------------------------+
```

- **사이드바**: 로고(logo.svg 인라인), 아이콘+라벨 내비, 하단에 연결 상태·테마 토글.
  접힘 상태는 prefs에 저장. `nav-*-link` testid 유지.
- **콘텐츠**: `max-w` 제거, `px-8 py-6`, 페이지 내부에서 12-col grid로 배치.
  와이드 모니터에서 카드가 무한히 늘어지지 않도록 카드 단위 `max-w`만 사용.
- **Chat만 전고(full-height) 레이아웃**: 스크롤은 대화 영역 내부에서만.

## 5. 디자인 시스템

### 색 (dark-first, 라이트 팔레트 병행 유지)
- **Dark**: bg `#0b0d16` / surface `#12141f` / panel `#181b2a` / edge `rgba(148,163,184,.12)`
  / ink `#e7eaf4` / ink-dim `#8b93ab`
- **Light**: 기존 slate 계열 유지하되 채도 정리.
- **Accent**: brand violet `#7c6cf0` (single accent), 브랜드 모먼트(활성 내비, 주요 버튼,
  로그인 카드)에만 그라디언트 `linear(#56b3fa, #7c6cf0, #cf63ee)` 사용. 남용 금지.
- **Semantic**: ok `#34d399` / warn `#fbbf24` / bad `#f87171` (dark 기준, light는 진한 톤).

### 타이포
- UI: **Inter Variable** (`@fontsource-variable/inter`, 번들 — 외부 CDN 없음)
- 코드/로그/mono: **JetBrains Mono** (`@fontsource/jetbrains-mono`)
- 스케일: 12/13(본문)/14/16/20/24. 관리도구 밀도 우선.

### 컴포넌트 킷 (`src/components/ui/`)
`Button`(primary/ghost/danger/outline) · `Card`(+CardHeader) · `StatTile`(값+라벨+델타)
· `Badge`(상태 dot+텍스트, 기존 StatusBadge 대체·testid 유지) · `Drawer`(우측 슬라이드)
· `Modal`(ConfirmModal 재스킨) · `EmptyState`(아이콘+제목+행동 버튼) · `Skeleton`
· `SearchInput` · `Tabs` · `Tooltip`(title 속성 기반 간이). 아이콘: **lucide-react**.

## 6. 페이지별 설계

### 6.1 Dashboard (신설, `/` 랜딩)
- 스탯 타일: Agents(running/total), Requests, Errors(에러율), Est. cost(전 에이전트 합), Active jobs.
- **Traffic 차트**: WS `recentRequests`를 시간 버킷으로 집계한 라이브 영역차트(Recharts).
- **토큰 사용량 차트**: 에이전트별 input/cache/output 스택 가로 막대 (Gateway fan-out 재사용).
- 우측 레일: Drift/orphan 알림 피드 + 최근 잡 5건.
- 데이터 소스는 전부 기존 API/스토어 — 신규 백엔드 작업 없음.

### 6.2 Agents
- 툴바: 검색(이름 필터) + `New agent` 버튼(우측 **Drawer**로 열림 — P5 해결).
- 리치 테이블: 상태 dot, 이미지·네트워크 요약, **행 인라인 액션**(start/stop/chat) — P4 해결.
- 기존 form 검증/submit 로직·`agent-create-*` testid 그대로 Drawer 내부로 이동.

### 6.3 Agent 상세
- 히어로 헤더: 이름 + 대형 상태 뱃지 + 액션 버튼 그룹(Start/Stop/Chat/hermes/Remove) sticky.
- Overview: 정보 카드(2열) + 세션 사용량 미니 차트 + 최근 로그 프리뷰 카드.
- Logs/Settings 탭: 로직 그대로, 카드·뷰어 스킨 교체 (로그 뷰어: mono, 전폭, sticky 툴바).

### 6.4 Chat (최대 개편)
- 3열: 세션 패널(280px, 상대시간·활성 하이라이트) | 대화(가변, 본문 measure ~`max-w-3xl` 중앙)
  | 메타 레일(세션 usage, 에이전트 상태, xl 이상에서 표시).
- **마크다운 렌더링**: `react-markdown` + `remark-gfm` + `rehype-highlight` — P6 해결.
  redact 파이프라인은 렌더 전 원문에 그대로 적용(보안 불변).
- 툴콜: 칩(⚙ 이름 + 상태색 + duration) → 클릭 시 프리뷰/결과 확장.
- Approval: 경고 카드 재스킨(승인 버튼 위계 명확화).
- 컴포저: auto-grow textarea, 전송/중지 아이콘 버튼, 단축키 힌트. 기존 상태머신 그대로.

### 6.5 Gateway
- Upstream 설정 카드(hot-swap) — 폼 스킨 교체.
- 토큰 사용량: 스택 막대 차트 + 비용 열 강조된 테이블 병행.
- 트래픽: 라이브 요청 타임라인 차트 + Recent requests 테이블(상태코드 색상).

### 6.6 System
- 헬스 요약 카드(업스트림, 트래픽 합계, 에이전트 상태 그리드).
- 잡 테이블(확장 행 유지), 알림·이벤트 로그 카드화.

### 6.7 TokenGate
- 브랜드 로그인 화면: 그라디언트 배경 글로우 + logo.svg + 카드. 로직 동일.

## 7. 신규 의존성 (전부 번들, 외부 CDN 없음)

| 패키지 | 용도 |
|---|---|
| `recharts` | 대시보드/게이트웨이 차트 |
| `lucide-react` | 아이콘 |
| `react-markdown` + `remark-gfm` | 채팅 마크다운 |
| `rehype-highlight` | 코드 하이라이트 |
| `@fontsource-variable/inter`, `@fontsource/jetbrains-mono` | 타이포 |
| `clsx` | 클래스 합성 |

## 8. 불변 조건 (Extensions 준수)

- **Security Baseline**: redact 파이프라인 유지(마크다운 렌더 전 적용), 토큰 저장/스크럽 로직 무변경,
  마크다운은 raw HTML 비활성(기본값) — XSS 표면 추가 없음. api key env 마스킹 관례 유지.
- **Resiliency Baseline**: WS 재연결 뱃지, 30s REST fallback, 로그 gap 마커, unreachable 강등 —
  전부 기존 로직 재사용이므로 동작 무변경.
- **PBT (full)**: 기존 property 테스트 7종 무변경 통과. 신규 순수 로직은
  `lib/timeseries.ts`(recentRequests → 시간 버킷 집계) 하나 — property 테스트 추가.
- **E2E**: 기존 testid 전부 유지. 변경점은 랜딩(`/`→Dashboard)뿐이므로 해당 스펙 1건만 수정
  (`/#token=` 진입 검증을 대시보드 기준으로).

## 9. 코드 생성 계획 (Part 1 — 승인 대상)

- [x] S1. 의존성 추가 및 폰트/하이라이트 CSS 배선 (`package.json`, `index.css`)
- [x] S2. 디자인 토큰 재정의 (`index.css` — dark/light 팔레트, 그라디언트, 폰트)
- [x] S3. UI 킷 구축 (`components/ui/*` — Button/Card/StatTile/Badge/Drawer/Modal/EmptyState/Skeleton/Tabs/SearchInput)
- [x] S4. 셸 교체: 사이드바 내비 + 접힘(prefs) + 연결상태/테마 (Shell.tsx, prefs.ts 확장)
- [x] S5. TokenGate 브랜드 리디자인 (App.tsx)
- [x] S6. `lib/timeseries.ts` + property 테스트 (tests/property/timeseries.test.ts)
- [x] S7. Dashboard 신설 (`pages/dashboard/DashboardPage.tsx`) + 라우팅 변경 (`/` 랜딩)
- [x] S8. Agents: 툴바+검색+카드 그리드(Q3=B로 조정)+인라인 액션, Create Drawer 전환
- [x] S9. Agent 상세: 히어로 헤더 + Overview 재구성, Logs/Settings 스킨
- [x] S10. Chat: 3열 레이아웃 + 마크다운/하이라이트 + 툴콜 칩 + 컴포저/승인 카드 리디자인
- [x] S11. Gateway: 설정 카드 + 사용량/트래픽 차트
- [x] S12. System: 헬스 카드 + 잡/알림/이벤트 카드화
- [x] S13. E2E 스펙 랜딩 1건 수정, `index.html` favicon → assets/icon.svg
- [x] S14. 품질 게이트: typecheck / lint / vitest / vite build / (가능 시) Playwright E2E

**차트 구현 시 dataviz 스킬 로드 후 진행** (색·접근성·마크 스펙 준수).

## 10. 리스크

- 번들 크기 증가(recharts+highlight.js ≈ ~200KB gzip) — 관리도구 특성상 수용 가능, 코드 스플릿 검토.
- E2E는 fake agent 환경 필요 — 로컬 실행 가능 여부에 따라 S14에서 범위 조정.
