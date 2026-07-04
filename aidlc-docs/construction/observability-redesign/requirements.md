# Observability 전면 재설계 — Requirements (v1.1)

**Cycle**: 경량 CONSTRUCTION 개선 — `observability-redesign`
**Date**: 2026-07-04
**Units touched**: U4 Web UI (신규 페이지·시각화) + U2 Daemon (집계 엔드포인트·gateway 링 확장)
**선행 스파이크**: `inception/application-design/hermes-research.md` + 본 사이클 대화 로그(hermes dashboard 실기동 검증, analytics 엔드포인트 라이브 확인, 리소스 측정)

---

## 1. 목적 / 의도

Caduceus UI에 **관측가능성(observability) 전용 메뉴**를 신설한다. 지금은 대시보드가
게이트웨이 in-memory 집계(휘발) 중심으로 요청/에러 정도만 보여주고, 토큰/비용은 세션 fan-out
합계만 표시한다. 이를 걷어내고, **hermes-native 세션 데이터 + gateway TrafficStats** 두 소스를
결합해 **통계값 + 시계열 활동 지표**를 높은 시각화 수준으로 제공한다.

## 2. 스코프 / Non-goals

**In-scope**
- 신규 최상위 메뉴 **Observability** (전용 라우트/네비 항목)
- **Total(플릿 집계)** 와 **Agent(단일 상세)** 2개 스코프, Agent 뷰 metric 패널 내부의 **session narrow-down**
- 통계 카드(Statistic) + 시계열 차트(TimeSeries), 기간 프리셋 24h/7d/30d + Live 탭
- 데몬 측 집계 엔드포인트(영속 세션 통계·시계열) + gateway 링 확장(라이브 정밀)
- dataviz 규약(viz 토큰, 라이트/다크) 준수 시각화

**Non-goals (명시적 제외)**
- **`/api/sessions/{id}/messages` 기반 per-tool breakdown 제외** — 호출량 O(agent×session) + 응답 크기 큼 대비 효용 낮음(사용자 결정). *단 세션당 `tool_call_count` 합계는 `/api/sessions`에서 무비용으로 얻으므로 "카운트" 지표로는 포함.*
- hermes `dashboard`(web_server, 9119) 프로세스 상주/기동 — **불필요**(analytics는 세션 DB SQL 집계일 뿐이며 원천 per-session 행은 이미 relay 중인 `/api/sessions`가 제공). agent별 대시보드 상주(~107MB×N)는 도입하지 않음.
- gateway 지표의 **디스크 영속** — 도입하지 않음(무상태 원칙 유지, §5 Q3=C).

## 3. 데이터 소스 모델 (핵심 이원성)

| 소스 | 성격 | 제공 값 | 시계열 | 세션 분해 |
|---|---|---|---|---|
| **hermes-native** `/api/sessions` (agent별 fan-out) | **영속**(세션 DB), per-session | api_call_count, input/output/cache_read/cache_write/reasoning tokens, estimated/actual_cost_usd, tool_call_count, message_count, started_at/last_active/ended_at, end_reason, model, source, title | 세션 타임스탬프 버킷팅(코스, per-session 시각) | **가능** |
| **gateway TrafficStats** (proxy 인메모리) | **휘발**(재시작 리셋), per-agent | requests, errors(≥400), latency_ms, recent 링(ts/model/status/latency) | per-request 정밀(라이브·휘발) | **불가**(세션 id 미보유) |

**설계 원칙**: 지표마다 최적 소스를 쓰되 UI에서 소스 성격을 라벨로 구분한다.
- **영속 지표**(Requests/Sessions/Tokens/Cost/Model·Source 분포) → hermes 세션 버킷. 재시작 생존.
- **라이브 지표**(Latency/Errors/정밀 Throughput/요청 스트림) → gateway 링. "since daemon start" 라벨.

## 4. 정보구조 (IA) — 결정 (Q1)

Fleet과 Agent는 **1:1이 아니라 1:N**(Fleet = 전체 agent 롤업). 최상위는 2 스코프:

```
Observability (신규 메뉴)
├── [Total]  ← 플릿 집계 KPI + agent별 비교/랭킹 + 플릿 활동 시계열(agent 스택 옵션)
└── [Agent: <선택>]  ← 단일 agent 상세
        └── 각 metric 패널 내부: (옵션) Session별 narrow-down
             · Requests/Tokens/Cost/Tool calls/Messages/Duration → 세션 분해 O
             · Latency/Errors → agent 레벨까지만(세션 분해 X)
```

