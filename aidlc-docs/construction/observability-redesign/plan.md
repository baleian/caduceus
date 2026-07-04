# Observability 전면 재설계 — Code Generation Plan

**Cycle**: 경량 CONSTRUCTION — `observability-redesign` / Requirements v1.1 (APPROVED, b8e9b31)
**범위**: U2 Daemon(트래픽 링 확장 + 관측 집계 API) + U4 Web UI(전용 Observability 메뉴·상용급 시각화)

## 설계 개요

```
                         ┌─ GET /api/observability/usage?range=&agent=   (영속 · hermes 세션)
브라우저 (폴링 15s) ────┤
                         └─ GET /api/observability/gateway?window=&agent= (휘발 · gateway 링/롤업)

데몬:
  usage   = registry 전 agent 병렬 fan-out(127.0.0.1:{api_port}/api/sessions, key 서버사이드)
            → 순수 집계(control/observability.py): 버킷팅·KPI·분포·랭킹 → 스코프별 JSON
  gateway = TrafficStats 확장(raw 링 + 분 롤업, 메모리 캡) → 시리즈/백분위/최근요청
```

- 두 응답 모두 "바로 그릴 수 있는" 형태(시계열 버킷 + KPI + 분포)로 반환 — 브라우저 fan-out 제거(Q2=C).
- Requests 기본 시계열은 세션 버킷(Q4=A, last_active 기준 배치), Live 탭만 gateway 정밀(Q5=B).
- gateway 이력은 인메모리 한정: raw 링 `maxlen` 상향 + 분 단위 롤업 `maxlen=1440`(24h) — 재시작 리셋 수용, 디스크 무영속(Q3=C).

### 메모리 캡 산정 (Q3=C 근거)
- `TrafficSample` ≈ 150B → raw 링 5,000/agent ≈ **0.75MB/agent**.
- 분 롤업 버킷(5필드 dataclass) ≈ 100B × 1,440 ≈ **0.14MB/agent**.
- 10 agents 기준 총 ≈ 9MB — 게이트웨이 프로세스 대비 무시 가능. 상수로 선언, 하드 캡(`deque(maxlen)`).

---

## Steps

### Backend

- [x] **S1 — TrafficStats 확장** (`caduceus/proxy/traffic.py`)
  - `RING_SIZE` 100 → `ring_size` 생성자 파라미터(기본 **5000**), 기존 호출부 무변경 호환.
  - 신규 `MinuteBucket`(start_s, requests, errors, latency_sum_ms, latency_max_ms) + per-agent `deque(maxlen=1440)`; `record()`가 샘플을 현재 분 버킷에 폴드(간극 분은 빈 버킷 없이 스킵 — 시리즈 변환에서 0 채움).
  - 순수 헬퍼: `percentiles(samples, qs)` (정렬 기반 p50/p95, 빈 입력 안전), `minute_series(agent|None, window_s, now)` — fleet 합산 지원, 결정적(now 파라미터).
  - PBT 불변식: 링·롤업 유계 / 롤업 requests·errors 합 == 캡 창 내 record 수 / 버킷 start 단조증가 / percentile ∈ [min,max].

- [x] **S2 — 순수 세션 집계 모듈** (`caduceus/control/observability.py` 신규)
  - 입력: per-agent 세션 행(list[dict], hermes `/api/sessions` data) + `now` + range 프리셋.
  - `RANGES = {"24h": (버킷 1h×24), "7d": (6h×28), "30d": (1d×30)}`.
  - `bucket_sessions(sessions, now, range)` — last_active(없으면 started_at) 기준 배치; requests(api_call_count)/sessions/messages/tool_calls/tokens(4종)/cost 시리즈 산출.
  - `session_stats(sessions)` — KPI: 합계·cache hit ratio(cache_read/(input+cache_read))·평균 duration(last_active−started_at)·active(ended_at null && last_active 최근 N분).
  - `distributions(sessions)` — by_model·by_source(요청/토큰/비용 기준).
  - `fleet_rollup(per_agent)` — 합산 + agent 랭킹 행(requests/errors 제외 hermes 지표 기준).
  - null/누락 토큰 필드 0 처리, 미래·범위외 타임스탬프 드롭. 전부 순수·결정적 → PBT(버킷 보존: 시리즈 합 == 범위 내 세션 합 / 스코프 합성: fleet == Σagent / ratio ∈ [0,1]).

- [x] **S3 — 데몬 fan-out 수집기** (`caduceus/control/observability.py` 내 async 부)
  - `collect_sessions(registry, client, *, limit)` — 전 agent `asyncio.gather` 병렬, `http://127.0.0.1:{api_port}/api/sessions?limit=1000` + Bearer(api_server_key, 서버사이드 S3 유지), per-agent try/except → `{agent, sessions|None(unreachable)}` (부분 성공, RESILIENCY 격리). 타임아웃은 기존 `agent_client` 설정 계승.

