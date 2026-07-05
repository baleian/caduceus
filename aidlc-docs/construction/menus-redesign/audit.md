# Caduceus Web UI — UX/UI 감사 (Observability 제외)

**작성일**: 2026-07-05 · **성격**: 읽기 전용 감사 (코드 수정 없음) · **다음 단계 입력물**
**대상**: Dashboard / Agents(목록·상세[Overview·Logs·Settings]) / Chat(피커·대화) / Gateway / System / 셸
**제외**: Observability (2026-07-04 상용급 재설계 완료 — 이번 범위 밖)

## 방법 & 근거

실제 데몬(`127.0.0.1:4285`, 에이전트 `test`/`test2`/`test3`, 실제 대화이력 포함)에 Playwright로
접속해 **모든 라우트·탭·모달·인터랙션 상태를 15장 스크린샷**으로 캡처하고, 동시에 전 페이지
컴포넌트와 UI 프리미티브(`Button`/`Card`/`StatTile`/`StatusBadge`)·디자인 토큰(`index.css`)을
정독해 시각+구조를 교차 검증. 스크린샷은 세션 스크래치패드(`scratchpad/audit/*.png`)에 보관.

## 우선순위 범례

- 🔴 **P1** — 구조/정보 아키텍처. 재설계의 뼈대. 개별 픽셀보다 먼저 결정해야 함.
- 🟠 **P2** — 페이지 레벨 완성도. 뚜렷한 UX/시각 저해.
- 🟡 **P3** — 디테일/폴리시. 사소하지만 완성도 체감에 직결.

---

## A. 전역 · 교차 이슈 (systemic) — 최우선

### A1 🔴 정보 아키텍처: 동일 기능이 여러 페이지에 중복

같은 데이터가 페이지마다 반복 노출되어, 각 메뉴의 정체성이 흐려지고 "어디서 봐야 하나"가 모호함.

| 데이터/기능 | 노출 위치 | 상태 |
|---|---|---|
| **Token usage** | Dashboard(막대차트) · Gateway(차트+표) · Observability | 삼중 |
| **Request traffic** | Dashboard(Live traffic) · Gateway(표+Recent) · Observability | 삼중 |
| **Jobs** | Dashboard(Recent jobs) · System(Jobs 표) | 이중 |
| **Alerts** | Dashboard(Alerts) · System(Drift/orphan) | 이중 |
| **Agent 상태 목록** | Dashboard(Fleet) · Agents · System(Deep status) | 삼중 |
| **Session usage** | Chat 대화 헤더 · Chat 메타레일 | 이중(한 화면 안!) |
| **allow private URLs** | 생성 드로어 · Overview(읽기) · Settings(토글) | 편집 진입점 혼재 |

→ **방향**: 각 데이터의 "정본(source of truth) 페이지"를 하나로 확정하고 나머지는 요약+링크만.
제안 초안 — Dashboard=진입 허브(요약 KPI + 딥링크), Observability=usage/traffic 정본,
Gateway=upstream 설정 중심으로 축소, System=순수 진단(deep status/events)만. **범위 분배는
사용자 취향 결정 → 재설계 requirements 질문 대상.**

### A2 🔴 낮은 정보 밀도 / 과도한 여백

거의 모든 페이지가 화면 세로의 상단 ~40%만 사용하고 하단은 큰 빈 공간. 특히 1920 폭에서 심함
(`13-dashboard-1920`, `02-agents-list`, `11-system`). 원인:

- `Card` 기본 패딩 `p-4` + `StatTile` 내부 여백 → 헤드라인 숫자 하나에 큰 카드.
- Agents 카드: ~450px 폭에 name+메타3개+버튼2개뿐, 하단 여백 큼(`02`).
- Overview: Runtime/Placement 카드가 반폭·짧고 그 아래 텅 빔(`04`).
- Skills: 한 줄에 1개, 이름(좌)–pill(우) 사이 거대한 빈 폭(`05`).

→ **방향**: 12-col 밀도 상향, 카드 패딩/타이포 스케일 축소, 리스트는 멀티컬럼/테이블화,
대시보드는 세로 공간을 채우는 밀도로. (사용자 지적 "카드가 정보 밀도에 비해 큼" 정면 해당)

### A3 🟠 버튼 시스템 일관성 (사용자 지적 "버튼 색 / 같은 버튼 여러 개")

- variant 6종(primary/gradient/outline/ghost/danger/dangerGhost) 혼용.
- **Agent 상세 헤더에 버튼 5개**가 한 줄: Start(solid purple)·Stop(outline)·Chat(outline)·hermes(ghost)·Remove(red-outline) — 색·위계 제각각(`04`).
- **running 상태인데 Start가 가장 강조된 solid** → 위계 오류. 실행 중엔 Stop이 우선이어야.
- 같은 **Chat** 액션이 카드에선 `ghost`, 상세에선 `outline` — variant 불일치(`AgentsPage` vs `AgentDetailPage`).
- 카드의 Stop(outline)+Chat(ghost)이 둘 다 회색 계열 → 구분 약함(`02`).