- Session은 **최상위 네비 레벨이 아님**(사용자 우선순위 낮음). Agent 뷰의 metric 안에서 "group by / drill to session"으로 노출.
- 기존 Dashboard(운영 홈)·Gateway 페이지는 유지. 라이브 트래픽 시각화는 Observability로 이전/통합 검토(설계 단계 확정).

## 5. 결정 사항 (질문 답변 반영)

| # | 결정 | 내용 |
|---|---|---|
| Q1 | IA | **Total + Agent(세션 드릴다운)** 2 스코프. Fleet=N-agent 롤업. |
| Q2 | 집계 아키텍처 | **하이브리드**: 데몬 측 집계 엔드포인트가 영속 세션 통계·시계열을 서버에서 fan-out+버킷팅해 반환 + gateway 링도 데몬이 노출. 브라우저는 폴링만. |
| Q3 | gateway 이력 | **인메모리 확장만**(A와 동일·휘발·무영속) + 링 대폭 확장 + 다해상도(초/분 롤업). **메모리 캡**(`deque(maxlen)` + 유한 롤업). |
| Q4 | Requests 시계열 소스 | **세션 버킷(영속·co스)**를 기본 Requests 시계열로. 라이브 정밀은 Live 탭(Q3 링). |
| Q5 | 기간·해상도 | 프리셋 **24h / 7d / 30d**(자동 시/일 버킷) + **Live 탭**(최근 N분, 초·분 버킷, gateway 링). |
| Q6 | 지표 세트 | **Rich**(§6). per-tool breakdown 제외, tool_call_count 합계 포함. |
| Q7 | 갱신 | **주기 폴링**(영속 통계 ~15s) + 수동 새로고침. Live 탭은 링 엔드포인트를 더 짧은 주기로 폴링. |

## 6. 지표 카탈로그 (Rich — Q6=B)

각 지표 = (소스 / 스코프 / 세션분해 / 형태)

**활동·트래픽**
- Requests(api_calls) — hermes / Total·Agent·Session / 세션분해 O / KPI + 시계열
- Errors, Error rate — gateway / Total·Agent / X / KPI + 시계열
- Latency avg·p50·p95 — gateway / Total·Agent / X / KPI + 시계열(Live)
- Throughput(req/min) — gateway(라이브)+hermes(코스) / Total·Agent / X / 시계열

**세션**
- Sessions 수, Active sessions — hermes / 전 스코프 / O / KPI + 시계열
- 평균 세션 길이(duration = last_active − started_at) — hermes / 전 스코프 / O / KPI + 분포
- Messages 수, Tool calls 수(count) — hermes / 전 스코프 / O / KPI + 시계열

**토큰·비용**
- Tokens(input/output/cache_read/reasoning) — hermes / 전 스코프 / O / 스택 시계열 + KPI
- Cache hit ratio(cache_read/(input+cache_read)) — hermes / 전 스코프 / O / KPI
- Cost(estimated/actual USD) — hermes / 전 스코프 / O / KPI + 시계열

**분포**
- Model 분포 — hermes / Total·Agent / O / 도넛·바(요청·토큰·비용 기준)
- Source/채널 분포(api_server/cli/…) — hermes / Total·Agent / O / 바

## 7. 시계열 설계

- **기간 프리셋**: 24h(시간 버킷), 7d(일/6h 버킷), 30d(일 버킷) — 순수·결정적 버킷팅(기존 `bucketRequests` 패턴 확장, `now` 파라미터화 → PBT 대상).
- **영속 시계열**(Requests/Sessions/Tokens/Cost): hermes 세션의 started_at/last_active를 버킷에 배치. 재시작 생존. per-session 시각 근사임을 툴팁/설명에 명시.
- **Live 탭**(Latency/Errors/정밀 Requests): gateway 확장 링(초·분 롤업)을 데몬 엔드포인트로 폴링. "since daemon start" + 링 용량 한계 라벨.

## 8. 백엔드 변경(개략 — 상세는 Plan)

- **TrafficStats 확장(Q3=C)**: `RING_SIZE` 대폭 상향(설정 가능, 메모리 캡) + 분/시 롤업 집계(유한 버킷). per-agent 유지.
- **gateway 링 노출 엔드포인트**: 최근 요청/롤업 버킷을 반환(라이브 정밀 시계열용).
- **관측 집계 엔드포인트**(Q2=C): agent fan-out(`/api/sessions`) + 서버 버킷팅 + gateway 요약 병합 → Total/Agent/Session 스코프별 통계·시계열 JSON을 1회 반환.
- 값 성격(영속/휘발) 및 스코프별 셰이프를 명확한 타입으로 계약화.

