# U4 Web UI — Functional Design Plan

**Date**: 2026-07-03
**Unit**: U4 Web UI (C9 — `web/` SPA 소스, 빌드 산출물은 caduceusd 정적 서빙)
**입력**: components.md C9, component-methods.md C5 경로 계약, U2 Admin API 실 구현 표면(`caduceus/control/api.py`), U3 CLI 실 구현(커맨드 패리티 기준·chat `/v1/runs` 플로우), 사용자 요구(2026-07-03): "CLI에서 할 수 있는 대부분의 기능을 Web UI로도 — 에이전트 생성/중지/재실행/삭제, 게이트웨이 설정, 에이전트 설정, 채팅 UI, 상태 체크 등"
**특성**: SPA는 Admin API의 **순수 HTTP/WS 클라이언트** — caduceusd가 동일 오리진으로 서빙(CORS 불요), 모든 기능은 기존 U2 엔드포인트만 사용(신규 서버 API 필요 시 명시 기록). 스택/빌드 도구 선정은 NFR Requirements 단계로 유예 (FD는 기술 중립).

## Plan Steps

- [x] Step 1: 설계 질문 답변 수집·분석 (Q1=A, Q2=A, Q3=A, Q4=A, Q5=B, Q6=A, Q7=A, Q8=A — 모호성 없음. Q5=B의 세션 관리 확장은 네이티브 `PATCH/DELETE /api/sessions/{id}` 확인으로 성립)
- [x] Step 2: `domain-entities.md` — 화면/라우트 트리, 클라이언트 상태 모델(에이전트 목록·잡·세션·트래픽·이벤트 스트림), API/WS 계약 소비 매핑 테이블 (신규 서버 API 0건 입증)
- [x] Step 3: `business-logic-model.md` — 페이지별 인터랙션 플로우(생성 위저드→잡 진행률, start/stop/rm, 설정 편집→재시작 안내, 채팅 스트리밍 상태 기계·stop·approval, 업스트림 핫스왑), WS 이벤트→상태 리듀서, 재연결/폴백 로직 + Testable Properties PU4-1~7 식별 (PBT-01)
- [x] Step 4: `business-rules.md` — 파괴적 조작 확인 규칙(X-Confirm 모달), 토큰 비노출, 인증 실패 UX, 입력 검증(SECURITY-05), 보안 헤더 요구(SECURITY-04 — 서빙측 규칙 명세), 세션 히스토리 단일 원천(W7)
- [x] Step 5: `frontend-components.md` — 컴포넌트 계층, props/state 정의, 폼 검증 규칙, 컴포넌트별 API 연동 지점
- [ ] Step 6: 완료 메시지 제시 및 승인 대기

## 추가 사용자 결정 (2026-07-03, 답변 수신 시)

- **세션 히스토리 단일 원천**: chat 세션 진입 시 과거 대화 기록은 hermes api_server의 세션 히스토리 API(`GET /api/sessions/{id}/messages`)에서 로드 — 단일 원천은 hermes agent가 보관하는 대화 기록. SPA는 히스토리를 로컬에 영속하지 않으며 진입/재진입/새로고침마다 재하이드레이션 (business-rules.md W7로 규칙화)

## 사전 결정 (질문 불필요 — 근거 명시, 아티팩트에 상세)

