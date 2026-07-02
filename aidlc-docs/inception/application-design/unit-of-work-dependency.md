# Caduceus — Unit Dependencies

## 의존 매트릭스 (행이 열에 의존)

| ↓ 의존자 \ 피의존 → | U1 Core | U2 Daemon | U3 CLI | U4 Web UI |
|---|---|---|---|---|
| U1 Core Foundation | — | | | |
| U2 Daemon | **코드 의존** (core import) | — | | |
| U3 CLI | 타입 공유(core.types) | **API 계약 의존** (HTTP/WS) | — | |
| U4 Web UI | | **API 계약 의존** (HTTP/WS) + 정적 서빙 연결 | | — |

- U3/U4는 U2 프로세스에 런타임 의존하지만 코드 의존은 API 계약(component-methods.md C5)뿐 → 계약 고정 후 병행 가능
- 외부 의존: U1 → hermes CLI/config·docker·systemd/launchd, U2 → 업스트림 LLM endpoint

## 구현 순서 (Q3=A: CLI 우선)

```text
U1 Core Foundation  -->  U2 Daemon  -->  U3 CLI  -->  U4 Web UI
(기반: 타입/어댑터)      (프록시+제어+API)   (1차 클라이언트,   (SPA, U3로 검증된
                                        E2E 검증 수단)    API 위에 구축)
```

- **크리티컬 패스**: U1 → U2 (U2는 U1 없이 착수 불가)
- **병행 기회**: U4 디자인/스캐폴딩은 U3 진행 중 시작 가능 (API 계약 고정 시점 이후) — 단 Construction 루프는 순차 승인 유지
- **테스트 체크포인트**: U1 완료(어댑터 통합 테스트) → U2 완료(단일 에이전트 E2E) → U3 완료(CLI 전 명령 E2E) → U4 완료(브라우저 E2E) → Build & Test(통합)
- **롤백/실패 전략**: 그린필드 git 기반 — 유닛별 브랜치/커밋 경계 권장 (R6 경량 변경 관리와 정합)

## 유닛 간 계약 (변경 통제 지점)

| 계약 | 소유 유닛 | 소비 유닛 | 문서 |
|---|---|---|---|
| core 공개 API (Registry/Adapters/types) | U1 | U2 | component-methods.md C2/C6/C7 |
| Admin REST/WS 경로·스키마 | U2 | U3, U4 | component-methods.md C5 |
| 이벤트 스키마 (Status/Job/Traffic/Drift) | U2 | U3, U4 | Functional Design(U2)에서 확정 |
| hermes 설정 렌더 규약 (config.yaml/.env) | U1 | (외부: hermes) | hermes-research.md §2/§5 |
