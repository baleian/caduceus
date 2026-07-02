# Caduceus — Application Design (통합 문서)

**Version**: 1.0
**Date**: 2026-07-02
**Status**: Awaiting user approval
**구성 문서**: [hermes-research.md](hermes-research.md) · [components.md](components.md) · [component-methods.md](component-methods.md) · [services.md](services.md) · [component-dependency.md](component-dependency.md)

---

## 1. 설계 요약

Caduceus = **단일 데몬(`caduceusd`) + CLI(`caduceus`) + SPA(Web UI)**.

- 에이전트의 실체는 **hermes 네이티브 스택**: profile(정체성·설정·세션·워크스페이스 격리) + per-profile gateway/api_server(프로그래매틱 대화) + docker terminal backend(`container_persistent: true`, 환경 격리·지속)
- `caduceusd`는 2-플레인: **Proxy Plane**(OpenAI 호환 `/v1`, per-agent 토큰 식별, 업스트림 단일 교체점 — F4/R4) + **Control Plane**(레지스트리, 프로비저닝 잡, 라이프사이클/health/reconcile, Admin API/이벤트, chat 리버스 프록시)
- hermes·OS 접점은 각각 **Hermes Adapter(C6)**, **Service Manager Adapter(C7)** 로만 수렴 — P1/P3을 코드 구조로 강제
- 감독(크래시 재시작)은 systemd user/launchd에 위임 (hermes 네이티브 per-profile 서비스 경로)

## 2. 확정된 설계 결정 (AD) — D-a~D-e 종결

| ID | 결정 | 내용 및 근거 |
|---|---|---|
| **AD-1** (D-b) | **profile별 gateway 토폴로지** | 에이전트=hermes profile, 에이전트별 gateway+api_server 프로세스(포트 분리). 근거: profile별 터미널 설정 완전 독립(F3), 장애 도메인 분리(N4), hermes 네이티브 per-profile 서비스. multiplexer는 터미널 설정 전역 공유 한계로 배제 (연구 §3). 전송: HTTP/SSE (api_server) |
| **AD-2** (D-a) | **기본 `--network=host`, 에이전트별 격리 모드 선택** | 기본값: 호스트 네트워크 공유 → 리터럴 `localhost:<port>` 도달 (F5, 셸·코드·브라우저 전부). 생성/편집 시 에이전트별 `bridge_hostgw`(bridge+host-gateway alias, 격리 유지) / `none`(차단) 선택 가능. 모두 hermes `docker_extra_args`/`network` 설정만으로 구현 (P3). 보안 트레이드오프는 §5 참조 |
| **AD-3** (D-d) | **자체 Web UI (핵심 UX 통합)** | Caduceus SPA가 프로비저닝·상태·채팅·게이트웨이 관리를 단일 UX로 제공. hermes dashboard는 재구현하지 않고 외부 링크로 전체 기능 접근 보존 (F8). P2 사유: 게이트웨이 관리 UI는 hermes에 존재하지 않고, 채팅·프로비저닝 UX 통합은 제품 핵심 가치 — 단, 화면은 api_server/Adapter 네이티브 API 위의 표현 계층일 뿐 기능 재구현 없음 |
| **AD-4** (D-e) | **Python 3.11+** | hermes와 동일 생태계, 단일 언어 (N7). async 프레임워크·패키징(uv/pipx 계열)·PBT 프레임워크(Hypothesis 유력)는 NFR Requirements에서 확정 (N8) |
| **AD-5** | **단일 데몬 + 내부 2-플레인 (A′)** | 상주 프로세스는 caduceusd 하나. proxy/control 플레인은 명시적 내부 인터페이스 3접점(reload, token cache invalidate, TrafficEvent)으로만 결합 → 향후 프로세스 분리 여지. 감독은 OS 서비스 매니저 위임 (hermes 라이프사이클 재구현 금지). reconcile 루프는 데몬 내 주기 태스크 |
| **AD-6** | **per-agent 토큰 = profile `.env`** | 생성 시 발급, `OPENAI_API_KEY=cad-<agent>-<random>`로 주입 (hermes secret scope가 프로필별 격리). caduceusd는 해시만 저장. 회전 지원 |
| AD-7 (D-c) | 풋프린트 전술 유예 | N6은 부차적 — 컨테이너 리소스 제한(설정)과 toolset 축소(설정)만 1차 제공. 유휴 회수 등은 Operations 이후 검토 |

## 3. P2 기록 — 커스텀 도입 사유 (hermes 네이티브 대안 소진 확인)

| 커스텀 요소 | 네이티브 대안 검토 결과 |
|---|---|
| C1 Proxy Plane (자체 게이트웨이) | `hermes proxy`는 크리덴셜 부착 포워더일 뿐 — per-agent 토큰 식별·중앙 교체점·감사/버짓 기반 없음. R4 사용자 확정 |
| C2~C5 (레지스트리·프로비저너·라이프사이클·Admin API) | hermes에 "다수 profile을 하나의 제어 표면으로 오케스트레이션"하는 개념 없음 (dashboard는 단일 HERMES_HOME 중심 관리 UI). 단, 모든 하위 동작은 hermes CLI/config/api_server를 그대로 사용 — Caduceus는 조합만 담당 |
| C9 Web UI | AD-3 사유. 채팅·세션·중단·승인 = api_server 네이티브 기능의 표현만 |
| 재구현하지 않는 것 | 대화 루프, 세션 저장, 스트리밍, turn 중단, 승인 시스템, 컨테이너 수명 관리, 스킬/메모리, 크래시 재시작 — 전부 hermes/OS 네이티브 |