→ **방향**: 위계 규칙 정립(화면당 primary 1개, 파괴적=danger, 보조=ghost), 상태에 따라
Start/Stop 토글(둘 다 상시 노출 X), 공통 액션 variant 통일.

### A4 🟠 "상태 배지"와 "클릭 컨트롤"이 시각적으로 동일

Skills의 `enabled/disabled`, Browser private URLs의 `allowed/blocked`는 실제로는 **클릭 토글**
(`role="switch"`)인데, 생김새가 읽기 전용 `StatusBadge`와 똑같은 pill → 클릭 가능한지 알 수 없음
(`05`, `SettingsTab.tsx`). → **방향**: 토글엔 스위치 어피던스(트랙+썸) 부여, 읽기 배지와 구분.

### A5 🟠 Raw 머신 문자열 노출

- Chat 세션 제목/헤더에 `api_1783148667_43246421` 그대로(`09`,`14`).
- 세션 리스트 둘째 줄 `1783148691.5026166` — `timeAgo()`가 epoch(float) 파싱 실패로 raw 표시(**실질 버그**, `ChatView.tsx` `timeAgo`).
- System 알림 detail에 raw JSON `{"action":"gateway-restarted"}`(`11`).
- est. cost 전부 `$0.0000`(로컬 무료 업스트림) — 4자리 0 노이즈(Gateway 표·Dashboard·Chat)(`10`).

→ **방향**: 세션은 첫 메시지 요약/날짜 기반 제목, 시간은 humanize, 알림은 사람이 읽는 문장,
비용 0은 `—` 또는 숨김.

---

## B. 페이지별

### B1. Dashboard (`01`,`13`,`15`)

- 🔴 카드 대부분이 타 페이지 요약 재노출(Fleet=Agents, Recent jobs=System, Live traffic/Token usage=Observability) → 정체성이 "허브"인지 "관제"인지 모호(A1).
- 🟠 Token usage 막대차트가 Observability와 중복이면서 세로 공간을 크게 차지 — 요약 KPI면 충분(A1).
- 🟠 stat 타일 5개가 좌측 정렬이라 우측 내부 여백 큼; 빈 상태(0/0, $0.00)에서 특히 저밀도(`13`).
- 🟡 "Live traffic"은 "이 페이지 로드 이후"만 집계 → 새로고침 시 리셋되는 반쪽 지표. Observability로 위임 권장.
- 🟡 Est. cost `$0.00` 반복(A5).

### B2. Agents 목록 (`02`)

- 🔴 카드 그리드 저밀도(A2): 3개가 한 줄에, 4번째 칸+아래 전부 빔.
- 🟠 카드당 상태 신호 4개(running 배지 + `healthy` + `unknown` + `desired: running`)가 **라벨 없이** 나열 → `unknown`이 container 상태임을 알 수 없음(`AgentCard`).
- 🟠 Stop/Chat 버튼 둘 다 회색(A3).
- 🟡 `desired: running` 텍스트뿐 — desired↔actual drift를 시각적으로 못 알림.
- 🟡 정렬/그룹 없음(name 필터만).
- 🟡 `data-testid="agents-table"`인데 실제론 grid — 명명 잔재.
- ❓ 원래 재설계 Q3에서 **카드(B)** 를 선택했으나 밀도 문제가 커서 **리치 테이블(A) 재검토 여지** → 질문 대상.

### B3. Agent 상세 — Overview (`04`)

- 🟠 헤더 버튼 5개 위계 문제 + running인데 Start solid(A3).
- 🟠 **hermes 버튼이 하드코딩 `http://127.0.0.1:9119` 외부 링크** — 대개 안 떠 있어 깨진 링크 경험(`AgentDetailPage.tsx:147`). 위치도 주요 액션 그룹에 섞여 부적절.
- 🟠 Overview가 정적 spec(Runtime/Placement)만 — 살아있는 정보(세션 수·최근 활동·usage·최근 대화) 없음. 상세인데 얕음.
- 🟡 카드 2개 반폭·짧고 아래 빔(A2).

### B4. Agent 상세 — Logs (`06`)

- 🟠 탭 진입 시 자동 로드 안 함 → 거대한 빈 검정 박스 `(no log lines — press Refresh)`. 수동 Refresh 강제.
- 🟡 빈 상태인데 로그 패널이 뷰포트를 꽉 채워 여백 낭비.
- 🟡 `follow` 체크박스가 기본 브라우저 체크박스(비브랜드).

### B5. Agent 상세 — Settings (`05`, `SettingsTab.tsx`)

