# Cached Token 메트릭 + 채팅 Turn 토큰 표시 — 요구 & 코드생성 계획

**Units**: U2 (proxy traffic accounting), U4 (Web UI: Gateway dashboard + Chat)
**Scope**: 기존 컴포넌트 경계 내 수정. 신규 컴포넌트/서비스 없음.
**Spike 근거**: upstream이 `usage.prompt_tokens_details.cached_tokens`를 non-stream/stream
두 경로 모두에서 표준 필드로 보고함을 실측 확인.

---

## 1. 요구사항 (adaptive-minimal)

- **R1** Gateway는 upstream이 보고한 **cached prompt tokens**를 agent별/전체로 집계한다.
  - cached는 `input_tokens`(=prompt_tokens)의 **부분집합**이다 (별도 가산 아님).
  - upstream이 필드를 안 주면 `None`으로 취급, 0 가산 (기존 no-guessing 원칙 유지).
- **R2** Gateway 대시보드는 in / out 옆에 **cached**(및 실처리량 effective in = in − cached)를
  agent 행과 totals에 표시한다.
- **R3** 실시간 채팅 화면은 **각 turn 종료 시**, 그 turn의 **최종 LLM 호출** 기준
  input / output / cached 토큰을 보여준다.
- **R4** 채팅 화면 **고정 위치**에 현재 **컨텍스트 윈도우 채움률**을 상시 표시한다.
  - 채움 = 최종 LLM 호출의 `input_tokens`(prompt_tokens, cached 포함 — 캐시된
    토큰도 컨텍스트를 점유하므로) / **context_window**.
  - **context_window 출처**: upstream 설정 필드(신규). 제네릭 OpenAI 프록시라
    llama.cpp `/props` 자동탐지는 코어에 넣지 않음(범위 밖). 미설정 시 %없이
    원시 토큰수만 표시.
- **NFR** 바디는 계속 저장/로깅하지 않는다 (P1). 메모리 링버퍼(≤100)·재시작 리셋 유지.
  타입 안전(mypy strict)·ruff·기존 테스트 그린 유지.

## 2. 설계 결정 (기본값 — 승인 게이트에서 override 가능)

- **D1 (cached 추출)**: `_extract_usage`가 `(prompt, completion, cached)` 3-tuple 반환.
  cached = `usage["prompt_tokens_details"]["cached_tokens"]` (없으면 None).
- **D2 (채팅 토큰 소스)**: hermes run 이벤트를 건드리지 않고, 이미 흐르는 gateway
  `traffic.request` 라이브 이벤트(`state.live.recentRequests`)를 **현재 agent로 필터해
  마지막 항목**을 사용. 채팅 1 turn이 tool 루프로 여러 upstream 호출을 유발하면
  "마지막"은 그 turn의 **최종 LLM 호출** 기준.
  - 대안(비채택): hermes `/v1/runs` 스트림에 usage 이벤트 추가 → hermes 계약 변경 필요, 범위 초과.
- **D3 (대시보드 표기)**: `in / out` 셀을 `in (cached) / out` 로, totals도 동일. cached=0이면 `(0)` 표기.
- **D4 (채팅 turn 라인)**: turn 종료 후 그 turn의 마지막 완료 메시지 아래
  `turn · in N (cached M) / out K` 메타라인(`text-ink-dim text-xs`). 소스는 현재 agent의
  마지막 `traffic.request`(D2) — turn 종료 후 re-hydration 시점에 확정.
- **D5 (컨텍스트 게이지)**: 채팅 section header에 **고정** 게이지 바
  `context 34,120 / 100,096 (34%)`. 분모=upstream `context_window`. 미설정 시
  `context ~34,120 tok`. 80%↑ 경고색(text-warn), 95%↑ text-bad.
- **D6 (config)**: `UpstreamConfig.context_window: int | None = None`. GatewayInfo.upstream에
  노출 + Gateway 폼에 입력 필드(선택). 채팅은 `client.gatewayInfo()`로 조회.

## 3. 코드생성 체크리스트

### Backend (U2)
- [x] `caduceus/proxy/service.py`: `_extract_usage`/`_extract_usage_from_sse` → cached 포함 3-tuple.
      `_relay_buffered`/`_relay_stream`/`_record` 시그니처에 `cached_tokens` 플럼빙.
      `traffic.request` 이벤트 `data`에 `cached_tokens` 추가.
- [x] `caduceus/proxy/traffic.py`: `TrafficSample.cached_tokens`, `AgentTraffic.cached_tokens`,
      `record()` 가산, `summary()` totals+agents 노출.
- [x] `caduceus/core/types.py`: `UpstreamConfig.context_window: int | None = None`.
- [x] `caduceus/control/api.py`: gateway info upstream에 `context_window` 노출(자동), PUT 허용.
- [x] `caduceus/cli/commands/gateway.py`: cached 컬럼 표시(선택).

### Frontend (U4)
- [x] `web/src/lib/types.ts`: `TrafficAgentSummary`, totals, `DeepStatus.traffic`에 `cached_tokens`;
      `Upstream`에 `context_window`.
