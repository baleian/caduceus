# Caduceus — Components

**Date**: 2026-07-02
**전제**: requirements.md v1.0, hermes-research.md, 설계 결정 AD-1~AD-6 (application-design.md §2)

Caduceus는 **1개의 상주 데몬 + 1개의 CLI + 1개의 SPA**로 구성되고, 에이전트 자체는 **hermes 네이티브 스택**(profile + gateway/api_server + docker terminal backend)이 담당한다. Caduceus 컴포넌트는 아래 8개로 한정한다 (P4).

## C1. Proxy Plane (데이터 평면) — `caduceusd` 내부 모듈

**Purpose**: 모든 에이전트의 LLM 호출이 경유하는 OpenAI 호환 프록시 (F4).

**Responsibilities**:
- `127.0.0.1:<port>/v1/*` 수신 (chat/completions, embeddings, models 등 OpenAI wire 그대로 pass-through)
- Bearer 토큰 → 에이전트 식별 (Agent Registry 조회, 토큰은 해시 비교)
- 업스트림(설정된 단일 OpenAI 호환 endpoint)으로 전달, SSE/스트리밍 그대로 중계
- 요청/응답 메타데이터 훅 (agent_id, model, token 사용량, latency) → Event Bus (향후 감사·버짓의 기반, R4)
- 업스트림 타임아웃·오류 시 OpenAI 호환 오류 응답 (fail-closed: 미인증 요청 거부)

**Interfaces**: HTTP(OpenAI 호환) 인바운드 / HTTP 아웃바운드(업스트림) / in-proc: `AgentRegistry.resolve_token()`, `EventBus.emit()`

**비-책임**: 요청 본문 변형·재작성 없음 (thin proxy). 에이전트 대화 로직 없음.

## C2. Agent Registry — `caduceusd` 내부 모듈

**Purpose**: 에이전트의 선언 상태(desired state) 단일 저장소.

**Responsibilities**:
- 에이전트 레코드 CRUD: `{name, profile_name, api_server_port, api_server_key_ref, gateway_token_hash, network_mode, docker_image, resources, created_at, desired_state(running/stopped)}`
- `~/.caduceus/registry.json` 원자적 쓰기(임시파일+rename), 로드 시 스키마 검증
- 포트 할당 (base부터 순차, 충돌 회피, 상한 하드코딩 금지 — N10)
- 토큰 발급(발급 시 1회 평문 반환→provisioner가 profile `.env`에 기록)·해시 저장·회전

**Interfaces**: in-proc API (Provisioner/Proxy/Reconciler/Admin API가 사용)

## C3. Provisioner — `caduceusd` 내부 모듈 (control plane)

**Purpose**: 에이전트 생성/삭제의 장기 실행 작업 엔진 (F1).

**Responsibilities**:
- 생성 파이프라인 실행·진행률 이벤트 발행: profile 생성 → config.yaml 작성(모델 라우팅=프록시, terminal docker 설정, api_server 활성) → 토큰 주입(.env) → 서비스 등록 → 기동 → health 확인
- 삭제 파이프라인: 서비스 해제 → gateway 정지 → (옵션) 컨테이너·sandbox·profile 제거 — **파괴적 단계는 명시 확인 요구**
- 작업(Job) 상태 추적 (queued/running/step/failed/done), 실패 시 부분 롤백 가이드 이벤트
- 변경 직렬화: 프로비저닝 작업은 데몬 내 단일 큐로 직렬 실행 (CLI/Web UI 경합 방지)

**Interfaces**: in-proc; 모든 hermes 조작은 **C6 Hermes Adapter 경유** (직접 셸아웃 금지)

## C4. Lifecycle & Health Manager — `caduceusd` 내부 모듈 (control plane)

**Purpose**: start/stop/status/logs/health (F9, N4, N5).

**Responsibilities**:
- start/stop: C7 Service Manager Adapter(등록된 서비스) 또는 C6(직접 gateway 기동) 위임
- health: 각 에이전트 api_server `GET /health`(및 `/health/detailed`) 주기 폴링 + 상태 캐시
- status 합성: desired(레지스트리) + 서비스 상태 + health + 컨테이너 존재 → `AgentStatus`
- logs: hermes profile 로그 파일/서비스 로그 테일 스트림 중계
- **Reconcile 루프**: 주기적으로 desired vs actual 비교 (서비스 죽음/포트 불일치/컨테이너 소실 감지) → 이벤트 발행 + (설정 시) 자동 수렴. 크래시 재시작 자체는 OS 서비스 매니저 담당 (중복 구현 금지, AD-5)

**Interfaces**: in-proc; HTTP 아웃바운드(각 api_server /health)

## C5. Admin API + Event Bus — `caduceusd` 내부 모듈 (control plane 표면)

**Purpose**: CLI·Web UI가 사용하는 제어 API (loopback 바인딩, N3).

**Responsibilities**:
- REST: agents CRUD/start/stop/status/logs, gateway 설정(업스트림 조회/교체, 토큰 회전), jobs 조회
- WebSocket: 이벤트 스트림(상태 전이, 프로비저닝 진행률, health 변화, 프록시 트래픽 요약)
- **Chat 경로 중계**: `/agents/{name}/api/*` → 해당 에이전트 api_server로 리버스 프록시 (API_SERVER_KEY를 서버측에서 부착 — 브라우저에 키 비노출·단일 오리진·CORS 불요). 세션/스트리밍/stop/approval은 api_server 기능을 **그대로 통과** (재구현 금지, P1)
- Web UI 정적 파일 서빙
- Admin API 자체 인증: 로컬 단일 사용자 전제 + loopback 바인딩, admin 토큰 옵션 (NFR 단계 상세)