- **단일 오리진·상대 경로**: SPA는 caduceusd가 서빙하고 API는 상대 경로 호출 — CORS/절대 URL 설정 불요 (C5 설계 그대로, P4)
- **chat 전송 계약**: U3에서 실 계약 검증된 **`/v1/runs` 플로우 재사용** — 세션 히스토리 `GET /api/sessions/{id}/messages` 하이드레이션 → `POST /v1/runs` → `GET /v1/runs/{id}/events`(data-only SSE) → stop/approval 네이티브. 전부 `/agents/{name}/api/*` 리버스 프록시 경유 (P1/P2 — U3 FD 편차 1 승계)
- **파괴적 조작 확인**: 에이전트 삭제는 모달에서 에이전트 이름 입력 일치 확인 → `X-Confirm: <name>` 헤더 전송 (A5 정합). 워크스페이스 보존 사실을 모달 문구에 명시. `--purge` 없음 (L3 — U3 결정 승계)
- **토큰 비노출**: 게이트웨이 토큰·admin 토큰·API_SERVER_KEY 원문은 어떤 화면에도 미표시 (token rotate 성공 토스트에도 — S3 정합). 키는 서버측 부착이므로 브라우저에 도달하지 않음
- **hermes dashboard**: 외부 링크만 제공 — 화면 재구현 금지 (AD-3, 사용자 기결정)
- **start/stop 즉시 접수**: U2 실 계약이 202 + `{ok}` 즉시 반환 — 버튼은 요청 접수만 표시하고 실제 상태 전이는 WS 이벤트로 반영 (U3 FD 편차 2 승계)
- **doctor는 Web UI 범위 외**: doctor는 데몬 밖 로컬 진단(hermes/docker/rootless 검사) — 데몬이 죽으면 UI 자체가 안 뜨므로 CLI 전용. Web UI의 "상태 체크"는 `GET /api/status`(deep health) + reconciler 드리프트 이벤트 기반으로 충족
- **신규 서버 API 최소화**: 현 U2 표면으로 전 기능 커버 가능 여부를 Step 2에서 매핑 테이블로 입증 — 부족분 발견 시 P2 사유와 함께 명시 목록화 (예상 후보: 없음)

---

# 설계 질문 — U4

아래 각 질문의 `[Answer]:` 태그에 선택지 문자를 기입해 주세요. 선택지에 없으면 마지막 옵션(Other)을 고르고 설명을 적어주세요.

## Question 1: 브라우저의 Admin API 인증 UX

Admin API는 deny-by-default admin 토큰 인증입니다 (U2 FD6). SPA 정적 자산 자체는 무인증 서빙이 자연스럽지만, `/api/*` 호출에는 토큰이 필요합니다. 브라우저가 토큰을 얻는 방식은?

A) **`caduceus ui` 연동 + 수동 폴백 (권장)** — `caduceus ui`가 토큰을 URL fragment(`#token=...`)로 포함해 브라우저를 열고, SPA가 이를 저장(localStorage) 후 fragment 즉시 제거. 직접 접속 시(토큰 미보유) 토큰 입력 화면 표시(`~/.caduceus/admin.token` 경로 안내). fragment는 서버 로그·Referer에 남지 않음

B) **항상 수동 입력** — 최초 접속 시 토큰 입력 화면만 제공, localStorage 저장. `caduceus ui`는 URL만 오픈

C) **loopback 무인증 쿠키** — 데몬이 SPA 로드 시 세션 쿠키를 자동 발급 (loopback 바인딩 신뢰). 입력 UX 없음 — 단, 같은 호스트의 모든 프로세스/브라우저 컨텍스트가 admin 권한을 얻게 되어 deny-by-default(FD6)가 사실상 무효화됨

D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 2: 정보 구조 (페이지 구성)

C9 원안은 Agents / Chat / Gateway 3개 축입니다. "상태 체크·기타" 요구를 반영한 구성은?

A) **4축 (권장)** — ① Agents(목록+상세: 상태/시작/정지/삭제/로그/설정 편집) ② Chat(에이전트 선택→세션→대화) ③ Gateway(업스트림/트래픽/상태) ④ System(deep status `GET /api/status`, 잡 이력 `GET /api/jobs`, 드리프트/이벤트 로그). 최상단에 데몬 연결 상태 배지 상시 표시

B) **3축 (C9 원안)** — Agents/Chat/Gateway만. 잡 진행률은 토스트/배지로, deep status는 Gateway 페이지에 흡수

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 3: 에이전트 생성 UX

CLI `agent create`의 전 옵션(name, image, network host|bridge|none, cpu, memory, persona) 패리티 기준입니다.

