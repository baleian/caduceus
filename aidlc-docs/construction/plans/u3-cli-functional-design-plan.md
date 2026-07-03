# U3 CLI — Functional Design Plan

**Date**: 2026-07-03
**Unit**: U3 CLI (C8 — `caduceus/cli/`)
**입력**: components.md C8, component-methods.md C8 커맨드 계약, U2 Admin API 실 구현 계약 (`caduceus/control/api.py` — REST/WS 전체), hermes-research.md (api_server chat SSE 이벤트)
**특성**: CLI는 Admin API의 **순수 HTTP 클라이언트** — `caduceus.core`만 import 가능, `proxy`/`control` import 금지 (unit-of-work.md 의존 규칙). 유일한 예외 경로는 `serve`(데몬 인프로세스 기동)와 `init`/`doctor`(로컬 파일·환경 진단).

## Plan Steps

- [x] Step 1: 설계 질문 답변 수집·분석 (Q1=A, Q2=B detach 옵션+기본 포그라운드, Q3=A, Q4=A, Q5=A, Q6=A, Q7=A — 모호성 없음)
- [x] Step 2: `domain-entities.md` — 커맨드 트리 전체(인자·플래그·기본값), 데몬 접속 컨텍스트(ClientConfig), 종료 코드 규약 테이블, 출력 모드(사람/`--json`) 스키마
- [x] Step 3: `business-logic-model.md` — 커맨드→API 매핑 전표, 비동기 잡 UX(진행률 렌더 상태 기계), chat 스트리밍 렌더 파이프라인(SSE 이벤트→화면 요소, Ctrl+C 상태 기계, approval 응답 플로우), init/serve/doctor/ui 부트스트랩 로직, 오류→메시지·종료코드 매핑 + Testable Properties PU3-1~7 (PBT-01)
- [x] Step 4: `business-rules.md` — 파괴적 명령 확인 규칙(X-Confirm), 토큰 취급(출력 금지·redact), 데몬 미가동 안내, 스크립팅 규약(--json 시 stdout 순수성), 문서화된 예외
- [x] Step 5: 완료 메시지 제시 및 승인 대기

## 사전 결정 (질문 불필요 — 근거 명시, 아티팩트에 상세)

- **접속·인증 자동 해석**: CLI는 `~/.caduceus/config.yaml`의 listen 값과 `~/.caduceus/admin.token`을 자동 로드 (같은 호스트 로컬 도구 — 무비용 인증, FD6 정합). env `CADUCEUS_URL`/`CADUCEUS_ADMIN_TOKEN`으로 오버라이드 가능
- **파괴적 명령 확인**: `agent rm`은 대화형 확인(에이전트명 입력 or y/N) 후 `X-Confirm: <name>` 헤더 전송, `--yes`로 스킵 (A5 정합). 워크스페이스 보존 사실을 확인 문구에 명시
- **`--purge` 제거**: C8 계약 초안의 `rm --purge`는 L3(워크스페이스는 코드로 절대 삭제하지 않음) 위반 — 제공하지 않음. 워크스페이스 정리는 사용자가 직접 (경로 안내만 출력)
- **종료 코드 규약**: 0 성공 / 1 일반 오류·잡 실패 / 2 사용법 오류 / 3 데몬 접속 불가 / 4 대상 없음(agent/session/job) / 5 확인 거부·충돌(409) — 스크립팅 계약으로 고정, 아티팩트에 표로 명세
- **stdout/stderr 규약**: `--json` 모드에서 stdout은 JSON만(파이프 친화), 진행률·안내는 stderr. 사람 모드는 stdout 혼용 허용
- **토큰 비노출**: 어떤 출력 경로에도 토큰 원문 미표시 (token rotate 성공 메시지에도 — S3 정합)

---

# 설계 질문 — U3

## Question 1: `caduceus init`의 범위

child-process 모델 확정으로 C8 계약 초안의 `init --service`(서비스 등록)는 무효입니다. `serve`(데몬 기동)가 최초 실행 시 홈 디렉토리·기본 config·admin 토큰을 자동 생성하므로(U2 구현 완료), `init`의 남은 역할은 무엇으로 할까요?

