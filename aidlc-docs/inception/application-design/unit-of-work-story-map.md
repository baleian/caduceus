# Caduceus — Requirements → Unit Map

**Note**: User Stories 단계는 생략(승인됨)되어 스토리 대신 **요구사항 ID(F/N/AD)** 를 유닛에 매핑한다. 모든 F/N 요구사항이 하나 이상의 유닛에 배정되었음을 검증(완전성).

## 기능 요구사항 매핑

| 요구사항 | 주 유닛 | 보조 유닛 | 비고 |
|---|---|---|---|
| F1 프로비저닝 | U2 (Provisioner) | U1 (어댑터 실행), U3/U4 (트리거 UI) | S1 플로우 |
| F2 독립 워크스페이스 | U1 (profile 생성 경유) | — | hermes 네이티브 |
| F3 환경 분리·지속 | U1 (terminal config 렌더) | — | hermes docker backend 네이티브 |
| F4 중앙 게이트웨이 | U2 (Proxy Plane) | U1 (토큰), U3/U4 (관리 표면) | AD-6 |
| F5 localhost 도달 | U1 (network_mode 변환) | U4 (모드 선택 UI) | AD-2 |
| F6 스트리밍 대화 | U2 (chat 리버스 프록시) | U3 (터미널 렌더), U4 (웹 렌더) | api_server 네이티브 |
| F7 에이전트별 설정 | U1 (soul/skills/toolsets 조작) | U2 (API 노출), U3/U4 (편집 UI) | |
| F8 대시보드 접근 | U4 (외부 링크) | — | AD-3 |
| F9 라이프사이클 | U2 (Lifecycle) | U1 (서비스 어댑터), U3/U4 | |
| F10 CLI | U3 | U2 (API) | |
| F11 Web UI | U4 | U2 (API+정적 서빙) | |

## 비기능 요구사항 매핑 (주 책임)

| NFR | 주 유닛 | 반영 방식 |
|---|---|---|
| N1 hermes-native·커스텀 최소 | U1 | 접점 수렴(C6/C7), P2 사유 기록 유지 |
| N2 Local-first | U2 | loopback 바인딩, 업스트림만 외부 |
| N3 격리·보안 | U1/U2 | 토큰 해시, .env 주입, loopback, 네트워크 모드 |
| N4 신뢰성 | U2 | health/reconcile, graceful stop; 감독=OS |
| N5 관측성 | U2 | EventBus, status 합성, 로그 중계 |
| N6 리소스 효율 | U1 | 컨테이너 리소스 제한 렌더 (AD-7) |
| N7 단순성 | 전체 | 유닛 경계·금지 의존 준수 |
| N8 패키징 | U2/U3 | 단일 패키지, init/serve, 버전 고정 롤백 (NFR 단계 상세) |
| N9 플랫폼 | U1 | systemd/launchd 이중 백엔드 |
| N10 규모 | U1 | 포트 순차 할당, 상한 없음 |

## 완전성 검증

- F1–F11: 전부 배정 ✓ (11/11)
- N1–N10: 전부 배정 ✓ (10/10)
- 유닛별 요구사항 수: U1=9, U2=11, U3=3, U4=6 (보조 포함) — 고아 요구사항 없음
