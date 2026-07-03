# U4 Web UI — NFR Requirements Plan

**Date**: 2026-07-03
**Unit**: U4 Web UI (C9 — `web/` SPA)
**입력**: U4 functional-design 4종 (APPROVED), 프로젝트 NFR N1~N10, Security/Resiliency/PBT 확장(전부 활성), U1~U3 tech-stack-decisions (Python 측: uv/pydantic/fastapi/httpx/typer/rich — SPA 스택은 미결)
**목적**: SPA 스택·품질 목표·테스트 전략 확정. FD에서 식별된 PU4-1~7을 실행할 PBT 프레임워크 선정(PBT-09) 포함.

## Plan Steps

- [x] Step 1: 스택 질문 답변 수집·분석 (Q1=A React, Q2=A 내장 상태, Q3=B Tailwind, Q4=A Playwright, Q5=A 자동 테마 — 모호성 없음)
- [x] Step 2: `nfr-requirements.md` — 성능/신뢰성/보안/유지보수성 목표 수치화, 확장(Security/Resiliency/PBT) 적용 매트릭스
- [x] Step 3: `tech-stack-decisions.md` — 프레임워크/빌드/테스트/스타일 확정 + 근거, 의존성 목록(고정 버전 정책), Node 툴체인의 dev-only 경계
- [ ] Step 4: 완료 메시지 제시 및 승인 대기

## 사전 결정 (질문 불필요 — 근거 명시)

- **TypeScript strict 필수** — Python 측 mypy --strict와 동일 기조 (N7). `any` 금지 계열 lint 동반
- **PBT 프레임워크 = fast-check** (PBT-09) — TS 생태계 사실상 유일 성숙 선택지. PU4-1~7 전부 순수 함수 대상으로 설계되어 있어 DOM 불요
- **단위/속성 테스트 러너 = Vitest** — Vite 계열 표준, fast-check 통합 자연스러움 (Q1에서 어떤 프레임워크를 골라도 빌드는 Vite 계열이므로 중립)
- **번들 자급** — 외부 CDN/폰트/런타임 로드 금지는 이미 규칙(W6/N2). 모든 자산은 빌드 산출물에 포함
- **배포 형태** — 빌드 산출물을 `caduceus/web_dist/`에 동봉(units 결정). **Node는 개발·CI 전용** — 최종 사용자 설치(N8)는 Python 패키지만으로 완결, 런타임 Node 의존 0
- **브라우저 지원** — 에버그린(최신 Chrome/Firefox/Safari/Edge)만. 로컬 개발자 도구이므로 레거시 폴리필 미도입 (P4)
- **버전 고정** — package.json 정확 버전 + lockfile 커밋 (SECURITY-10, R8과 정합)

---

# NFR 질문 — U4

아래 각 질문의 `[Answer]:` 태그에 선택지 문자를 기입해 주세요.

## Question 1: SPA 프레임워크

FD의 규모(페이지 4축, 컴포넌트 ~30개, WS 리듀서 중심 상태)와 P4(작은 표면적·유지보수성)를 기준으로:

A) **React 18 + TypeScript + Vite (권장)** — 생태계·문서·인력 풀 최대, 함수형 컴포넌트+훅으로 FD의 리듀서 모델과 자연 정합. 번들은 다소 큼(~45KB gzip 코어)이나 로컬 도구엔 무해

B) **Svelte 5 + TypeScript + Vite** — 번들 최소·보일러플레이트 최소, 반응성 내장으로 상태관리 라이브러리 불요. 생태계는 React 대비 작음

C) **Preact + TypeScript + Vite** — React API 호환 + 소형(~4KB). 미세한 호환성 리스크

D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 2: 상태관리 접근 (Q1=A/C인 경우 특히)

FD의 상태 모델은 "WS 이벤트 → 순수 리듀서 → 전역 상태 + REST 재조회 정합"입니다.

A) **내장 기능만 (권장)** — 프레임워크 내장 상태(예: React useReducer+Context, Svelte stores)로 구현. 외부 상태관리 의존 0 (P4). PU4-3 리듀서는 프레임워크 무관 순수 TS 모듈로 분리

B) **경량 스토어 채용** — zustand(React)/nanostores 등 1개 채용. 구독 최적화·devtools 이점, 의존 +1

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 3: 스타일링

W6(외부 리소스 금지) 하에서 전부 빌드타임 자급이 전제입니다.

A) **수제 CSS + 디자인 토큰 (권장)** — CSS 변수 기반 토큰(색/간격/타이포) + 컴포넌트별 CSS. 런타임/빌드 의존 0, 완전 통제. 작성량은 다소 증가

B) **Tailwind CSS** — 빌드타임 유틸리티, 런타임 의존 0. 클래스 밀도 높은 마크업, 빌드 체인 +1

C) **경량 컴포넌트 라이브러리** — (프레임워크 종속) 완성 컴포넌트 즉시 사용, 의존·번들 증가 + 커스텀 제약

D) Other (please describe after [Answer]: tag below)

[Answer]: B

## Question 4: 브라우저 E2E 테스트

U4 완료 기준은 "F11 플로우 전부 브라우저 E2E (loopback)"입니다 (unit-of-work.md).

A) **Playwright (권장)** — 실 브라우저(chromium)로 핵심 플로우 E2E: 토큰 게이트→에이전트 생성(잡 진행률)→start/stop→설정 편집→chat 스트리밍/stop/approval→gateway 핫스왑→삭제. 페이크 hermes(U2/U3 테스트 인프라 재사용) 위에서 실행. dev 의존 +1(무거움)이나 완료 기준 직접 충족

B) **컴포넌트 테스트까지만** — Vitest+jsdom로 컴포넌트/로직 검증, 브라우저 E2E는 수동 체크리스트로 대체 (완료 기준 완화 — 승인 필요)

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 5: 외관(테마) 기본

A) **다크/라이트 자동 + 수동 토글 (권장)** — `prefers-color-scheme` 기본 + 토글(UiPrefs 저장). 디자인 토큰이 이중 팔레트 전제

B) **단일 테마(다크 고정)** — 개발자 도구 관례, 구현 최소

C) **단일 테마(라이트 고정)**

D) Other (please describe after [Answer]: tag below)

[Answer]: A
