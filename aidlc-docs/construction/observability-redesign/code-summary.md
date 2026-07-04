# Observability 전면 재설계 — Code Summary

**Cycle**: 경량 CONSTRUCTION — `observability-redesign` (Requirements v1.1 b8e9b31 / Plan 018aad5)
**Date**: 2026-07-04

## 무엇이 생겼나

전용 **Observability 메뉴**(`/observability`, `/observability/:agent`) — Total(플릿) ⇄ Agent 스코프,
24h/7d/30d 프리셋 + Live 탭, Agent 뷰 metric 패널 내 **세션 narrow-down**. 데이터 소스 이원성
(영속 hermes 세션 vs 휘발 gateway)을 UI 전반에 `persistent` / `live · since …` 뱃지로 상시 표기.

## Backend (U2)

| 파일 | 변경 |
|---|---|
| `caduceus/proxy/traffic.py` | **S1** — `RING_SIZE` 100→5000(생성자 `ring_size`), per-agent 분 롤업 `MinuteBucket` deque(maxlen=1440, 24h), `parse_ts`/`percentile` 순수 헬퍼, `rollup_series`(bucket_s 재버킷 지원)/`sample_series`(10s 정밀)/`latency_summary`(avg/p50/p95/max)/`recent_merged`(fleet 병합 tail). 전부 `now_s` 파라미터 — 결정적. 메모리 하드캡 ≈0.9MB/agent. 디스크 영속 없음(Q3=C). |
| `caduceus/control/observability.py` | **S2/S3 신규** — 순수 집계: `RANGES`(24h/1h·7d/6h·30d/1d), `bucket_sessions`(last_active→started_at 배치, zero-fill), `session_kpis`(cache_hit_ratio·active·avg duration), `distributions`(by_model/by_source), `session_rows`(콘텐츠 필드 미전달, `_instant` 방어 코어스), `ranking`. async `collect_sessions` — registry 전 agent 병렬 fan-out, per-agent 실패 격리(`reachable=False`), 키 서버사이드. |
| `caduceus/control/api.py` | **S4** — `GET /api/observability/usage?range=&agent=`(fleet+agent 블록, 세션 rows, unreachable[]), `GET /api/observability/gateway?window=15m|1h|24h&agent=`(`since` 휘발 마커, series/latency/recent). 422/404 검증, admin 인증 계승. `build_admin_router(agent_client=)` 추가. |
| `caduceus/daemon.py` | 배선 1줄 (`agent_client=agent_client`). |

## Frontend (U4)

