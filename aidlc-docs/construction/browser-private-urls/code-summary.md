# Code Summary — 브라우저 로컬 접근 opt-in (`allow_private_urls`)

경량 사이클(사용자 합의: 명확·협소 범위). 결정: **per-agent opt-in, 기본 off**, `network_mode`와 동일 배선.

## 배경
`network_mode=host` fix로 터미널(curl)은 localhost:9292에 도달하지만, hermes **browser 툴은 SSRF 가드**(`tools/url_safety.py`)가 loopback/사설 주소를 기본 차단 → `{"error":"Blocked: URL targets a private or internal address"}`. 해제 토글은 `security.allow_private_urls`(config) / `HERMES_ALLOW_PRIVATE_URLS`(env), 기본 false. 클라우드 메타데이터(169.254.x)는 토글 무시하고 하드 차단.

## 변경 (backend)
| 파일 | 변경 |
|---|---|
| `caduceus/core/types.py` | `AgentSpec.allow_private_urls: bool = False` 필드 추가 |
| `caduceus/core/render.py` | `managed_config`에 `security: {allow_private_urls: spec.allow_private_urls}` 항상 렌더(토글 off도 명시 → drift로 회수) |
| `caduceus/cli/commands/agent.py` | `agent create --allow-private-urls` 플래그 + spec 반영 + `agent status` 표시행 |

## 변경 (web)
| 파일 | 변경 |
|---|---|
| `web/src/lib/types.ts` | `AgentRecord.spec.allow_private_urls: boolean` |
| `web/src/lib/forms.ts` | `AgentFormValues.allow_private_urls: boolean` |
| `web/src/pages/agents/AgentsPage.tsx` | `set` 제네릭 값타입화, EMPTY_FORM 기본 false, 제출 시 opt-in만 전송, 고급옵션에 체크박스 |
| `web/src/pages/agents/AgentDetailPage.tsx` | Runtime에 `private URLs: allowed/blocked` 표시 |
| `caduceus/web_dist/*` | `vite build` 재생성 |

## 생성 후 편집 (Settings 탭) — 승인 모드 패턴 미러링
생성 시 opt-in뿐 아니라 **에이전트 생성 후에도** web Settings 탭에서 토글 가능(재생성 불필요).
| 파일 | 변경 |
|---|---|
| `caduceus/control/api.py` | `GET/PUT /api/agents/{name}/allow-private-urls` (+`AllowPrivateUrlsUpdate`). PUT은 spec `model_copy` → `registry.replace` → `apply_managed_config` 재렌더(put_approvals와 동일). |
| `web/src/api/client.ts` | `getAllowPrivateUrls` / `putAllowPrivateUrls` |
| `web/src/pages/agents/SettingsTab.tsx` | 로드 시 값 취득 + `allowed/blocked` 토글 스위치(낙관적 갱신·실패 롤백) + 저장 시 **재시작 배너**(url_safety가 프로세스 캐시라 gateway 재시작 필요) |
반영엔 gateway 재시작 필요(승인 모드 편집과 동일 UX). `network_mode`는 컨테이너 재생성이 필요해 이번 범위 제외(읽기 전용 유지).

## 테스트
- `tests/property/strategies.py` `agent_specs()`에 `allow_private_urls=st.booleans()` (모든 render 속성이 두 값 커버).
- `tests/unit/test_render.py` security 렌더 단위테스트; `tests/property/test_render_properties.py` `test_p6`에 `security.allow_private_urls == spec.allow_private_urls` 단언.
- `web/tests/property/forms.test.ts` fc.record에 `allow_private_urls: fc.boolean()`.
- `tests/integration/test_daemon_asgi.py` GET/PUT `/allow-private-urls` 통합테스트(기본 false→config, opt-in→spec+config, 비-bool 422).

## 검증
- ruff clean · mypy(43) Success · pytest **496 passed, 4 deselected**.
- web typecheck clean · eslint clean · vitest **73** · **e2e 14/14** · build→web_dist 갱신.
- **실기 실증**: 렌더된 config(`security.allow_private_urls: true/false`)를 설치된 hermes `read_raw_config`가 읽어 `is_safe_url('http://localhost:9292/ui/')` = True/False로 토글됨 확인.

## 사용
`caduceus agent create <name> --allow-private-urls` (또는 웹 생성폼 체크박스). gateway 재시작 후 브라우저가 localhost/사설 주소 접근 가능. **보안**: 신뢰 못 할 프롬프트 다루는 에이전트엔 SSRF 표면 확대 주의(메타데이터 엔드포인트는 여전히 하드 차단).
