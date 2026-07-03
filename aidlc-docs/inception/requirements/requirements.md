# Caduceus — Requirements Document

**Version**: 1.1 (F3 개정 — 2026-07-03)
**Date**: 2026-07-02
**Status**: Awaiting user approval
**Depth**: Comprehensive

---

## 1. Intent Analysis

| 항목 | 판정 |
|---|---|
| **User Request** | 격리된 hermes 에이전트들을 프로비저닝·관찰·대화하게 해주는 로컬 우선 thin 오케스트레이션/컨트롤 계층 + CLI + 로컬 Web UI 구축. 모든 에이전트 LLM 호출은 중앙 게이트웨이 경유 |
| **Request Clarity** | Clear — 상세한 미션 문서(§0–§6) 제공, 설계 유예 결정(D-a~D-e)까지 명시 |
| **Request Type** | New Project (Greenfield) |
| **Scope Estimate** | System-wide — 신규 시스템 전체 (오케스트레이션 계층, 게이트웨이, CLI, Web UI) |
| **Complexity Estimate** | Complex — 다중 컴포넌트, 격리/보안 요구, 외부 런타임(hermes) 네이티브 통합, 스트리밍 대화 |

## 2. Project Overview

**Caduceus** = hermes(로컬 AI 에이전트 런타임) 위에서 여러 에이전트를 **격리 운영**하고, 그들의 모델 호출을 **중앙 게이트웨이**로 모으는 로컬 도구.

로컬 우선(local-first)으로, 격리된 hermes 에이전트들을 프로비저닝·관찰·대화(chat)하게 해주는 **얇은(thin) 오케스트레이션/컨트롤 계층 + CLI + 로컬 Web UI**. 모든 에이전트의 LLM 호출은 하나의 중앙 게이트웨이를 경유한다.

**범위**: 로컬 에이전트만. 원격 에이전트는 범위 외 (§10 참조).

## 3. 최우선 설계 원칙 (P1–P4 — 다른 모든 요구사항에 우선)

| ID | 원칙 | 내용 |
|---|---|---|
| **P1** | hermes-native 최대 준수 | hermes가 네이티브로 제공하는 메커니즘(profiles, terminal backends, gateway/api_server, dashboard, config 라우팅, approvals 등)이 있으면 그대로 사용. 위에 별도 계층 재구현 금지 |
| **P2** | 커스텀 코드·workaround 최소화 | Caduceus는 hermes 위의 thin control layer. 커스텀 코드/glue/우회책은 "hermes에 네이티브 경로가 없음"을 입증했을 때만 도입하고 사유를 문서에 기록 |
| **P3** | 설정 우선 (configuration over code) | 가능하면 hermes의 config/CLI로 해결. hermes가 관리하는 라이프사이클 재구현 금지 |
| **P4** | 작은 표면적 | 의존성·개념·상태 최소화. 유지보수성과 테스트 용이성을 코드량보다 우선 |

## 4. 기능 요구사항 (Functional Requirements)

| ID | 이름 | 요구사항 |
|---|---|---|
| **F1** | 격리된 로컬 에이전트 프로비저닝 | 각 에이전트는 hermes를 실행하며 서로 격리된다 |
| **F2** | 독립·영속 워크스페이스 | 에이전트마다 격리된 작업 디렉터리를 가지며 산출물이 보존된다 |
| **F3** | 환경 자체의 분리 (핵심) | 한 에이전트가 환경에 설치한 도구(pip/npm 등 사용자 레벨)는 그 에이전트에서는 지속되고, 다른 에이전트에는 전혀 영향이 없어야 한다. *(v1.1 개정: 샌드박스는 호스트 사용자 권한으로 실행 — `docker_run_as_host_user` — root 전용 시스템 패키지 설치(`apt-get`)는 범위 제외. 결정 2026-07-03, sandbox-ownership-question.md Q1=C)* |
| **F4** | 중앙 AI-Gateway | 모든 에이전트의 LLM 호출이 경유하는 단일 OpenAI 호환 엔드포인트. 모델/프로바이더를 한 곳에서 교체 가능. 에이전트별 인증(토큰). **[R4에 의해 구체화]** 게이트웨이는 Caduceus의 핵심 기능으로 자체 구현한다 — 멀티 에이전트의 제어 평면(control plane) + LLM 호출 프록시 역할. 외부 게이트웨이 데몬(예: LiteLLM proxy) 추가 의존 배제. 향후 에이전트별 모니터링, 감사, 승인 게이트, 버짓 제한 등 중앙 제어의 기반이 되도록 확장 가능해야 한다 |
| **F5** | 로컬 서비스 도달성 | 로컬 에이전트가 호스트에서 별도 프로세스로 뜬 서비스(예: `localhost:xxxx`)에 접근할 수 있어야 한다. 도달 범위(브라우저만 vs 셸까지)와 실현 방식은 설계 단계 결정(D-a) |
| **F6** | 스트리밍 대화 | 에이전트와의 대화에서 스트리밍 출력, thinking, tool-call 표시. 세션 영속 및 재개(resume). 진행 중 turn의 중단(stop/cancel) |
| **F7** | 에이전트별 설정 | skills, tools/toolsets, persona(정체성) 편집 |
| **F8** | 에이전트 대시보드 접근 | hermes 네이티브 대시보드에 접근(제공 시). 네이티브 방식 우선 |
| **F9** | 라이프사이클 관리 | create / start / stop / remove / status / logs / health |
| **F10** | CLI | 위 기능 전체를 구동하는 커맨드라인 |
| **F11** | 로컬 Web UI | 프로비저닝, 실시간 상태/진행 관찰, 대화를 제공. 로컬(loopback) 바인딩 |