| 파일 | 변경 |
|---|---|
| `web/src/lib/types.ts` | 계약 타입: `UsageBucket/UsageKpis/DistributionRow/RankingRow/UsageSessionRow/UsageScope/ObservabilityUsage/GatewayBucket/GatewayRecentRow/ObservabilityGateway`. |
| `web/src/api/client.ts` | `observabilityUsage(range, agent?)` / `observabilityGateway(window, agent?)`. |
| `web/src/lib/format.ts` | **신규** 단위 포맷터: `formatCount`(1.2k/3.4M)/`formatUsd`(sub-cent 4자리)/`formatMs`/`formatPct`/`formatDuration`/`bucketLabel`/`shortDateTime`. |
| `web/src/lib/obs.ts` | **신규** 순수 narrow-down: `USAGE_RANGES` 미러, `bucketRows`(백엔드 패리티 재버킷), `kpisFromRows`, `halfDelta`(전/후반 델타), `foldSlices`(도넛 top-3+other). |
| `web/src/components/obsCharts.tsx` | **신규 차트 키트**(dataviz 절차 준수): `ActivityChart`(requests area+sessions), `TokenStackChart`(4-스택), `LatencyChart`(avg 라인+p50–p95 ReferenceArea 밴드), `DistributionDonut`(중앙 합계), `RankBars`(값 직접 라벨), `Sparkline`(축 없는 KPI 트렌드). |
| `web/src/index.css` | `--color-viz-4` 신규(light `#0891b2` / dark `#1191ad`) — **validate_palette.js 6-체크 재검증 통과**(light 기존 WARN은 legend/tooltip relief 유지; status warn 색과의 충돌 후보(#b45309)는 기각). |
| `web/src/components/lazy.tsx` | 신규 차트 6종 lazy 래퍼(recharts 청크 유지). |
| `web/src/pages/observability/ObservabilityPage.tsx` | **신규 페이지** — sticky 컨트롤 바(스코프 select·기간 세그먼트·auto 15s/Live 5s 폴링·수동 refresh·updated 시각), KPI 스트립 7타일(스파크라인+half-delta+volatile 뱃지), Total 뷰(Activity/Token 스택/Agent 랭킹(HTML 바+측정 전환+행 클릭 내비)/Model 도넛+Source 바), Agent 뷰(Latency 카드(gateway, 세션 분해 불가 명시)+Sessions 테이블 → 행 클릭 narrow-down: KPI·시리즈 클라 재계산), Live 뷰(throughput/latency/recent 테이블), 스켈레톤/empty state/unreachable 캡션/숫자 포맷 일관(§11). |
| `web/src/App.tsx`, `Shell.tsx` | 라우트 2개 + 네비 항목(Telescope, Dashboard 다음). |
| `web/src/pages/dashboard/DashboardPage.tsx` | **S8** — 트래픽 카드에 "Open Observability →" 링크만 추가(이전·삭제 없음). |

## 테스트 (S9)

- **Python 단위**: `test_traffic_series.py`(링 캡/분 폴드/skew/시리즈 zero-fill/재버킷/백분위/recent_merged, 19), `test_observability.py`(버킷 배치/폴백/null/미래 드롭/KPI/active/분포/rows 새니타이즈/랭킹/fan-out 부분실패, 17), `test_observability_api.py`(422/404/빈 레지스트리/agent 스코프/콘텐츠 비유출/degrade/인증/윈도 3종, 12)
- **PBT**: `test_observability_properties.py` — 버킷 보존(시리즈 합==창 내 세션 합), fleet==Σagent(선형성), ratio∈[0,1], 분포 보존·정렬, 롤업 보존·유계·단조, percentile∈입력. 기존 `test_events_traffic_properties.py` RING_SIZE 갱신.
- **vitest**: `format.test.ts`(8) + `obs.test.ts`(6 — bucketRows 보존 fc, kpis 패리티, halfDelta, foldSlices 보존).
- **E2E**: `app.spec.ts` +1 — fleet 렌더→기간 전환→랭킹 행 클릭 agent 진입→sessions/latency 카드→Live 탭→스코프 복귀.
- **E2E가 잡은 실버그 1건**: `session_rows`가 비수치 타임스탬프(fake api_server의 ISO 문자열)에서 500 → `_instant` 코어스 도입 + 회귀 테스트.

## 검증 게이트

ruff clean · mypy(strict) **44 files** clean · pytest **573 passed**(4 integration deselected) ·
web tsc 0 · eslint(max-warnings 0) clean · vitest **100** · vite build → `caduceus/web_dist` 갱신 ·
Playwright E2E **15/15** · 시각 검증(스크린샷: fleet/agent/narrowed/live/empty, 다크) — dataviz 절차 7단계 수행.

## 알려진 한계 / 후속 후보

- Latency/Errors는 세션 분해 불가(gateway가 세션 id 미보유) — UI에 명시(설계 확정 사항).
- Distribution 패널은 세션 narrow 시에도 스코프 레벨 유지(단일 세션 분포는 자명해 가치 낮음).
- gateway 지표는 재시작 리셋(설계 확정, Q3=C) — `since` 마커 상시 노출.
- Dashboard 트래픽 시각화의 Observability 이전(통합)은 후속 사이클 후보.
