# Requirements Verification Questions — Caduceus

제공해주신 미션 문서(§0–§6)는 매우 상세하며, §4에서 설계 단계로 미룰 결정들을 명시적으로 구분해 주셨습니다. 아래 질문들은 **설계 단계 결정(D-a~D-e)을 침범하지 않는 범위**에서, 요구사항 수준에서 남아있는 모호함을 해소하기 위한 것입니다. 각 질문의 `[Answer]:` 태그 뒤에 선택지 문자를 기입해 주세요.

---

## Question 1
워크스페이스의 기존 `README.md`는 "isolated **Docker containers** backend"라고 프로젝트를 소개하고 있고, 현재 git 브랜치명은 `mig-profile-based`입니다. 반면 미션 §4 D-b는 격리/실행 단위(프로세스/컨테이너/프로필/backend)를 설계 단계 결정으로 명시합니다. README의 Docker 언급을 어떻게 취급할까요?

A) README는 이전 구상의 잔재다 — 격리 단위는 D-b에서 백지 상태로 결정하고, 설계 확정 후 README를 결과에 맞게 갱신한다 (브랜치명 `mig-profile-based`는 hermes profile 기반 접근으로의 전환 의도를 시사)

B) Docker 컨테이너 격리는 확정된 요구사항이다 — D-b는 컨테이너 전제 하에서 세부 방식만 결정한다

C) 이전 Docker 기반 구현이 다른 브랜치/저장소에 존재하며, 이번 작업은 그것을 profile 기반으로 마이그레이션하는 것이다 (해당 코드 위치를 아래에 기재)

D) Other (please describe after [Answer]: tag below)

[Answer]: Hermes 의 multi agents profile + 각 proflie 별 terminal backend 를 docker 로 격리 방식을 고려 중

## Question 2
대상 호스트 플랫폼 범위는 어디까지입니까? (패키징 N8과 격리 메커니즘 설계 범위에 영향)

A) Linux 단일 타깃 (WSL2 포함) — 현재 개발/운용 환경 기준

B) Linux + macOS 모두 1급 지원

C) Linux 우선, macOS는 best-effort (아키텍처가 macOS를 배제하지만 않으면 됨)

D) Other (please describe after [Answer]: tag below)

[Answer]: B

## Question 3
동시 운영 에이전트 규모의 현실적 상한은 어느 정도로 상정할까요? (N6 리소스 효율이 "부차적"이라 하셨으나, 설계 검증 시나리오의 기준이 필요합니다)

A) 소수 (1–5개) — 개인 로컬 사용 기준

B) 중간 (~10–20개) — 다수 에이전트 병렬 실험 가능해야 함

C) 규모 미정 — 설계가 특정 상한을 하드코딩하지만 않으면 됨

D) Other (please describe after [Answer]: tag below)

[Answer]: C

## Question 4
F4 중앙 AI-Gateway의 실현 방식에 대한 제약이 있습니까? "모든 LLM 호출이 경유하는 단일 OpenAI 호환 엔드포인트 + 에이전트별 토큰"이라는 요구사항을 만족한다면:

A) 제약 없음 — §1 원칙(커스텀 최소화)에 따라 설계 단계에서 최선을 선택 (예: Caduceus 자체 구현 vs 기존 OSS 게이트웨이 재사용 vs hermes 네이티브 라우팅 활용, 모두 후보)

B) 게이트웨이는 Caduceus 프로세스의 일부여야 함 — 별도 외부 데몬(예: LiteLLM proxy) 추가 의존은 원치 않음

C) 기존 검증된 OSS 게이트웨이 재사용을 선호 — 직접 구현 최소화

D) Other (please describe after [Answer]: tag below)

[Answer]: B - 게이트웨이는 caduceus의 핵심 기능이로 멀티 에이전트의 제어 평면 역할과 LLM호출 프록시 역할을 수행하며, 추후 agent 별 모니터링, 감사, 승인 게이트웨이, 버짓 제한 등 중앙 제어를 하기 위해 자체 구현되어야 함.

---

# Extension Opt-In Questions

아래는 AI-DLC 워크플로우의 선택적 확장(extension) 활성화 질문입니다.

## Question 5: Resiliency Extensions (복원력 베이스라인)
이 프로젝트에 resiliency baseline을 적용할까요?

**이 확장은 무엇인가.** 활성화하면 검증된 신뢰성·복원력 엔지니어링 모범 사례에서 도출된 **방향 제시적 설계 시점(design-time) 모범 사례** 세트가 적용됩니다. 요구사항·설계·코드를 장애 허용, 고가용성, 관측성, 복구 가능성 방향으로 유도하며 — 비즈니스 목표, 변경 관리, 관측성, 고가용성, 재해 복구, 지속 개선에 걸친 15개 실천 영역을 다룹니다.

**이 확장이 아닌 것.** 활성화해도 워크로드가 프로덕션 준비 상태가 되는 것은 아니며, 특정 가용성·RTO·RPO 목표를 인증하거나 보장하지 않습니다. 초기에 올바른 복원력 결정을 스캐폴딩하는 **출발점**일 뿐 — 구축된 시스템에 대한 공식적인 신뢰성·복원력 리뷰를 대체하지 않습니다.

A) Yes — resiliency baseline을 방향 제시적 모범 사례이자 설계 시점 가이드로 적용 (비즈니스 크리티컬 워크로드에 권장)

B) No — resiliency baseline 생략 (신뢰성보다 빠른 반복이 중요한 PoC/프로토타입/실험 프로젝트에 적합)

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 6: Security Extensions (보안 베이스라인)
이 프로젝트에 security extension 규칙을 강제할까요?

A) Yes — 모든 SECURITY 규칙을 차단(blocking) 제약으로 강제 (프로덕션급 애플리케이션에 권장)

B) No — 모든 SECURITY 규칙 생략 (PoC/프로토타입/실험 프로젝트에 적합)

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 7: Property-Based Testing Extension (속성 기반 테스트)
이 프로젝트에 property-based testing (PBT) 규칙을 강제할까요?

A) Yes — 모든 PBT 규칙을 차단 제약으로 강제 (비즈니스 로직, 데이터 변환, 직렬화, 상태 유지 컴포넌트가 있는 프로젝트에 권장)

B) Partial — 순수 함수와 직렬화 round-trip에만 PBT 규칙 적용 (알고리즘 복잡도가 제한적인 프로젝트에 적합)

C) No — 모든 PBT 규칙 생략 (단순 CRUD, UI 전용, 또는 유의미한 비즈니스 로직이 없는 얇은 통합 계층 프로젝트에 적합)

D) Other (please describe after [Answer]: tag below)

[Answer]: A
