# 개선 (경량) — 대시보드 REQUESTS/ERRORS 를 "유의미한 LLM 트래픽"으로 집계

**Cycle 유형**: 경량 (Requirements minimal + Code Gen, 커밋 게이트 유지)
**Timestamp**: 2026-07-03T18:20:24Z → **방향 전환** 2026-07-03
**Stage**: CONSTRUCTION / Requirements Analysis (adaptive minimal)

## 0. 방향 전환 (사용자 지시)

> "그냥 예외처리는 없어도 될 것 같아. 방향을 바꾸고 싶은데 — 대시보드 REQUESTS/ERRORS
> 숫자는 사용자가 느끼기에 유의미한 요청수/에러수여야 하는데 지금은 props 성 요청 때문에
> 의미가 퇴색되어 있어."
> - **Requests**: 실제 LLM 호출을 위한 요청 수
> - **Errors**: 유의미한 에러 수

→ `/v1/props` 단일 특례(경로 화이트/블랙리스트, 404-only) 접근을 **폐기**. 대신 **요청을
종류로 분류**하여 통계에는 *추론(inference) 호출* 만 반영한다. props·models 조회 등
메타/프로브 요청은 통계·recent·이벤트 어디에도 남기지 않는다.

_이전 질문에서 사용자는 Q1=A(완전 무시), Q2=B(models 404도 함께 침묵)를 선택 — 새 방향의
"메타/프로브 전부 침묵, 추론만 집계"와 정확히 일치._

## 1. 배경 / 증상

게이트웨이가 프론트하는 OpenAI-호환 표면에는 두 부류의 요청이 섞인다.

- **추론 호출** — 실제 LLM 토큰을 생성/소비: `POST /v1/chat/completions` 등.
- **메타/프로브** — 능력·모델 조회: `GET /v1/props`, `GET /v1/models`,
  `GET /v1/models/{model}`. 클라이언트가 시작 시 자동 전송하며, 업스트림(llama.cpp)이
  `/v1/props`·특정 모델 경로를 제공하지 않으면 404. **무해한 노이즈**다.

현재 `ProxyService._record` 는 둘을 구분하지 않고 모두 `TrafficStats` 에 기록 → Requests 가
부풀고, 프로브 404 가 Errors 로 잡혀 "유의미한 숫자"가 퇴색된다.

## 2. 코드 흐름 (근거)

- 모든 프록시 요청은 `ProxyService._record()`
  ([service.py:172](../../../caduceus/proxy/service.py#L172))가
  `TrafficStats.record()` + `traffic.request` 이벤트로 기록.
- `TrafficStats.record()`
  ([traffic.py:42](../../../caduceus/proxy/traffic.py#L42)): `requests += 1`,
  `status >= 400` 이면 `errors += 1`, `recent` 링버퍼 append.
- 대시보드는 `traffic.summary()`(requests/errors) 및 per-agent `recent`
  ([api.py:309](../../../caduceus/control/api.py#L309), [api.py:342](../../../caduceus/control/api.py#L342))에서 읽음.

→ **단일 수정 지점 = 서비스 계층 `_record` 진입 게이트**. `TrafficStats.record` 의
"기록=항상 카운트" 불변식(PBT `test_pu2_2_totals_equal_sum_of_agents`)은 불변.
웹/프런트 변경 없음(서버 통계 의미만 바뀜 → web_dist 재빌드 불필요).

## 3. 요구사항

- **FR-1 (Requests)**: Requests 는 **추론 호출** 요청 수만 집계.
  메타/프로브(`/v1/props`, `/v1/models`, `/v1/models/{model}` 등)는 집계 제외.
- **FR-2 (Errors)**: Errors 는 추론 호출에서 발생한 실패만 집계(업스트림 5xx/타임아웃 및
  추론 경로의 4xx 포함). 메타/프로브의 404 는 에러 아님. → Errors ⊆ Requests 로 체감 일치.
- **FR-3 (recent / 이벤트)**: recent requests 목록과 `traffic.request` 이벤트도 추론 호출만
  남긴다(메타/프로브는 조용히 무시).
- **NFR-1**: 분류는 요청 경로 기준 명시적 상수 집합(`_INFERENCE_PATHS`)으로 관리 — 추론
  엔드포인트 추가 용이.
- **NFR-2**: 추론 경로의 실제 업스트림 장애(5xx/타임아웃)는 그대로 Errors 로 집계 → 운영
  가시성(Resiliency) 유지.

## 4. 결정 필요 — "추론 호출"의 정의

### Q1. 어떤 엔드포인트를 Requests/Errors 에 집계할까? (`_INFERENCE_PATHS`)

- **A. 표준 추론 세트 (권장)**
  `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/responses`
  — 토큰을 실제로 생성/소비하는 모델 호출. 향후 호환성까지 커버.
- **B. 채팅만**
  `/v1/chat/completions` (+ `/v1/completions`) 만. 이 게이트웨이 실제 트래픽에 가장 좁게
  대응(embeddings·responses 제외).

> 어느 쪽이든 `/v1/models`, `/v1/models/{model}`, `/v1/props` 는 집계 제외.

[Answer]: A

## 5. 구현 계획 (승인 후 실행)

- [x] `caduceus/proxy/service.py`
  - `_INFERENCE_PATHS = frozenset({...})` 상수 + `is_inference_path(path)` 헬퍼(정규화 후 비교)
  - `handle()` 에서 `request.url.path` 를 relay/`_fail` 경로로 전달
  - `_record(..., path)`: `not is_inference_path(path)` 이면 조기 return(기록·이벤트 생략).
    그 외는 현행대로 기록(추론 4xx/5xx 는 에러 집계 유지)
- [x] `tests/unit/test_proxy.py`
  - `GET /v1/props` 404, `GET /v1/models` 200, `GET /v1/models/{m}` 404 가
    requests/errors/recent/event/last_request_at 어디에도 남지 않음을 검증
    (`test_metadata_and_probe_requests_are_not_accounted`)
  - 프로브 노이즈 속 chat 호출 1건만 집계됨(`..._only_accounted_request_amid_probes`)
  - 추론 경로 4xx 는 여전히 에러 집계(`test_inference_error_status_is_still_accounted`)
  - 기존 추론 테스트(chat 200 기록 / connect-error 502 에러) 회귀 없음
- [x] 검증: `ruff` clean · `ruff format` · `mypy(strict)` 43 files Success ·
  `pytest` **499 passed**, 4 deselected(기존 496 + 신규 3). 웹 변경 없음.

## 5-1. Extension 준수 (요약)

- **Resiliency**: 추론 경로의 5xx/타임아웃은 그대로 Errors 집계 → 실제 장애 가시성 유지.
  침묵은 무해 메타/프로브에 국한. N/A 없음.
- **Security**: 바디/시크릿 미접촉, 경로 상수만 추가 — 표면 변화 없음(사실상 N/A).
- **PBT**: `TrafficStats.record` 불변식 미변경 → 기존 속성 테스트 유효. 서비스 계층 분류
  게이트는 예시기반 단위 테스트로 커버.
