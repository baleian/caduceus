# Application Design Plan — Caduceus

**Date**: 2026-07-02
**Prerequisite**: requirements.md v1.0 (approved), hermes-research.md (연구 스파이크 완료)

## Plan Steps

- [x] Step 1: hermes 연구 스파이크 — 네이티브 동작·한계 파악 및 문서화 (`application-design/hermes-research.md`)
- [x] Step 2: 설계 질문 답변 수집·분석 (Q1=A, Q2=B+에이전트별 설정, Q3=B, Q4=A, Q5=A′ 확정, Q6=A)
- [x] Step 3: D-a~D-e 결정 확정 및 근거 문서화 (application-design.md §2 AD-1~AD-7)
- [x] Step 4: `components.md` — 컴포넌트 정의·책임·인터페이스 (C1~C9)
- [x] Step 5: `component-methods.md` — 컴포넌트별 메서드 시그니처 (입출력 타입)
- [x] Step 6: `services.md` — 서비스 계층·오케스트레이션 패턴 (S1~S6, 2-플레인 경계)
- [x] Step 7: `component-dependency.md` — 의존 관계·통신 패턴·데이터 플로우
- [x] Step 8: `application-design.md` — 통합 설계 문서 (P2 커스텀 도입 사유 기록 포함)
- [x] Step 9: 설계 완전성·일관성 검증 (F1–F11/N1–N10 커버리지 + 확장 규칙 컴플라이언스 — application-design.md §5–§6)

---

# 설계 질문

hermes 연구 결과([hermes-research.md](../application-design/hermes-research.md) 참고)를 바탕으로, 컴포넌트 경계를 좌우하는 결정들입니다. 각 질문의 `[Answer]:` 태그에 답해주세요.

## Question 1: 에이전트 토폴로지 (D-b) — gateway 서빙 방식
hermes는 두 가지 네이티브 멀티 에이전트 서빙 경로를 제공합니다. 어느 쪽으로 할까요?

A) **profile별 gateway** (권장) — 에이전트(profile)마다 자체 gateway+api_server 프로세스, 포트 분리. 장점: profile별 터미널 설정(docker 이미지·리소스·persistent 등) **완전 독립**, 장애 도메인 분리(N4), hermes 네이티브 per-profile 서비스(systemd/launchd `gateway-<profile>`) 활용. 단점: 에이전트 수만큼 프로세스(리소스는 부차적 — N6)

B) **단일 multiplexed gateway** — `gateway.multiplex_profiles: true`, 한 프로세스가 `/p/<profile>/` 프리픽스로 전 profile 서빙. 장점: 최소 풋프린트·단일 포트. 단점: **터미널 백엔드 설정이 default profile 것으로 프로세스 전역 공유** (profile별 docker 이미지 차별화 불가), 단일 장애점

C) 단계적 — 우선 A(per-profile)로 설계하되, 훗날 B를 옵션으로 추가할 수 있게 전송 계층만 추상화

D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 2: localhost 도달 범위·방식 (D-a, F5)
Docker bridge 네트워크에서 컨테이너는 호스트 `localhost`에 직접 도달할 수 없습니다. hermes 네이티브(설정-온리) 경로는 `docker_extra_args: ["--add-host=host.docker.internal:host-gateway"]`입니다 (macOS Docker Desktop은 기본 제공).

A) **`host.docker.internal` 사용** (권장) — 에이전트(셸·코드·브라우저 모두)가 `http://host.docker.internal:<port>`로 호스트 서비스 접근. 네트워크 격리 유지, 설정만으로 구현. 에이전트 persona/문서에 이 호스트네임을 안내

B) **`--network=host`** — 컨테이너가 호스트 네트워크 공유, 문자 그대로 `localhost:<port>` 동작. 단, 네트워크 격리 상실(포트 충돌·노출 표면 증가, N3 약화)

C) 리터럴 `localhost` 필수 + 격리 유지 — 커스텀 포워딩(socat/iptables 등) 도입 (P2 위배 소지 — 네이티브 경로 아님, 사유 문서화 필요)