## 5. 비기능 요구사항 (Non-Functional Requirements)

| ID | 이름 | 요구사항 |
|---|---|---|
| **N1** | hermes-native 우선·커스텀 최소화 | §3 P1–P4의 최우선 원칙을 NFR로도 명시 |
| **N2** | Local-first | 단일 호스트, 필수 클라우드 의존 없음. 사용자가 제공한 OpenAI 호환 LLM(예: Ollama/llama.cpp/vLLM/호스티드)에 연결 |
| **N3** | 격리·보안 | 강한 에이전트별 격리(환경·파일시스템), 에이전트별 크리덴셜, 컨트롤 표면의 loopback 바인딩, 선택적 강화 샌드박싱. 불필요한 호스트 디스크상 비밀 저장 회피 |
| **N4** | 신뢰성 | 에이전트 라이프사이클 관리·감독, health 체크, graceful start/stop/shutdown, 세션 재개 |
| **N5** | 관측성 | 실시간 상태, health, 로그 |
| **N6** | 리소스 효율 (부차적) | 과도한 낭비는 피하되 아키텍처를 좌우하지 않음. 에이전트별 풋프린트 축소 허용 (전술은 설계 단계, D-c) |
| **N7** | 단순성·유지보수성 | thin layer, 작은 의존성, 테스트 가능 |
| **N8** | 패키징 | 손쉬운 설치와 깨끗한 업그레이드/롤백 (스택은 설계 단계, D-e). **[R8/R9에 의해 구체화]** 롤백 = 버전 고정(version-pinned) 이전 버전 재설치, 배포 스타일 = direct/in-place 설치·업그레이드 |
| **N9** | 플랫폼 지원 **[R2]** | Linux(WSL2 포함) + macOS 모두 1급(first-class) 지원 |
| **N10** | 규모 **[R3]** | 동시 에이전트 수 상한 미정 — 설계가 특정 상한을 하드코딩하지 않아야 함 |

## 6. 확정된 명확화 사항 (Resolved Clarifications)

요구사항 검증 질문(requirement-verification-questions.md) 및 resiliency 후속 질문(resiliency-clarification-questions.md)의 사용자 답변:

