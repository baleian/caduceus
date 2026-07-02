# Resiliency Baseline — 후속 결정 질문

Resiliency Baseline 확장을 활성화하셨으므로(Q5=A), 해당 규칙이 **요구사항 확정 전 사용자가 직접 결정해야 한다**고 명시한 항목들을 질문합니다 (RESILIENCY-02/03/04/15 — AI가 임의로 정하지 않고 사용자 답변을 따릅니다).

**맥락 참고**: Caduceus는 클라우드 서비스가 아닌 **로컬 단일 호스트 도구**입니다. 확장 규칙의 선택지는 클라우드 지향 표현을 포함하지만, 로컬 도구 맥락에 맞는 선택지(예: N/A 또는 Other로 로컬 정책 기술)를 고르셔도 됩니다. 답하신 내용은 요구사항 문서에 기록되고 이후 설계 단계로 전파됩니다.

---

## Question 1: RTO/RPO 목표와 재해 복구(DR) 전략 (RESILIENCY-02)
복구 시간 목표(RTO)와 복구 시점 목표(RPO)는 어느 수준입니까? 이는 DR 전략과 데이터 보호 설계를 결정합니다. (Caduceus 맥락에서 "보호 대상 데이터"는 에이전트 워크스페이스 산출물, 세션 이력, 에이전트/게이트웨이 설정 등입니다)

A) RPO/RTO: 수 시간 — Backup & Restore 전략. 최저 비용. 데이터는 백업하고, 장애 시 재설치/복원. 비크리티컬 워크로드에 적합.

B) RPO/RTO: 수십 분 — Pilot Light 전략. 데이터는 실시간 유지, 서비스는 유휴 상태로 준비.

C) RPO/RTO: 수 분 — Warm Standby 전략. 축소 용량으로 상시 가동.

D) RPO/RTO: 거의 실시간 — Multi-site Active/Active 전략. 최고 비용, 무중단 요구.

E) N/A — 단일 호스트 로컬 도구로서 크로스 리전/멀티 사이트 DR 불필요. 호스트 내 데이터 영속성(에이전트 산출물·세션·설정이 재시작/업그레이드에도 보존)과 graceful 복구(N4)로 충분.

F) Other (please describe after [Answer]: tag below)

[Answer]: E

## Question 2: 변경 관리 프로세스 (RESILIENCY-03)
이 프로젝트의 변경(릴리스)은 어떻게 통제됩니까?

A) 기존 조직 변경 관리 프로세스 사용 — 이름/도구를 아래에 기재 (예: ServiceNow, Jira Change, 내부 CAB)

B) 공식 프로세스 없음 — AI-DLC가 경량 변경 관리 프로세스(변경 기록 + 승인 + 롤백 노트, 예: git 브랜치/PR/태그 기반)를 제안하여 채택

C) N/A — 개인/내부 도구로서 공식 변경 관리 면제 (면제 사유를 문서화)

D) Other (please describe after [Answer]: tag below)

[Answer]: B

## Question 3: CI/CD 툴링 (RESILIENCY-04)
어떤 CI/CD 툴링과 배포 프로세스를 사용할까요?

A) 기존 CI/CD 파이프라인 사용 — 도구를 아래에 기재 (예: GitHub Actions, GitLab CI, Jenkins)

B) 파이프라인 없음 — AI-DLC가 선택된 스택/런타임에 맞는 CI/CD 파이프라인 정의를 제안 (예: GitHub Actions로 lint/test/build/release)

C) Other (please describe after [Answer]: tag below)

[Answer]: B

## Question 4: 롤백 메커니즘 (RESILIENCY-04)
릴리스(또는 설치/업그레이드)가 실패하면 어떻게 되돌립니까? (미션 N8 "깨끗한 업그레이드/롤백"과 직결)

A) 이전 버전 재배포 — 버전 고정(version-pinned) 패키지/아티팩트로 롤백 (로컬 CLI 도구의 일반적 방식: 이전 버전 재설치)

B) Blue/green 스왑백 — 이전 환경으로 전환

C) Canary 자동 롤백 — 헬스/메트릭 회귀 시 자동 복귀

D) 데이터베이스 인지 롤백 필요 — 스키마/데이터 마이그레이션 역전을 명시적으로 설계

E) 조직의 기존 롤백 절차 사용 — 참조를 아래에 기재

F) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 5: 배포 스타일 (RESILIENCY-04)
이 워크로드의 리스크 프로파일에 허용 가능한 배포 전략은 무엇입니까?

A) Direct / in-place — 사용자가 패키지를 직접 설치/업그레이드 (로컬 도구의 일반적 방식, 최저 비용)

B) Rolling — 인스턴스 점진 교체

C) Blue/green — 무중단 컷오버

D) Canary — 점진적 트래픽 전환 + 자동 롤백

E) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 6: 인시던트 대응 프로세스 (RESILIENCY-15)
운영 중 발생하는 인시던트(장애)는 어떻게 처리됩니까?

A) 기존 조직 인시던트 대응 프로세스 사용 — 참조를 아래에 기재 (예: PagerDuty 런북, 내부 on-call)

B) 공식 프로세스 없음 — AI-DLC가 경량 인시던트 대응 + 오류 교정(COE/포스트모템) 프로세스를 제안 (예: GitHub Issues 기반 버그 트래킹 + 트러블슈팅 런북 문서)

C) Other (please describe after [Answer]: tag below)

[Answer]: B