## 9. 제약·엣지

- **세션 분해는 hermes-native 지표 한정**. latency/errors 세션 드릴다운은 미지원(데이터 없음) — UI에서 명확히 표기.
- agent unreachable/stopped 시 해당 agent는 `reachable:false`로 degrade(전체 실패 아님) — 기존 `useAgentUsage` 정책 계승.
- `/api/sessions`는 시간 필터 없음(limit/offset) → 데몬이 전량 fetch 후 버킷팅. 대량 세션 시 상한/페이지네이션 고려(Plan에서 결정).
- token/cost가 null인 세션(usage 미기록) 안전 처리(0 취급).

## 10. Extension 준수 (aidlc-state 기준 전부 Enabled)

- **Resiliency Baseline**: 집계 엔드포인트는 agent별 실패 격리(부분 성공), 타임아웃, degrade. gateway 링은 유한 메모리 캡(무한 성장 방지). → **적용**.
- **Security Baseline**: 신규 엔드포인트는 기존 admin 토큰 인증 계승, per-agent api_server_key는 서버사이드 부착(브라우저 미노출) 유지. 응답에 시크릿/본문 비포함(메타데이터만). → **적용**.
- **Property-Based Testing**: 버킷팅 순수 함수(기간별)·롤업 집계·비율/합계 불변식 PBT. → **적용**.
- Infrastructure Design: 인프라 변경 없음 → **N/A**.

## 11. UI 품질 기준 (승인 시 사용자 추가 — v1.1 증보)

**"상용 솔루션 제품에 준하는 디자인 퀄리티"를 고수한다.** 구체 기준:

- **시각화 수준**: dataviz 규약(viz 토큰·라이트/다크 검증 팔레트) 위에서 차트 종류를 지표 성격에 맞게 선택(스택 영역=토큰 구성, 밴드=레이턴시 p50/p95, 도넛/바=분포, 랭킹 바=agent 비교, KPI 카드 내 스파크라인). 에러는 status-red 전용, 시리즈 색과 미혼용.
- **정보 밀도**: KPI 스트립(값+추세 스파크라인+전기간 대비 델타) → 시계열 → 분포/랭킹의 계층 구성. 빈 공간 낭비 없이, 그러나 여백/그리드 정렬 유지. 숫자 포맷(1.2k/3.4M, $0.0123, 45ms, 백분율) 일관 적용.
- **영역/패널 배치**: 반응형 그리드(16:9 데스크톱 우선), 컨트롤 바(스코프·기간·갱신)는 상단 고정, 패널은 카드 단위로 그룹핑. 스코프 전환 시 레이아웃 안정(레이아웃 시프트 최소화).
- **인터랙션 반응성**: hover 툴팁(크로스헤어), legend 토글로 시리즈 on/off, 기간 세그먼트 즉시 반영, 세션 narrow-down 선택 시 해당 패널만 부드럽게 갱신. 로딩은 스켈레톤(스피너 지양), 부분 실패는 unreachable 뱃지로 degrade, 빈 상태는 명시적 empty state.
- **소스 성격 표기**: 영속(hermes) vs 휘발(gateway, "since daemon start") 뱃지/캡션으로 항상 구분.

## 12. 완료 기준 (Acceptance)

1. 신규 **Observability 메뉴/라우트** 존재, Total ↔ Agent 스코프 전환.
2. Total: 플릿 KPI + agent 비교/랭킹 + 활동 시계열(24h/7d/30d).
3. Agent: §6 Rich 지표 카드 + 시계열, hermes-native 지표에서 **세션 narrow-down** 동작.
4. Live 탭: gateway 확장 링 기반 latency/errors/정밀 requests 시계열, "since daemon start" 라벨.
5. gateway 링 **메모리 캡** 적용(무한 성장 없음), per-agent 유지, 재시작 리셋 수용.
6. 데몬 집계 엔드포인트로 브라우저 fan-out 부하 경감(Q2=C), agent 실패 격리.
7. dataviz 규약 준수(viz 토큰·라이트/다크·접근성), 반응형, **§11 UI 품질 기준 충족**(스켈레톤/툴팁/legend 토글/소스 뱃지/숫자 포맷/empty·degraded 상태).
8. 품질 게이트: ruff·mypy(strict)·pytest(+PBT) / web tsc·eslint·vitest·build(web_dist 갱신)·Playwright E2E 통과.

---

**다음 단계**: 이 요구사항 승인 시 → Code Generation Plan(S1..Sn) 작성(백엔드 집계·링 확장 + web Observability 페이지·차트) → 승인 후 생성.