| ID | 주제 | 사용자 결정 |
|---|---|---|
| **R1** | 격리 방식 후보 | **유력 후보 아키텍처**: hermes multi-agent **profiles** + 각 profile별 **terminal backend를 Docker로 격리**. 사용자가 "고려 중"이라고 명시 → 확정 제약이 아닌 선호 후보로 기록. 설계 단계(D-b)에서 hermes 네이티브 동작 검증 후 확정. 기존 README.md의 Docker 언급은 이 방향과 정합적이며, 설계 확정 후 README를 결과에 맞게 갱신 |
| **R2** | 플랫폼 | Linux + macOS 모두 1급 지원 (→ N9) |
| **R3** | 동시 에이전트 규모 | 미정 — 상한 하드코딩 금지 (→ N10) |
| **R4** | 게이트웨이 실현 | 자체 구현 필수 (Caduceus 핵심 기능). 제어 평면 + LLM 프록시. 향후 모니터링·감사·승인·버짓 제한 확장 기반 (→ F4) |
| **R5** | RTO/RPO·DR 전략 | **N/A** — 단일 호스트 로컬 도구로서 크로스 리전/멀티 사이트 DR 불필요. 호스트 내 데이터 영속성(에이전트 산출물·세션·설정이 재시작/업그레이드에도 보존)과 graceful 복구(N4)로 충분 (RESILIENCY-02) |
| **R6** | 변경 관리 | 공식 프로세스 없음 → 경량 변경 관리 프로세스(변경 기록 + 승인 + 롤백 노트, git 브랜치/PR/태그 기반)를 제안·채택 (RESILIENCY-03) |
| **R7** | CI/CD | 파이프라인 없음 → 선택된 스택/런타임에 맞는 CI/CD 파이프라인 정의를 제안 (예: lint/test/build/release) (RESILIENCY-04) |
| **R8** | 롤백 메커니즘 | 이전 버전 재배포 — 버전 고정 패키지/아티팩트 롤백 (RESILIENCY-04, → N8) |
| **R9** | 배포 스타일 | Direct / in-place — 사용자가 패키지를 직접 설치/업그레이드 (RESILIENCY-04, → N8) |
| **R10** | 인시던트 대응 | 공식 프로세스 없음 → 경량 인시던트 대응 + COE(포스트모템) 프로세스 제안 (예: GitHub Issues 버그 트래킹 + 트러블슈팅 런북) (RESILIENCY-15) |

## 7. 설계 단계로 유예된 결정 (Deferred Design Decisions)

요구사항 단계에서 확정하지 않으며, 설계 단계에서 P1–P4 원칙 아래 결정한다:

| ID | 결정 사항 | 비고 |
|---|---|---|
| **D-a** | `localhost` 도달 범위·방식 | 브라우저만 vs 셸/코드까지. 파일시스템/환경 격리를 유지하면서 호스트 로컬 서비스 도달을 어떻게 확보할지 |
| **D-b** | 에이전트 토폴로지·전송 | 격리/실행 단위(프로세스/컨테이너/프로필/backend)와 제어·대화 전송. R1의 유력 후보(profiles + Docker terminal backend)를 hermes 네이티브 검증 후 확정 |
| **D-c** | 풋프린트 전술 | 유휴 회수, toolset 축소, 경량 실행 이미지 등 (필요 시에만) |
| **D-d** | 대시보드 통합 방식 | 네이티브 노출 vs 리버스 프록시 |
| **D-e** | 스택/프레임워크/패키징 | (참고: 기존 README 배지는 Python 3.11+을 표기하나 확정 아님) |

### 7.1 설계 착수 전제 — hermes 학습 (미션 §5)

설계 전에 hermes 공식 문서(`hermes-agent.nousresearch.com/docs`)와 소스(GitHub `NousResearch/hermes-agent`)로 다음 영역의 **네이티브 동작과 한계**를 직접 파악해야 한다:

1. **profiles** — 생성/복제/배포, 격리 경계 (무엇을 분리하고 무엇을 분리하지 않는가)
2. **terminal backends** — 종류(로컬/컨테이너/원격 등), 실행 격리·상태 영속성
3. **gateway / api_server** — 세션 생성, 스트리밍 대화, turn 중단, 이력, health. 여러 에이전트/프로필 동시 서빙 방식과 한계
4. **tool 실행 위치** — 각 tool이 실제로 어디서 실행되는지(격리 경계 안/호스트/외부)와 결정 요인
5. **모델 라우팅** — config로 LLM 호출을 커스텀 게이트웨이 base_url로 보내는 방법과 인증
6. **네트워킹** — 격리된 실행 단위에서 호스트 `localhost` 서비스 도달 방법
7. **dashboard**, **approvals**(무인 운용), 리소스 제한/하드닝

커스텀/우회가 필요하면 hermes 네이티브 대안을 먼저 소진했는지 확인하고, 불가피한 경우에만 도입·기록한다 (P2).

## 8. 확장(Extension) 구성 및 적용 방침