- 🟠 Skills 리스트 저밀도(한 줄 1개, 좌우 큰 빈 폭) — 스킬 다수 시 매우 길어짐(A2). 멀티컬럼/칩 권장.
- 🟠 Skills·private URLs 토글이 status 배지와 구분 안 됨(A4).
- 🟡 Persona textarea `rows=12` — 5줄 페르소나에 과도하게 큼.
- 🟡 저장 모델 불일치: Persona/Toolsets는 명시적 Save(dirty 시 활성), Skills/Approvals/PrivateURLs는 즉시 적용 — 한 화면 두 멘탈모델.
- 🟡 Settings만 `max-w-4xl` 제약, 타 페이지는 full-bleed — 폭 정책 불일치.

### B6. Chat — 진입 / 피커 (`08`)

- 🔴 **진입 UX(사용자 지적)**: 사이드바 Chat → 피커(에이전트 목록) → 에이전트 클릭 → 대화. 항상 한 단계 경유하며 "마지막 대화"로 바로 못 감.
- 🟠 피커가 health만 표시(process 상태 없음) → 정지된 에이전트도 클릭 가능(`ChatPage.tsx`).
- 🟡 피커 `max-w-3xl` 센터드 + 큰 여백(A2).
- → **방향**: Chat 진입 시 최근 활성 세션으로 바로 이동, 또는 대화뷰 안에 에이전트 스위처 통합.

### B7. Chat — 대화 뷰 (`09`,`14`)

- 🟠 **Session usage 이중 노출**: 헤더 우측 `session · in 6,457 (cache 75,110) / out 593` + 메타레일 `SESSION USAGE`(1920) 동일 수치 반복(A1). **사용자의 "token 사용량 표기 위치" 지적에 정확히 해당.**
- 🟠 헤더 usage 문자열이 암호적(`in/out`, cache가 in보다 큼) — 라벨/맥락 부족.
- 🟠 세션 id raw + 리스트 epoch raw(A5).
- 🟡 메타레일이 2xl(≥1536)에서만 노출 → 1440에선 usage가 헤더에만. 반응형 정보 접근 불일치.
- 🟡 메타레일 내용 빈약(Agent 배지 / usage / `3 total`)에 여백 큼.
- ✅ **유지**: 마크다운 렌더·툴 콜 칩·컴포저(둥근 입력+원형 send)는 완성도 높음.

### B8. Gateway (`10`)

- 🔴 Token usage(차트+표)가 Dashboard·Observability와 삼중 중복(A1). Gateway는 upstream 설정이 본질 — usage/traffic은 Observability 위임 검토.
- 🟠 같은 카드 안에서 **차트+표가 동일 데이터를 중복** 표시.
- 🟠 stacked bar가 cache read(초록)에 압도돼 input/output이 안 보임 — 스택 의미 약함.
- 🟡 est. cost 열 전부 `$0.0000`(A5).
- 🟡 Refresh 버튼이 카드마다 산발(usage/traffic).

### B9. System (`11`)

- 🔴 Deep status(agent ok 목록)=Agents/Fleet 중복, Jobs=Dashboard 중복, Alerts=Dashboard 중복(A1). System은 고유가치(daemon 진단/events)로 축소 필요.
- 🟠 알림 detail이 raw JSON(A5).
- 🟡 `ok` 배지가 `StatusBadge` 톤에 없어 회색 fallback → `healthy`(초록)와 불일치.
- 🟡 하단 큰 여백(A2).

### B10. 사이드바 / 셸 (전역, `12`)

- 🟡 nav 최상위에 Dashboard와 Observability가 공존하며 기능(트래픽/usage)이 겹쳐 "어디서 보나" 혼란 — A1 IA 정리와 연동.
- ✅ **유지**: 접힘(64px) 정상, 연결 배지·테마·접기 하단 정렬, 활성 nav(accent 배경) 양호.

---

## C. 유지해야 할 강점 (재설계 시 회귀 금지)

- 다크/라이트 팔레트 완성도 + 브랜드 그라디언트 절제 사용(`15` 라이트 정상).
- Chat 마크다운/툴 칩/컴포저.
- Remove 모달의 type-to-confirm 안전 패턴(`07`).
- `StatusBadge` dot+label(색만 의존 안 함) 접근성.
- 사이드바 셸 · 접기 · 테마 토글.

## D. 다음 단계 제안

1. 본 감사는 **읽기 전용**. 실제 수정은 이 프로젝트의 AI-DLC "개선" 경량 사이클로.
2. **먼저 결정할 P1(구조)**: (a) 데이터별 정본 페이지 확정 → Dashboard/Gateway/System 역할 재분배,
   (b) 전역 밀도 정책, (c) Agents 카드↔테이블. 이들은 **사용자 취향 → `questions.md`** 로 확인.
3. 확정 후 P2/P3를 페이지별 코드 생성으로. 계약(`data-testid`)·로직 레이어 보존은 기존 재설계 원칙 준수.