**Interfaces**: HTTP/WS 인바운드 (127.0.0.1) / in-proc 모듈 호출

## C6. Hermes Adapter — `caduceusd` 내부 모듈 (경계 컴포넌트)

**Purpose**: hermes와의 **유일한** 접점. P1/P3 준수를 코드 구조로 강제.

**Responsibilities**:
- hermes CLI 호출 래핑: `hermes profile create/delete`, `hermes -p <name> gateway start/stop/status` 등
- profile 파일 조작: `config.yaml` 렌더링·병합 쓰기 (model.provider=custom/base_url=프록시, terminal.* docker 설정, network_mode → `--network=host` 또는 bridge+`--add-host=host.docker.internal:host-gateway` 또는 `--network=none`의 `docker_extra_args` 변환), `.env` 키 주입 (`OPENAI_API_KEY`, `API_SERVER_ENABLED/KEY/PORT`), `SOUL.md` 읽기/쓰기 (F7)
- skills/toolsets 편집: profile 디렉터리·config 조작 (hermes 규약 준수)
- hermes 버전/존재 확인 (doctor)

**Interfaces**: in-proc API; 하위로는 subprocess(hermes CLI)와 파일시스템만

**비-책임**: hermes가 CLI/config로 지원하지 않는 동작의 우회 구현 금지 (필요 시 P2 사유 문서화 후 결정)

## C7. GatewayProcessManager — `caduceusd` 내부 모듈 (AMD-1로 재정의)

**Purpose**: 에이전트 gateway를 데몬의 **자식 프로세스**로 관리 — gateway 수명 ⊆ caduceusd 수명 (OS 서비스 통합 없음).

**Responsibilities**:
- `hermes -p cad-<name> gateway` spawn / exit 감시 / 백오프 재시작(desired=running) / graceful stop(SIGTERM→grace→SIGKILL)
- 데몬 종료 시 전 자식 graceful 종료, 기동 시 desired_state=running 에이전트 재기동
- 자식 stdout/err 캡처 → per-agent 로그 버퍼

**Interfaces**: in-proc API; 하위 subprocess(hermes CLI)

## C8. Caduceus CLI (`caduceus`) — 별도 실행 파일 (동일 패키지)

**Purpose**: F10 — 전 기능 커맨드라인.

**Responsibilities**:
- Admin API 클라이언트: `caduceus agent create/ls/start/stop/rm/status/logs/health`, `caduceus gateway status/upstream get|set/token rotate`, `caduceus ui` (브라우저 오픈), `caduceus chat <agent>` (Admin API 경유 api_server 스트리밍 — SSE 렌더링: 텍스트/thinking/tool-call, Ctrl+C→stop)
- 부트스트랩(데몬 비가동 시 직접 실행 경로): `caduceus init`(caduceus home 생성·설정 마법사·서비스 등록), `caduceus serve`(데몬 포그라운드 실행), `caduceus doctor`(hermes/docker/서비스 매니저 진단)
- 종료 코드·`--json` 출력 규약 (스크립팅 친화)

## C9. Web UI (SPA) — `caduceusd`가 서빙하는 정적 자산

**Purpose**: F11 — 자체 Web UI (AD-3), 핵심 UX 통합.

**Responsibilities** (페이지 단위):
- **Agents**: 목록+실시간 상태(WS), 생성 위저드(이름/이미지/리소스/네트워크 모드/persona 초기값, 진행률 스트림), 편집(persona/skills/toolsets/네트워크 모드), start/stop/삭제
- **Chat**: 에이전트 선택 → 세션 목록/생성/재개, 스트리밍 출력(thinking·tool-call 구분 렌더), turn stop, (필요 시) approval 응답 UI
- **Gateway**: 업스트림 상태/교체, 에이전트별 트래픽 요약, 토큰 회전
- **부가**: hermes dashboard 외부 링크 (사용자가 전체 기능 필요 시 — AD-3)

**비-책임**: hermes dashboard 화면 전체의 재구현 (핵심 UX만 통합 — 사용자 결정)

---

## 컴포넌트 ↔ 요구사항 커버리지

| 컴포넌트 | 충족 요구사항 |
|---|---|
| C1 Proxy Plane | F4, N3(토큰), 향후 감사·버짓(R4) |
| C2 Agent Registry | F1/F9 상태, N10 |
| C3 Provisioner | F1, F2/F3(설정 생성 경유), N4 |
| C4 Lifecycle & Health | F9, N4, N5 |
| C5 Admin API/Event Bus | F6(중계)/F9/F11 백엔드, N3(loopback) |
| C6 Hermes Adapter | P1/P3 경계, F5(네트워크 모드 변환), F7 |
| C7 Service Manager Adapter | N4(감독 위임), N9 |
| C8 CLI | F10 |
| C9 Web UI | F11, F6(렌더링) |
| (hermes 네이티브) | F1~F3 실체, F6 실체(api_server), F8(dashboard 링크) |