A) **경량 유지 (권장)** — `init` = 홈/기본 config/admin 토큰을 미리 생성 + upstream(base_url, api_key_env) 대화형 1회 설정 + preflight 요약 출력. 이미 초기화된 경우 멱등(현재 설정 표시). 데몬 없이 설정만 준비하고 싶을 때 유용

B) **제거** — `serve`의 자동 초기화로 충분. upstream 설정은 `gateway upstream set`으로. 커맨드 표면 최소화 (P4)

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 2: `caduceus serve` 실행 형태

A) **포그라운드 전용 (권장)** — `caduceusd`와 동일한 인프로세스 uvicorn 기동(같은 코드 경로), Ctrl+C로 종료. 백그라운드가 필요하면 사용자가 `nohup`/`tmux`/OS 도구 사용 (child-process 모델·P4 정합, 데몬화 코드 미보유)

B) **`--detach` 지원** — 자체 데몬화(fork, pid 파일, `caduceus serve stop`). 편의성 대신 pid 관리·좀비·로그 리다이렉션 복잡도 추가

C) Other (please describe after [Answer]: tag below)

[Answer]: B (-d 또는 --detach 옵션으로 데몬화, 옵션 없을 시 포그라운드)

## Question 3: 비동기 잡 명령의 대기 UX

`agent create/rm/start/stop`은 Admin API가 202 + job을 반환합니다 (U2). CLI 기본 동작은?

A) **기본 대기 + 진행률 렌더 (권장)** — 잡 스텝을 실시간 표시(✓/✗/스피너, WS 이벤트 구독 또는 폴링)하고 완료/실패 시 종료 코드 반영. `--no-wait`로 job id만 출력하고 즉시 반환

B) **기본 즉시 반환** — job id 출력 후 종료, `--wait`로 대기. `caduceus job status <id>`로 추적

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 4: `caduceus chat <name>` 세션 기본 동작

A) **마지막 세션 자동 재개 (권장)** — 세션이 있으면 최근 세션 이어서(F6 resume), 없으면 새로 생성. `--new` 강제 새 세션, `--session <id>` 특정 세션 지정, 시작 시 어느 세션인지 헤더 라인 표시

B) **항상 새 세션** — 매 실행 새 세션, `--resume`으로만 이어서

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 5: chat 스트리밍 렌더 상세 (F6)

hermes api_server SSE는 텍스트 델타 외에 `reasoning.available`(thinking), `tool.*`(tool call 시작/결과), approval 요청 이벤트를 보냅니다. 터미널 렌더는?

A) **전부 표시 (권장)** — thinking은 흐린 색(dim)으로 스트리밍, tool call은 `⚙ <tool> <args 1줄 요약>` + 완료 표시, approval 요청은 인라인 `[y/N]` 프롬프트로 즉시 응답 전송. Ctrl+C 1회 = 현재 turn stop(세션 유지, 프롬프트 복귀), 유휴 상태 Ctrl+C(또는 `/exit`) = 종료

B) **간결 모드 기본** — thinking 기본 숨김(`--thinking` 플래그로 표시), tool call은 한 줄 요약만. 나머지는 A와 동일

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 6: `agent logs -f` (follow) 구현 방식

U2 Admin API의 logs는 스냅샷(last N lines)입니다. `-f`는?

A) **폴링 tail (권장)** — 주기(1~2s) 재요청으로 신규 라인만 출력. 서버 변경 불필요, 단순. (N4: 추가 의존 없음)

B) **v1 제외** — `-f` 없이 스냅샷만. follow가 필요하면 후속 버전에서 서버 스트리밍 추가

C) **서버 스트리밍 추가** — U2에 로그 tail 스트리밍 엔드포인트(SSE)를 추가하는 변경을 수반

[Answer]: A

## Question 7: `--json` 적용 범위

A) **조회형 + 잡 명령 (권장)** — `agent ls/status/logs`, `gateway status/upstream get`, `job ls/status`에 `--json`. 잡 명령(create/rm/start/stop)도 `--json` 시 최종 잡 스냅샷 JSON 출력(스크립팅으로 프로비저닝 자동화 가능). chat은 제외(대화형 전용)

B) **조회형만** — 잡 명령은 사람 출력 고정

C) Other (please describe after [Answer]: tag below)

[Answer]: A
d