- [x] `web/src/lib/reducer.ts`: `RecentRequest.cachedTokens`, `traffic.request` 매핑.
- [x] `web/src/pages/gateway/GatewayPage.tsx`: cached 컬럼/totals + recent 라인 cached + context_window 폼 필드.
- [x] `web/src/pages/chat/ChatView.tsx`: 현재 agent 마지막 `traffic.request`로 (1) turn 라인
      (2) 고정 컨텍스트 게이지. `gatewayInfo().upstream.context_window`를 분모로.

### Tests
- [x] `tests/unit/` proxy: cached 추출(present/absent/streaming), traffic 집계/summary.
- [x] `web` 단위 테스트(vitest 46 passed) 회귀 없음.
- [ ] Playwright E2E: 미실행(수동 스모크 권장 — 아래 검증 참고).

---

# Revision 2 — hermes-native pivot (토큰 자체 집계 제거)

**결정 근거**: hermes가 세션 단위로 usage를 이미 추적·노출한다(`/api/sessions` →
`input_tokens/output_tokens/cache_read_tokens/cache_write_tokens/reasoning_tokens/
estimated_cost_usd/api_call_count`, 실측 확인). 게이트웨이가 응답에서 토큰을 다시
추출·메모리 집계하는 건 **중복**. hermes-native 우선 원칙에 따라 우리 토큰 집계를
제거하고, 대시보드/채팅 usage를 hermes 세션 usage에서 가져온다.
per-turn usage 및 context_window 게이지는 **폐기**(마지막 turn-in과 항상 동일 → 무의미).

## R (개정)
- **R5** 게이트웨이 프록시는 토큰을 추출/집계하지 않는다. TrafficStats는 프록시
  관측치(requests/errors/latency/recent 메타데이터)만 유지 — 이건 hermes에 없음.
- **R6** agent별 사용량 = 그 agent의 hermes 세션 usage 합(프론트 fan-out: listAgents →
  agent별 listSessions → 합산). 대시보드에 in/out/cache_read/cost 표기.
- **R7** 채팅은 최초에 활성 세션 usage를 로드하고, 매 turn 종료 시 세션 목록
  재조회(`refreshSessions`)로 즉시 갱신 — 별도 메모리 관리 없음.
- **R8** context_window 설정/게이지/ per-turn 라인 전부 제거.

## 제거 목록 (Revision 1에서 추가한 것 + 기존 토큰 집계)
- Backend: `_extract_usage`/`_extract_usage_from_sse`, `service._record` 토큰 인자,
  `traffic.request` 이벤트 토큰 필드, `TrafficSample/AgentTraffic` 토큰 필드 +
  record/summary 토큰, `UpstreamConfig.context_window`(+validator),
  `UpstreamUpdate.context_window`, gateway_info/upstream context_window,
  DeepStatus traffic 토큰, CLI 토큰 컬럼 + `--context-window`, client context_window.
- Frontend: `TrafficAgentSummary`/totals/DeepStatus 토큰 필드, `RecentRequest` 토큰 +
  reducer 매핑, `Upstream.context_window` + 폼 필드, GatewayPage 토큰 totals/컬럼/recent,
  SystemPage 토큰 텍스트, ChatView `ContextBar` 전체 + context_window fetch.

## 추가 (hermes-native)
- `SessionInfo`에 usage 필드(input/output/cache_read/cache_write/est_cost) 추가.
- 채팅 헤더: 활성 세션 usage 라인(`session · in N / out K · cache R · $C`).
- 게이트웨이: agent별 세션 usage 합 테이블(fan-out).

## 검증 (개정) — 완료
- 백엔드: ruff/mypy strict OK, **pytest 474 passed**(토큰 테스트 제거/전환:
  test_proxy 5건 정리, events_traffic 프로퍼티 축소, cli_surface/daemon_asgi 갱신).
- 프론트: typecheck/lint OK, **vitest 46 passed**, vite build → web_dist 갱신.
- 실기 데이터 경로: `/api/agents` + agent별 `/api/sessions` fan-out 합산 실측
  (test1: 4 sessions, in=18,974 / out=3,009 / cache_read=326,711). 채팅은 활성
  세션 객체 usage 사용.
- 미실행: Playwright E2E(브라우저), 데몬 재시작 후 UI 육안. 참고: 새 UI는 구
  데몬과도 호환(제거된 토큰 필드는 구 데몬이 보내도 무시).

## 상태
Revision 2 코드 정리 완료. 승인/커밋 대기.

---

# Revision 1 검증 (참고 — 이후 R2에서 상당수 제거)

## 4. 검증 (완료)
- ruff + mypy strict 통과, pytest **478 passed**(proxy cached 케이스 3건 추가), web
  typecheck/lint/vitest(46) 통과, vite build → web_dist 갱신.
- **실기 E2E**: 실제 llama-swap(localhost:9292) 상대로 새 ProxyService 구동 →
  buffered/streaming 두 경로 모두 cached 추출·집계 확인
  (`summary().totals.cached_tokens=21`, streaming last sample cached=7).
- 미실행: Playwright E2E(브라우저 필요), 사용자 데몬 재시작 후 UI 육안 확인
  (데몬 재시작 시 새 코드 반영 — 대시보드 cached 컬럼/채팅 게이지).