| Extension | 상태 | 적용 방침 |
|---|---|---|
| **Resiliency Baseline** | 활성 (blocking) | R5–R10으로 사용자 결정 완료. 로컬 단일 호스트 맥락에서 클라우드 전용 규칙(멀티 존/리전 등)은 각 스테이지에서 N/A 판정 + 근거 기록. 데이터 영속성·health·graceful 복구·타임아웃/서킷브레이커 등 로컬 적용 가능 규칙은 강제 |
| **Security Baseline** | 활성 (blocking) | N3(격리·보안)과 정합. 특히 SECURITY-04(웹 보안 헤더 — Web UI), SECURITY-05(입력 검증 — 게이트웨이/API), SECURITY-06(최소 권한), SECURITY-08(접근 제어 — 에이전트별 토큰), SECURITY-09(하드닝), SECURITY-10(공급망 — lock file, 버전 고정), SECURITY-12(크리덴셜 관리 — 비밀 저장 회피), SECURITY-15(fail-safe) 등이 설계/코드 단계에서 검증됨 |
| **Property-Based Testing** | 활성 — **전체 강제** (blocking) | Functional Design에서 속성 식별(PBT-01), NFR에서 프레임워크 선정(PBT-09), 코드 생성 시 PBT 테스트 생성(PBT-02~08, 10). 게이트웨이 요청/응답 변환, 설정 직렬화, 상태 머신(에이전트 라이프사이클) 등이 유력 적용 대상 |

## 9. 워크로드 중요도 분류 (RESILIENCY-01)

| 컴포넌트 (논리) | 중요도 | 불가용 시 영향 | 의존성 |
|---|---|---|---|
| 중앙 AI-Gateway | **Critical** | 모든 에이전트의 LLM 호출 중단 — 전 에이전트 작업 불능 | 상류: 사용자 제공 LLM 엔드포인트 / 하류: 모든 에이전트 |
| 에이전트 런타임(hermes 인스턴스들) | High | 해당 에이전트의 작업 중단 (다른 에이전트는 격리로 무영향 — F3) | 상류: 게이트웨이, 격리 실행 환경 |
| 오케스트레이션/컨트롤 계층 | High | 신규 프로비저닝·라이프사이클 제어 불능 (기동 중인 에이전트는 영향 최소화가 바람직) | 상류: hermes CLI/config, 격리 런타임 |
| CLI / Web UI | Medium | 제어·관찰 편의 상실 (에이전트 자체는 계속 동작) | 상류: 컨트롤 계층, 게이트웨이 |
| 영속 데이터 (워크스페이스, 세션, 설정) | Critical (무결성) | 산출물/이력/설정 유실 — R5에 따라 호스트 내 영속성으로 보호 | 하류: 전 컴포넌트 |

## 10. 범위 외 (Out of Scope)

- 원격(remote) 에이전트 운영
- 클라우드 배포, 멀티 호스트/멀티 리전 토폴로지, 크로스 리전 DR (R5)
- 멀티 테넌트/다중 사용자 서비스화 (컨트롤 표면은 loopback 바인딩 — N3)
- LLM 자체의 호스팅 (사용자가 OpenAI 호환 엔드포인트 제공 — N2)

## 11. 성공 기준 (Success Criteria)

1. 사용자가 CLI 또는 Web UI로 에이전트를 생성하면, 격리된 워크스페이스·환경을 가진 hermes 에이전트가 기동된다 (F1/F2/F3/F9/F10/F11)
2. 한 에이전트에서 pip/npm 등 사용자 레벨 환경 변경을 수행해도 다른 에이전트 환경은 불변이고, 해당 에이전트 재시작 후에도 지속된다 (F3, v1.1 개정)
3. 모든 에이전트의 LLM 호출이 Caduceus 게이트웨이를 경유하며, 업스트림 모델/프로바이더 교체가 게이트웨이 설정 한 곳에서 이루어진다. 에이전트별 토큰으로 식별·인증된다 (F4)
4. 에이전트가 호스트 로컬 서비스(`localhost:xxxx`)에 설계에서 정한 범위로 도달할 수 있다 (F5)
5. Web UI/CLI에서 스트리밍(thinking, tool-call 포함) 대화, 세션 재개, 진행 중 turn 중단이 동작한다 (F6)
6. 에이전트별 skills/tools/persona 편집이 가능하다 (F7)
7. hermes 네이티브 대시보드 접근이 가능하다(제공 시) (F8)
8. Linux(WSL2 포함)와 macOS에서 설치·업그레이드·버전 고정 롤백이 동작한다 (N8/N9/R8)
9. 최종 설계·구현이 P1–P4 준수를 입증한다: 커스텀 코드 도입부에는 "hermes 네이티브 경로 부재" 근거가 문서화되어 있다
