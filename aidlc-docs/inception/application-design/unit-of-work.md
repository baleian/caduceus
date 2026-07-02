# Caduceus — Units of Work

**Date**: 2026-07-02
**결정 근거**: unit-of-work-plan.md (Q1=A 4유닛, Q2=A 모노레포, Q3=A CLI 우선)
**용어**: 본 프로젝트는 단일 데몬 배포이므로 유닛 = **개발 작업 단위(logical module)** (독립 배포 서비스 아님)

## U1. Core Foundation

- **포함 컴포넌트**: C2 Agent Registry, C6 Hermes Adapter, C7 Service Manager Adapter
- **책임**: 도메인 타입(AgentSpec/Record/Status), 레지스트리 영속성(원자적 JSON, 포트 할당, 토큰 발급/해시/회전), hermes 접점 전부(profile CRUD, config.yaml/.env/SOUL.md 렌더·조작, skills/toolsets), OS 서비스 접점 전부(systemd user/launchd 등록·제어), preflight/doctor
- **코드 위치**: `caduceus/core/`
- **특성**: I/O 경계 모듈 — 외부 의존(hermes CLI, 파일시스템, OS 서비스)의 유일한 소유자. 순수 로직(타입·검증·렌더링)과 부수효과(subprocess/파일) 분리 설계 → PBT 최적 지대
- **완료 기준**: hermes/서비스 매니저 없이도 순수 로직 테스트 가능(어댑터 페이크), 실제 hermes에 대해 profile 생성→설정 렌더→삭제 왕복 통합 테스트 통과

## U2. Daemon (`caduceusd`)

- **포함 컴포넌트**: C1 Proxy Plane, C3 Provisioner, C4 Lifecycle & Health, C5 Admin API + EventBus
- **책임**: OpenAI 호환 `/v1` 프록시(토큰 식별, SSE pass-through, TrafficEvent), 프로비저닝 잡 엔진(S1, 직렬 큐, 진행률), 라이프사이클/health/reconcile 루프(S3/S5), Admin REST/WS(경로 계약 전체), chat 리버스 프록시(S2), 업스트림 핫스왑(S4), SPA 정적 서빙(빈 자리표시자 — 실제 SPA는 U4)
- **코드 위치**: `caduceus/proxy/`, `caduceus/control/`, 엔트리 `caduceus/daemon.py`
- **특성**: U1 위의 오케스트레이션·HTTP 표면. 2-플레인 내부 인터페이스 3접점 준수 (services.md)
- **완료 기준**: 실 hermes 에이전트 1개 생성→채팅(스트리밍·stop)→정지→삭제 E2E 통과, 프록시 경유 LLM 호출 검증

## U3. CLI (`caduceus`)

- **포함 컴포넌트**: C8
- **책임**: Admin API 클라이언트 커맨드 전체(component-methods.md C8 계약), 스트리밍 채팅 렌더(텍스트/thinking/tool-call, Ctrl+C→stop), `init/serve/doctor` 부트스트랩, `--json` 출력, 종료 코드 규약
- **코드 위치**: `caduceus/cli/`
- **완료 기준**: F9/F10 전 명령 동작 + 채팅 스트리밍 E2E, 데몬 미기동 시 친절한 오류/부트스트랩 안내

## U4. Web UI

- **포함 컴포넌트**: C9
- **책임**: Agents(목록/실시간 상태/생성 위저드/편집), Chat(세션 관리, 스트리밍 렌더, stop, approval), Gateway(업스트림/트래픽/토큰), hermes dashboard 외부 링크. WS 이벤트 구독
- **코드 위치**: `web/` (빌드 산출물 → 패키지 동봉, U2의 정적 서빙 경로에 연결)
- **완료 기준**: F11 플로우 전부 브라우저 E2E (loopback), SECURITY-04 헤더 적용 확인

## 코드 조직 전략 (Greenfield, Q2=A)

```text
<WORKSPACE-ROOT>/
├── caduceus/               # Python 패키지 (단일 배포 단위)
│   ├── core/               # U1: registry.py, types.py, hermes_adapter.py, service_manager.py, errors.py
│   ├── proxy/              # U2: proxy plane
│   ├── control/            # U2: provisioner, lifecycle, admin_api, events
│   ├── cli/                # U3
│   ├── daemon.py           # caduceusd 엔트리
│   └── web_dist/           # U4 빌드 산출물 (패키지 데이터)
├── web/                    # U4 SPA 소스
├── tests/
│   ├── unit/  property/  integration/  e2e/
├── pyproject.toml          # 스크립트: caduceus, caduceusd
└── README.md
```

- 의존 방향 강제: `cli`/`proxy`/`control` → `core` (역방향 금지), `cli` ↛ `proxy`/`control` (HTTP 경유만)
- 프레임워크·도구 확정(async 프레임워크, 패키징, PBT 프레임워크, SPA 스택)은 각 유닛 NFR Requirements에서
