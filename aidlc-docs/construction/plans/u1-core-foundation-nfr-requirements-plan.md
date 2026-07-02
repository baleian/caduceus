# U1 Core Foundation — NFR Requirements Plan

**Date**: 2026-07-02

## Plan Steps

- [x] Step 1: 기술 스택 질문 답변 수집·분석 (Q1=A uv, Q2=A ruamel.yaml, Q3=A pydantic v2 — 모호성 없음)
- [x] Step 2: `nfr-requirements.md` — U1 NFR 확정 (성능·신뢰성·보안·유지보수성)
- [x] Step 3: `tech-stack-decisions.md` — 스택 확정 (PBT-09 Hypothesis 포함)
- [x] Step 4: 완료 메시지 제시 및 승인 대기

## 사전 확정 사항 (질문 불필요 — 근거 명시)

- **언어/버전**: Python ≥3.11 (AD-4)
- **PBT 프레임워크**: **Hypothesis** — PBT-09 권장표의 Python 표준, shrinking·seed 재현·custom strategy 충족. 실질적 대안 없음
- **테스트 러너**: pytest (+ pytest-asyncio) — Python 생태계 표준
- **가용성/규모 목표**: R5(N/A)·N10(상한 없음)·FD3(데몬 수명 종속) 기확정
- **보안**: S1~S4 규칙 기확정 (토큰 해시, .env 0600, 상수시간 비교)

---

# 기술 스택 질문 — U1 (프로젝트 전체 파급)

## Question 1: 패키징·의존성 관리 (N8)
빌드/의존성/배포 도구 체인은?

A) **uv + pyproject.toml** (권장) — lock 파일(SECURITY-10), 빠른 해석, `uv tool install caduceus`(pipx 호환) 배포, 버전 고정 롤백(R8)과 정합. hermes도 uv.lock 사용(생태계 정렬)

B) Poetry — 성숙하지만 도구 자체 무게, uv 대비 이점 없음

C) pip + requirements.txt — lock 관리 수동

D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 2: YAML 처리 라이브러리 (FD2 공존 규칙에 직결)
profile `config.yaml` 병합 쓰기(G1: 비관리 키 보존) 시 **사용자가 작성한 주석·포맷**을 어떻게 다룰까요?

A) **ruamel.yaml** (권장) — round-trip 파서로 주석·키 순서·포맷 보존. 사용자/hermes dashboard가 편집한 파일을 훼손하지 않음 (FD2 공존 철학과 일치). 의존성 1개 추가

B) PyYAML — 가볍지만 주석·포맷 소실 (병합 쓰기 때마다 사용자 주석 삭제됨)

C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 3: 데이터 모델·검증 라이브러리 (V1~V6 구현 방식)
도메인 타입(AgentSpec 등)과 검증 규칙의 구현 기반은?

A) **pydantic v2** (권장) — 선언적 검증(V1~V6), JSON 직렬화(registry round-trip), U2의 API 스키마(FastAPI 계열)와 재사용. Rust 코어로 성능 우수

B) dataclasses + 수동 검증 — 의존성 최소(P4 극대화), 대신 검증·직렬화 코드 직접 유지보수 및 U2에서 스키마 중복 정의

C) Other (please describe after [Answer]: tag below)

[Answer]: A