- [x] **S4 — 관측 API 엔드포인트** (`caduceus/control/api.py`)
  - `GET /api/observability/usage?range=24h|7d|30d[&agent=]` → `{generated_at, range, fleet:{kpis, series, by_model, by_source, ranking[]}, agent?:{kpis, series, by_model, by_source, sessions[](narrow-down용 per-session 행 — id/title/시각/지표, 본문·시크릿 없음)}, unreachable[]}`.
  - `GET /api/observability/gateway?window=15m|1h|24h[&agent=]` → `{since, totals:{requests,errors}, latency:{avg,p50,p95}, series[](분 버킷; 15m 창은 raw 링에서 초→10s 버킷), per_agent{}, recent[](tail ≤100)}` — 휘발 명시(`since`).
  - 잘못된 range/agent 404/422 처리, 기존 admin 인증 미들웨어 계승. `build_admin_router`에 `agent_client` 파라미터 추가(+`daemon.py` 배선 1줄).

### Frontend

- [x] **S5 — 계약 타입·클라이언트** (`web/src/lib/types.ts`, `web/src/api/client.ts`)
  - `ObservabilityUsage`/`ObservabilityGateway` 인터페이스(백엔드 셰이프 그대로), `client.observabilityUsage(range, agent?)`·`client.observabilityGateway(window, agent?)`.

- [x] **S6 — 차트 키트 확장** (`web/src/components/charts.tsx` 또는 `charts/` 분리)
  - **구현 착수 전 dataviz 스킬 로드**(팔레트/마크 규약 재검증).
  - 신규: `StackedAreaChart`(토큰 구성), `LatencyBandChart`(p50–p95 밴드+avg 라인), `DonutChart`(model/source, 중앙 합계), `RankBars`(agent 랭킹, 값 라벨), `Sparkline`(KPI 카드 내장, 축 없음), 기존 `TrafficChart`/`UsageBarChart` 재사용.
  - 공통: viz 토큰(시리즈 1–3, 에러=status-red 전용), hover 툴팁+크로스헤어, legend 토글, `ResponsiveContainer`, 라이트/다크.

- [x] **S7 — Observability 페이지** (`web/src/pages/observability/` 신규)
  - 라우트 `/observability`(+`/observability/:agent`), Shell 네비 항목(아이콘 `Activity`, Dashboard 다음 배치), `lazy.tsx` 등록.
  - **컨트롤 바**(상단 고정): 스코프(Total ↔ Agent 셀렉터) · 기간 세그먼트(24h/7d/30d/**Live**) · 자동갱신 토글(15s)+수동 새로고침 · 마지막 갱신 시각.
  - **Total 뷰**: KPI 스트립(Requests/Error rate/Sessions/Tokens/Cost/Cache hit — 값+스파크라인+전기간 델타) → 활동 시계열(Requests+Sessions 콤보, Tokens 스택) → Agent 랭킹(정렬 기준 전환: requests/cost/tokens, 행 클릭 → Agent 뷰) → 분포(Model·Source 도넛/바).
  - **Agent 뷰**: 동일 KPI 스트립(해당 agent) + metric 패널 그리드; hermes-native 패널에 **세션 narrow-down**(패널 그룹 상단 세션 셀렉터: All sessions ▾ / 세션 테이블 행 선택 → 해당 세션만 KPI·시리즈 반영); Latency/Errors 패널은 gateway 소스(뱃지 `live · since daemon start`), 세션 셀렉터 비활성+설명 툴팁.
  - **Live 탭**: gateway 시리즈(요청 처리량, 에러 오버레이, LatencyBand) 5s 폴링 + 최근 요청 테이블(ts/model/status/latency, status 색 규약).
  - **품질 디테일(§11)**: 스켈레톤 로딩, unreachable agent 뱃지 + 부분 데이터 경고 캡션, empty state(활동 없음 카피), 숫자 포맷 유틸(1.2k/3.4M/$/ms/%), 기간 전환 시 레이아웃 시프트 없음, 페이지 유지 중 폴링 갱신은 애니메이션 없이 데이터만 스왑.

- [x] **S8 — 기존 페이지 정리(보수적)**
  - DashboardPage 트래픽 카드에 "Open Observability →" 링크 추가(이전·삭제 없음 — 회귀 방지). GatewayPage 무변경. Q1의 "이전/통합"은 본 사이클에서 링크 연결까지만 — 승인 시점에 명시 확인.

### 검증

- [x] **S9 — 테스트**
  - Python 단위: traffic 링/롤업/백분위, observability 버킷·KPI·분포·랭킹, fan-out 부분 실패, API 계약(정상/빈/agent 미존재/불량 range).
  - PBT(Hypothesis): S1·S2 불변식(위 명시).
  - Web vitest: 숫자 포맷 유틸, 시리즈 변환, narrow-down 필터 리듀서(순수).
  - Playwright E2E: 네비→페이지 렌더, 스코프 전환, 기간 세그먼트, Live 탭 스모크.

- [x] **S10 — 품질 게이트 + 문서**
  - ruff / mypy(strict) / pytest 전체 + web tsc / eslint(max-warnings 0) / vitest / vite build(**web_dist 갱신**) / E2E.
  - `code-summary.md` 작성, aidlc-state.md·audit.md 갱신, 커밋.

---

## 명시적 제외(요구사항 계승)
- `/messages` 기반 per-tool breakdown 없음(비용) — `tool_call_count` 합계만.
- gateway 지표 디스크 영속 없음 — 인메모리 캡 확장만.
- hermes dashboard 프로세스 기동/의존 없음.