## 4. 상태·데이터 소유권

| 데이터 | 소유 | 위치 |
|---|---|---|
| 에이전트 선언 상태(spec/port/token hash) | Caduceus | `~/.caduceus/registry.json` (원자적 쓰기, 스키마 버전) |
| Caduceus 설정(업스트림, 바인드) | Caduceus | `~/.caduceus/config.yaml` |
| 에이전트 정체성/설정/세션/메모리/스킬 | hermes | `~/.hermes/profiles/<name>/` |
| 에이전트 실행 환경 | hermes(docker) | 컨테이너 + `sandboxes/docker/<task>/` 바인드 마운트 |
| 평문 토큰 | hermes | 해당 profile `.env`만 (게이트웨이엔 해시) |

## 5. 확장 규칙 컴플라이언스 (설계 단계)

**Security Baseline**:
- SECURITY-04(보안 헤더)·05(입력 검증)·08(접근 제어)·15(fail-closed): C1/C5 설계 계약에 반영 (검증은 코드 단계)
- SECURITY-06(최소 권한): 컨테이너 하드닝은 hermes 기본값(cap drop 등) 유지
- SECURITY-12: 토큰 발급·해시 저장·회전 설계 (AD-6), 하드코딩 크리덴셜 없음
- **SECURITY-07 관련 문서화된 예외**: 기본 `--network=host`(AD-2)는 deny-by-default 원칙의 완화 — 근거: F5 요구(리터럴 localhost)의 사용자 확정, 로컬 단일 사용자 환경, 컨트롤 표면 전부 loopback 바인딩 유지, 에이전트별 `bridge_hostgw`/`none` 격리 옵션 제공, 컨테이너의 여타 하드닝(cap drop, no-new-privileges, 리소스 제한)은 불변. Web UI 생성 위저드에 네트워크 모드별 보안 함의 표기
- SECURITY-14: TrafficEvent/DriftEvent 구조가 인증 실패·이상 이벤트 로깅 기반 제공 (알림 상세는 NFR 단계)

**Resiliency Baseline**:
- RESILIENCY-06: 에이전트 health = api_server `/health` (shallow) + `/health/detailed` (deep) 활용, caduceusd 자체 `/healthz` 제공 예정
- RESILIENCY-10: C1 업스트림 명시적 타임아웃 + fail-closed, chat 프록시 타임아웃 — 계약에 반영 (수치는 NFR 단계)
- RESILIENCY-05/07: EventBus·상태 캐시·로그 중계가 관측성 기반 (N5)
- 클라우드 전용 규칙(08 멀티존, 09 오토스케일링, 11~13 DR)은 R5(N/A) 확정에 따라 N/A — 데이터 영속성은 §4 소유권 + 로컬 디스크 보존으로 충족

**PBT**: 유력 대상 식별 — registry.json 직렬화 round-trip(PBT-02), 포트 할당 불변식(PBT-03), config.yaml 렌더링 멱등성(PBT-04), AgentStatus 합성 로직(PBT-05 oracle). Functional Design(per-unit)에서 확정 (PBT-01)

## 6. 요구사항 커버리지 검증 (Step 9)

| 요구사항 | 충족 경로 | 상태 |
|---|---|---|
| F1 프로비저닝 | S1 플로우 (C3+C6+C7) | ✓ |
| F2 워크스페이스 | hermes profile + sandbox (네이티브) | ✓ |
| F3 환경 분리·지속 | docker backend persistent + per-profile 컨테이너 (네이티브) | ✓ |
| F4 중앙 게이트웨이 | C1 + AD-6 토큰 + S4 교체 | ✓ |
| F5 localhost 도달 | AD-2 | ✓ |
| F6 스트리밍·재개·중단 | api_server 네이티브 + C5 중계 + C8/C9 렌더 | ✓ |
| F7 skills/tools/persona | C6 파일·config 조작 + C5/C8/C9 표면 | ✓ |
| F8 대시보드 | hermes dashboard 외부 링크 (AD-3) | ✓ |
| F9 라이프사이클 | C4 + C7 + S3/S5 | ✓ |
| F10 CLI | C8 | ✓ |
| F11 Web UI | C9 (자체, loopback) | ✓ |
| N1~N10 | P1/P3(C6/C7 수렴), local-first(전부 loopback), 격리(AD-1/2/6), 신뢰성(S5+OS 감독), 관측성(EventBus), 풋프린트(AD-7), 단순성(컴포넌트 9개·데몬 1개), 패키징(AD-4, NFR 확정), 플랫폼(C7 이중 백엔드), 규모(포트 순차 할당·상한 없음) | ✓ |
