# Requirements Clarification Questions — Orphan Gateway 프로세스 방지

아래 3개 질문에 `[Answer]:` 뒤에 알파벳으로 답해 주세요. 각 질문에 추천안(Recommended)을
표시해 두었습니다. 다 되면 알려주시면 Plan 으로 넘어갑니다.

## Question 1
remove 시 `<profile>/gateway.pid` 에 적힌 PID 를 신호로 종료하는데, stale pidfile 의 PID 가
그 사이 **무관한 다른 프로세스로 재활용**되었을 수 있습니다. 이를 피하기 위한 신원 검증
강도를 얼마나 엄격하게 할까요?

A) 엄격 — `/proc/<pid>` 의 start_time 이 pidfile 에 기록된 `start_time` 과 일치하고 **AND**
   cmdline 이 이 프로파일의 gateway(`-p <profile> gateway`)를 가리킬 때만 신호. PID 재활용에
   가장 안전. **(Recommended)**

B) 중간 — cmdline 매칭만(`-p <profile> gateway` / 프로파일명 포함) 검증.

C) 시작시각만 — 기록된 `start_time` 일치만 검증.

D) 검증 없음 — pidfile 에 적힌 PID 를 그대로 종료(가장 단순, 재활용 위험).

X) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 2
gateway 종료를 **확신할 수 없는** 예외 상황(SIGKILL 후에도 살아있음, pidfile 손상/판독 불가,
시그널 권한 오류 등)에서 remove job 은 어떻게 동작해야 하나요?

A) 경고 로그를 남기고 remove 를 계속 진행(레지스트리 제거로 가시성상 삭제는 완료). 기존
   `profile_delete` 실패 처리 철학과 정합 — "가시성 우선, 잔여물은 리컨사일러가 계속 표면화".
   **(Recommended)**

B) remove job 을 hard-fail 시켜 사용자가 개입하도록 강제.

X) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 3
이번 변경 범위를 어디까지 할까요? remove 경로 수정 외에, **리컨사일러**도 orphan 을 감지하면
살아있는 gateway 를 능동적으로 종료(reap)하도록 할까요? (데몬 크래시 등 remove 를 거치지 않고
gateway 가 고아가 되는 경로까지 방어)

A) remove 경로만 수정(최소 범위). 리컨사일러는 지금처럼 감지/알럿만 유지. **(Recommended)**

B) 리컨사일러도 능동 reap — orphan profile 에 살아있는 매칭 gateway 가 있으면 삭제 전에
   종료. 방어는 강해지지만 리컨사일러가 프로세스를 죽이는 부작용/위험 추가.

X) Other (please describe after [Answer]: tag below)

[Answer]: A + 사용자가 UI 상에서 해당 얼럿에 대해 직접 상태를 정상화 시킬 수 있는 onclick 버튼 추가.