A) **단일 폼 + 고급 접기 (권장)** — 필수(name)만 상단, 나머지는 기본값 채운 "고급 옵션" 접기 섹션. 제출 → 202 job → 같은 화면에서 9단계 진행률 실시간 스트림(✓/✗/스피너), 실패 시 단계별 오류와 정리 안내 표시

B) **다단계 위저드** — 기본 정보 → 리소스/네트워크 → persona → 확인의 스텝 진행 (C9 원안 표현 "위저드"에 충실)

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 4: 에이전트 설정 편집 표면 (F7)

U2가 제공하는 편집 표면: soul(전문 read/write), skills(목록+enable 토글), toolsets(구성 read/write), approvals(정책 read/write), token rotate.

A) **구조화 UI (권장)** — soul=멀티라인 에디터(저장 시 diff 없이 전문 교체), skills=토글 리스트, toolsets/approvals=서버 스키마 기반 구조화 폼(토글/셀렉트) + "raw 보기" 접기. 변경 저장 시 "게이트웨이 재시작 필요" 안내 배너(S6) + 재시작 버튼

B) **raw 편집 위주 (thin)** — soul만 에디터, skills 토글, toolsets/approvals는 raw JSON/YAML textarea 그대로 편집 (P4 최소 표면 — 스키마 UI 미구현)

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 5: Chat 세션 관리 범위

api_server 네이티브 세션 API(`/agents/{name}/api/api/sessions/*` 중계)가 제공하는 것 중 어디까지 노출할까요? (CLI는 목록/자동 재개/새 세션까지 — Q4=A)

A) **CLI 패리티 (권장)** — 세션 목록(최근순)/새 세션/선택 재개(히스토리 하이드레이션 렌더). 스트리밍은 thinking(접기/펼치기)·tool-call(이름+인자 요약+결과 접기) 구분 렌더, 진행 중 turn stop 버튼, approval 요청 인라인 카드(once/session/always/deny)

B) **패리티 + 세션 관리 확장** — A에 더해 api_server가 네이티브 지원하는 범위 내에서 세션 삭제·이름 변경 등 관리 조작 추가 (네이티브 미지원 항목은 제외)

C) Other (please describe after [Answer]: tag below)

[Answer]: B

## Question 6: 실시간 갱신 방식

U2 WS `/api/events`는 리플레이(500)+실시간으로 상태 전이/잡 진행/health 변화/트래픽/드리프트 이벤트를 제공합니다.

A) **전역 WS 단일 구독 (권장)** — 앱 로드 시 1개 WS 연결, 이벤트→상태 리듀서로 전 화면(상태 배지·잡 진행률·트래픽 카운터·드리프트 경고 토스트) 실시간 반영. 끊김 시 지수 백오프 재접속 + 재접속 간 REST 재조회로 정합 복구

B) **폴링만** — WS 미사용, 화면별 주기 폴링 (단순하나 잡 진행률·트래픽 실시간성 저하)

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 7: Gateway 페이지 범위

A) **전체 (권장)** — 업스트림 조회/교체 폼(base_url, api_key_env, default_model — 핫스왑, 적용 결과 즉시 표시), 에이전트별 트래픽 요약 표(요청 수/토큰/최근 활동, TrafficEvent 실시간), 최근 요청 목록(링버퍼 100 — 메타데이터만, 본문 없음), 에이전트별 게이트웨이 토큰 회전 버튼

B) **업스트림 + 요약만** — 최근 요청 목록 생략

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 8: 에이전트 로그 뷰

U2 logs는 스냅샷(last N, 최대 2000)입니다. CLI `-f`는 폴링 tail로 구현했습니다 (U3 Q6=A).

A) **스냅샷 + follow 토글 (권장)** — 에이전트 상세의 로그 탭: 최근 N줄 + "follow" 토글 시 1~2s 폴링으로 신규 라인 append (U3 tail dedup 로직과 동일 규칙)

B) **스냅샷만** — follow 없음, 새로고침 버튼만

C) Other (please describe after [Answer]: tag below)

[Answer]: A