D) Other (please describe after [Answer]: tag below)

[Answer]: B - 기본 호스트 네트워크 공유로 지정하고, CLI나 Web UI를 통해 Agent를 생성하거나 편집을 통해 네트워크 격리 방식 설정 가능

## Question 3: Web UI 실현 방식 (D-d, F11)
hermes dashboard는 profile 생성/삭제, persona(soul)·skills·toolsets 편집, 프로필 지정 채팅(PTY), 세션 조회, 상태/로그까지 네이티브 제공합니다 (F11 요구의 대부분).

A) **hermes dashboard = Caduceus의 Web UI** (권장, P1 최대 부합) — 대시보드를 그대로 채택. Caduceus 고유 기능(게이트웨이 토큰·업스트림·상태, 에이전트 프로비저닝 오케스트레이션)은 CLI + Caduceus 게이트웨이의 최소 admin API/페이지로 제공

B) **Caduceus 자체 thin Web UI** — api_server(들)와 Caduceus 게이트웨이 API 위에 경량 UI 신규 구축. 통합된 단일 UX 확보, 대신 hermes가 이미 제공하는 화면의 재구현 발생(P1/P2 부담 — 사유 문서화 필요)

C) **하이브리드** — Caduceus는 프로비저닝+게이트웨이 관리+에이전트 목록의 얇은 홈 화면만 제공하고, 채팅/세션/설정 편집은 hermes dashboard로 링크/임베드

D) Other (please describe after [Answer]: tag below)

[Answer]: B - Caduceus 자체 Web UI 내에서 핵심적인 기능들은 UX를 통합. 사용자는 필요하다면 Hermes dashboard에 별도로 접속하여 모든 기능을 활용 가능.

## Question 4: 구현 스택 방향 (D-e — 확정은 NFR 단계, 방향만)
hermes는 Python 3.11+ (FastAPI/aiohttp) 생태계입니다. 기존 README 배지도 Python 3.11+입니다.

A) **Python 3.11+** (권장) — hermes와 동일 생태계·의존성 정렬, 단일 언어 유지보수(N7). 게이트웨이는 async 프레임워크(FastAPI/aiohttp 등 — NFR 단계 확정), 패키징은 uv/pipx 계열(N8)

B) Go — 단일 바이너리 배포 이점, 대신 hermes 생태계와 이질적(스택 이원화)

C) Node/TypeScript

D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 5: Caduceus 프로세스 모델 (서비스 계층 경계)
Caduceus 자체가 어떤 상주 프로세스를 가질까요? (R4: 게이트웨이 = 제어 평면 + LLM 프록시)

A) **단일 데몬 = Caduceus Gateway** (권장, P4 부합) — 상주 프로세스는 게이트웨이 하나 (LLM 프록시 + admin/제어 API). 에이전트 라이프사이클(create/start/stop)은 CLI가 hermes CLI·서비스 매니저를 직접 구동하고, 상태는 게이트웨이가 health 폴링/프록시 트래픽으로 관찰

B) 게이트웨이 + 별도 오케스트레이터 데몬 — 라이프사이클 감독(자동 재시작 등)을 전담하는 상주 프로세스 추가 (hermes 네이티브 서비스 매니저와 역할 중복 소지 — P2 사유 필요)

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 6: 에이전트별 게이트웨이 토큰 저장 (F4, N3)
게이트웨이가 에이전트를 식별하는 per-agent 토큰을 어디에 둘까요?

A) **profile `.env`에 주입** (권장, hermes-native) — 에이전트 생성 시 Caduceus가 토큰을 발급해 해당 profile `.env`(예: `OPENAI_API_KEY=cad-<agent>-<random>`)에 기록, 게이트웨이는 토큰→에이전트 매핑 보관. hermes secret scope가 profile별 격리 보장

B) OS keyring 사용 — 디스크 평문 회피 강화, 대신 hermes의 .env 로딩 경로와 통합 필요(커스텀 glue 발생 소지)

C) Other (please describe after [Answer]: tag below)

[Answer]: A
