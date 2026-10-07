# j-auth 설계 결정

j-auth 최소 구현에 필요한 설계 결정을 정리한다. 제품군 공통 기준은 `j-groupware/docs/architecture.md`를 따르고, 이 문서는 그 위에서 j-auth가 정한 내용만 적는다. 각 결정은 PMT project `3dbae127-2180-4787-863f-037421a21257`에 같은 번호의 `결정 N` 레코드로 기록되어 있다.

결정일: 2026-10-06 (7장은 2026-10-07)

## 1. 테넌트와 realm

### 결정 3. 고객 분리 방식
- **결정:** 고객(tenant)마다 Keycloak realm을 하나씩 둔다. 운영사 realm 1개 + 고객별 realm.
- **이유:** 분리가 강하고 최소 구현 단계에서 이해·검증이 쉽다. architecture.md 기준안과 같다.

### 결정 4. tenant → realm 매핑
- **결정:** j-auth가 tenant ID ↔ realm 이름 매핑 표를 관리한다. 표에 없는 tenant는 거절한다. 운영사 직원은 tenant 예약어 `operator`로 로그인한다.
- **이유:** 고객 이름이 바뀌어도 realm을 유지하고, 미등록 tenant를 입력 단계에서 막는다.

## 2. 역할

### 결정 5. 역할 모델
- **결정:**
  - 사람의 신분은 realm role, 기능 권한은 client role로 둔다.
  - 이름 규칙은 `대상:동작`, 소문자, 콜론 구분. 예: `operator:admin`, `tenant:admin`, `tenant:member`, `board:read`, `board:write`.
  - 기능 권한도 Keycloak에 저장하고 j-auth가 반환한다.
  - 복합 role은 펼친 최종 목록(effective roles)으로 반환한다.
  - 권한은 사람마다 직접 부여한다. 그룹은 쓰지 않는다.
  - Keycloak 기본 role(`default-roles-*`, `offline_access`, `uma_authorization` 등)은 응답에서 걸러내고, 이름 규칙에 맞는 role만 반환한다.
- **이유:** 모든 서비스가 j-auth 응답만 보고 기능 노출을 결정한다(architecture.md). 펼친 목록이면 각 서비스는 포함 여부만 확인하면 된다. 직접 부여는 최소 구현을 단순하게 한다.

## 3. 로그인 API

### 결정 6. 로그인 응답의 토큰
- **결정:** 로그인 성공 응답에 `ok`, `roles`와 함께 Keycloak access token을 반환한다. 각 서비스는 Keycloak 공개키로 토큰 서명을 검증한다. 구체 필드명은 `packages/contracts`에서 확정한다.
- **이유:** 로그인 다음 요청에서 사용자를 증명할 수단이 필요하다. 이후 OIDC Authorization Code로 옮길 때도 같은 토큰 검증 방식을 쓴다.

### 결정 7. 실패 구분
- **결정:**
  1. 계정 없음과 비밀번호 틀림은 같은 `{ok:false}`로 응답한다.
  2. Keycloak 장애는 별도 오류(예: HTTP 503)로 응답한다.
  3. Keycloak brute force detection을 켠다.
- **이유:** 계정 열거 공격을 막고, 사용자 오류와 시스템 장애를 나누고, 비밀번호 대입 공격을 막는다.

### 결정 13. contracts 위치
- **결정:** 로그인 요청·응답 계약(TypeBox 스키마, DTO, 오류 코드)은 j-auth 저장소의 `packages/contracts`에 둔다.
- **이유:** j-auth가 계약을 독립적으로 관리한다.

## 4. Keycloak 구성

### 결정 8. Keycloak 클라이언트와 비밀값
- **결정:**
  - j-auth는 confidential client(client secret 사용)로 등록하고 Direct Access Grants를 켠다.
  - client secret은 로컬 개발에서는 Git에서 제외된 `.env`, VM에서는 소유자만 읽을 수 있는 env 파일(systemd `EnvironmentFile`)에 둔다.
  - realm별 secret은 `KC_SECRET_<realm>` 이름 규칙으로 구분한다.
- **이유:** 서버 측 앱이라 secret을 보관할 수 있다. 저장소와 로그에 비밀값을 남기지 않는다.

### 결정 9. Keycloak DB와 기동
- **결정:** 처음부터 Docker Compose로 Keycloak + PostgreSQL을 함께 띄운다. Keycloak 이미지는 정확한 버전으로 고정한다.
- **이유:** 운영과 같은 구조로 시작해 dev 모드(H2)에서 옮기는 작업을 없앤다. architecture.md DB 기준과 같다.

### 결정 10. realm 구성 관리
- **결정:** realm, 역할, client, 테스트 계정을 realm JSON 파일로 저장소에 두고 Keycloak 시작 시 import한다. 실제 비밀값은 파일에 넣지 않는다.
- **이유:** 설정을 어디서나 똑같이 재현하고 변경 이력을 Git에 남긴다.

## 5. 검증과 배포

### 결정 11. 테스트 방식
- **결정:** Vitest와 실제 Keycloak(Docker Compose) 통합 테스트로 완료 기준을 증명한다. 최소 케이스:
  1. 관리자 로그인 성공 + 관리자 역할
  2. 하위 회원 로그인 성공 + 하위 회원 역할만
  3. 비밀번호 틀림 → `{ok:false}`
  4. 없는 계정 → 3번과 같은 응답
  5. 미등록 tenant 거절
  6. Keycloak 장애 → 별도 오류
- **이유:** 실제 Keycloak과 맞는지 증명한다. j-messenger와 같은 테스트 도구를 쓴다.

### 결정 12. 배포와 접근
- **결정:**
  - 1차로 로컬에서 완료한 뒤, Hyper-V VM을 만들어 같은 구성으로 생성·검증한다.
  - HTTPS는 로컬 인증서를 생성해 사용한다.
  - 포트는 비표준 임의 값을 기본으로 하되, 실제 서비스 시 설정으로 바꿀 수 있게 한다.
  - Keycloak 관리 콘솔은 로컬에서만 접근할 수 있게 한다.
- **이유:** 단계적으로 검증하고, 비밀번호가 오가는 경로를 암호화하고, 관리 화면이 외부에 노출되지 않게 한다.

## 6. 작업 구성

결정 0(PMT 계층과 Item 구성)은 AI에 위임했다. PMT 계층은 environment `j-groupware-suite` → repository `j-auth` → project `j-auth`이다. Item은 앞 단계가 끝나야 다음 단계를 시작한다. 7장의 결정 14~20을 반영해 I6을 추가하고 I1~I5의 완료 기준을 보강했다. 8장의 결정 21·22와 9장의 결정 23에 따라 I2·I3·I4·I6의 완료 기준을 다시 보강했다. 10장의 결정 24·25에 따라 I2·I3·I4·I6을 보강하고 I7을 추가했다(PMT 반영 대기). 진행 순서는 I1 → I2 → I3 → I4 → I6 → I7 → I5이다.

| 순서 | Item | 완료 기준 요약 | 선행 |
| --- | --- | --- | --- |
| I1 | Keycloak 실행 환경 | Compose로 Keycloak + PostgreSQL 기동, 버전 고정, 로컬 HTTPS, 포트 설정 가능, 관리 콘솔 로컬 전용, 비밀값은 Git 제외 env에만, `KC_HOSTNAME` 고정으로 iss 일정(결정 19) | - |
| I2 | realm 구성 | 운영사 realm과 샘플 고객 realm 3개 import(결정 17, sample-a·b는 전 서비스 가입, sample-c는 미가입), 역할 이름 규칙, 서비스별 client(`j-groupware`, `j-messenger`, `j-customer-auth-db`, `j-mail`, `j-approval`, `j-console`)의 기능 role과 묶음 role(결정 16·21·23·24·25), confidential client + Direct Access Grants, `j-auth` client scope 제한(fullScopeAllowed=false), audience·`tenant` claim mapper(결정 19·21·23·24), 토큰·세션 수명(access 5분, 유휴 30분, 최대 8시간, 결정 22), realm별 `j-auth-admin`(`manage-users`+`view-clients`, 결정 15)과 `j-auth-provisioner`(결정 25), brute force 방어, 테스트 계정(결정 17·23·24), 비밀번호·secret은 env placeholder로만 | I1 |
| I3 | 로그인 API | contracts를 `@j-auth/contracts` 패키지로 구성하고 `npm pack` 가능(결정 18), tenant 매핑 표, `operator` 예약어, 성공 시 effective roles + access·refresh token + 만료 초 + `tenant`, `POST /auth/refresh`·`POST /auth/logout`(결정 22), 동일 실패 응답, 장애 시 별도 오류, 토큰 검증 기준·서비스별 aud 상수·서비스 카탈로그 상수 제공(결정 19·25), secret은 env에서 읽음 | I2 |
| I4 | 통합 테스트 | 결정 11의 6개 케이스, 결정 17·19의 추가 케이스(기대 roles·aud는 결정 24·25 기준, sample-c는 `j-groupware` aud와 기본 role만), `a-mail`·`a-member`의 `mail:read` 보유 여부, 결재 테스트 계정의 `approval:use` 보유 여부, 결정 22의 갱신·로그아웃 케이스 통과 | I3 |
| I6 | 회원 관리 API | 결정 14·15의 API와 검사, 부여 가능 role = 서비스 카탈로그의 부여 가능 role ∩ 그 tenant가 가입한 서비스(결정 25), `GET /auth/members/grantable-roles`, contracts 반영, 실제 Keycloak 대상 회원 관리 테스트(guest·`mail:read`·`approval:use`·`org:manage` 부여·회수, 허용 목록 밖 role 거절, 미가입 서비스 role 거절 포함) 통과 | I4 |
| I7 | 서비스 가입 API | 결정 25의 활성화·해제·조회 API(운영사 `customer:write` 토큰), realm별 `j-auth-provisioner` 최소 role을 실제 호출로 확인해 기록, 멱등, contracts 반영, sample-c 대상 활성화 → 로그인 roles·aud 반영 → 해제 → 제거 테스트(테스트 후 원상복구) 통과 | I6 |
| I5 | Hyper-V VM 검증 | VM 생성, 같은 Compose·realm import, VM HTTPS, Nginx 경로 허용 목록(결정 20), 관리 콘솔·token 엔드포인트 외부 비노출, 고객 VM에서 JWKS·j-auth API 접근, VM 대상 통합 테스트(I4·I6·I7) 통과 | I7 |

## 7. j-groupware 변경 요청 반영

j-groupware `docs/decisions.md`의 "j-auth에 넘길 변경 요청"(현재 8장) 7건을 반영한다. 기능 role 위치(결정 16), tenant 정보(결정 19), VM 노출 방식(결정 20), 관리 자격(결정 15)은 사용자가 권고안을 선택했다. 나머지 세부는 권고안으로 위임받았다.

2026-10-07 갱신 1: j-groupware 결정 15·16(j-messenger 연결)에 따라 `messenger:use`, `j-messenger` client, 메신저 테스트 계정을 결정 14·16·17·19에 반영했다.

2026-10-07 갱신 2: 결정 15의 최소 role을 임시 Keycloak 26.8.0(dev 모드, 기본 권한 모델)에서 실제 호출로 확인해 고정했다.

### 결정 14. 회원 관리 API
- **결정:**
  - j-auth에 고객 tenant 전용 회원 관리 API를 추가한다. 경로 초안은 다음과 같고, 필드명은 contracts에서 확정한다.
    - `GET /auth/members`: 호출자 tenant의 회원 목록(id, username, 활성 여부, 결정 5 규칙으로 걸러낸 effective roles)
    - `POST /auth/members`: 회원 추가. username, 초기 비밀번호, 선택 role을 받는다. 비밀번호는 영구 비밀번호(`temporary: false`)로 설정하고 required action을 걸지 않는다.
    - `PUT /auth/members/{id}/roles/{role}`: 기능 권한 부여
    - `DELETE /auth/members/{id}/roles/{role}`: 기능 권한 회수
  - 호출자는 `Authorization: Bearer <access token>`을 붙인다. j-auth는 결정 19 기준으로 토큰을 검증한다.
  - tenant는 토큰의 `tenant` claim에서만 정한다. 요청 경로나 본문으로 tenant를 받지 않는다. 대상 회원은 그 tenant의 realm 안에서만 찾는다. 따라서 다른 tenant의 회원은 "없음"으로 처리된다.
  - 호출자의 effective roles에 `member:manage`가 없으면 거절한다.
  - 부여·회수할 수 있는 role은 서비스 카탈로그(결정 25)의 부여 가능 role 가운데 그 tenant가 가입한 서비스의 것뿐이다. 전 서비스에 가입한 tenant 기준으로 `board:read`, `board:write`, `org:manage`, `messenger:use`, `guest:read`, `guest:write`, `mail:read`, `approval:use`다(guest는 결정 21, mail은 결정 23, `approval:use`·`org:manage`는 결정 24에서 추가).
    - `GET /auth/members/grantable-roles`: 호출자 tenant의 현재 부여 가능 role 목록을 돌려준다. `member:manage`가 필요하다. j-groupware 회원 관리 화면이 이 목록으로 체크박스를 그린다. 신분 role, `member:manage`, realm-management role은 이 API로 바꿀 수 없다. Keycloak은 service account가 realm role과 자기가 가진 관리 role도 부여하게 허용하므로(결정 15), 이 허용 목록이 실제 방어선이다.
  - 회수는 직접 부여한 role만 지운다. 묶음 role(`tenant:admin`)로 받은 권한은 남는다.
  - 운영사 tenant(`operator`) 토큰은 이 API를 쓸 수 없다.
  - 응답 구분: 토큰 무효 401, 권한 없음·부여 불가 role 403, 대상 없음 404, username 중복 409, Keycloak 장애 503.
  - 권한 변경 뒤 세션 정리는 호출한 서비스가 한다(j-groupware 결정 2). j-auth는 Keycloak 세션을 건드리지 않는다.
- **이유:** j-groupware 결정 3에 따라 Keycloak 관리 열쇠를 j-auth 한 곳에만 둔다. tenant를 서명된 토큰에서만 가져오면 다른 tenant를 조작할 경로가 없다. ROPC 로그인은 required action이 걸린 계정을 실패시키므로 영구 비밀번호를 쓴다.

### 결정 15. 회원 관리용 Keycloak 자격
- **결정:**
  - 고객 realm마다 service account 전용 confidential client `j-auth-admin`을 둔다. Standard Flow와 Direct Access Grants는 끈다.
  - service account에는 realm-management의 `manage-users`와 `view-clients` 두 role만 준다.
  - secret은 결정 8과 같은 방식으로 env에만 두고, `KC_ADMIN_SECRET_<realm>` 이름 규칙을 쓴다.
  - 운영사 realm에는 `j-auth-admin`을 두지 않는다.
  - 로그인용 `j-auth` client는 `fullScopeAllowed=false`로 두고, scope mapping에 신분 realm role과 서비스 client의 기능 role만 넣는다. 묶음 role의 하위 role도 scope에 있어야 토큰에 들어가므로 기능 role을 하나씩 모두 넣는다.
  - 고객 realm의 confidential client는 `j-auth`, `j-auth-admin`, `j-auth-provisioner`(결정 25에서 추가)만 둔다. 서비스 client(`j-groupware`, `j-messenger`, `j-customer-auth-db`, `j-mail`, `j-approval`)는 흐름이 모두 꺼진 role 보관용이라 secret을 쓰지 않는다.
- **확인 결과 (Keycloak 26.8.0, 기본 권한 모델):**

  | 확인 항목 | 결과 |
  | --- | --- |
  | 회원 목록·추가·client role 조회·부여·회수·effective role 조회를 모두 통과하는 최소 조합 | `manage-users` + `view-clients` 하나뿐 |
  | `query-clients`만으로 client 찾기 | 200이지만 빈 목록이라 client UUID를 얻지 못함 |
  | `view-clients`로 client 조회 | 응답에 그 realm의 client secret이 들어 있음 |
  | service account가 갖지 않은 관리 role(`realm-admin`, `manage-clients`, `manage-realm`) 부여 | 403 |
  | service account가 가진 관리 role(`manage-users`, `view-clients`)과 realm role(`tenant:admin`) 부여 | 허용(204) |
  | 관리 role이 붙은 사용자가 `j-auth` client(fullScopeAllowed=true)로 받은 토큰으로 Admin API 호출 | 200 |
  | 같은 조건에서 fullScopeAllowed=false | 토큰에 관리 role이 없어 403 |
  | ROPC 로그인: 영구 비밀번호 / 임시 비밀번호 | 200 / 400 |

- **알려진 한계:** `view-clients` 때문에 `j-auth-admin`이 같은 realm의 client secret을 읽을 수 있다. 위 규칙대로 그 realm의 confidential client가 j-auth 자신의 것뿐이면 새로 노출되는 비밀값은 없다. 결정 25의 `j-auth-provisioner`도 j-auth 자신의 client라 이 조건은 유지된다. 다만 `j-auth-admin`이 provisioner secret을 읽을 수 있으므로 두 자격의 분리는 "API 경로 분리"이지 비밀값 격리는 아니다. 비밀값 격리는 fine-grained admin permissions v2 backlog에서 함께 다룬다. 부여 가능 role을 Keycloak에서 직접 제한하는 fine-grained admin permissions v2는 이후 범위(backlog)로 둔다.
- **이유:** 로그인용 `j-auth` client의 secret이 새어도 회원 관리 권한은 넘어가지 않는다. 자격이 realm 단위라 한 tenant의 자격으로 다른 tenant를 바꿀 수 없다. Keycloak이 관리 role 재부여를 허용하므로 j-auth 허용 목록(결정 14), scope 제한, `/admin` 차단(결정 20)을 겹쳐 둔다.

### 결정 16. 기능 role 위치와 권한 이름
- **결정:**
  - 기능 role은 그 기능을 쓰는 서비스 이름의 client에 둔다. 이 client는 role만 담고 로그인 흐름은 모두 끈다.
    - 고객 realm: client `j-groupware`에 `board:read`, `board:write`, `member:manage`, `org:manage`(결정 24에서 추가)
    - 고객 realm: client `j-messenger`에 `messenger:use`
    - 고객 realm: client `j-customer-auth-db`에 `guest:read`, `guest:write`(결정 21에서 추가)
    - 고객 realm: client `j-mail`에 `mail:read`(결정 23에서 추가)
    - 고객 realm: client `j-approval`에 `approval:use`(결정 24에서 추가)
    - `j-groupware` 외의 서비스 client는 그 서비스에 가입한 고객 realm에만 있다(결정 25).
    - 운영사 realm: client `j-console`에 `customer:read`, `customer:write`
  - 묶음 role은 realm role로 둔다.
    - `tenant:admin` = `j-groupware` 기능 role 전체 + 가입한 서비스의 기능 role 전체(결정 25). 전 서비스 가입 기준으로 `board:read` + `board:write` + `member:manage` + `org:manage` + `messenger:use` + `guest:read` + `guest:write` + `mail:read` + `approval:use`
    - `operator:admin` = `customer:read` + `customer:write`
    - `tenant:member`는 기능 role을 포함하지 않는다. 기능 권한은 회원 관리 API로 직접 부여한다.
  - 응답의 `roles`는 client 구분 없이 이름만 펼쳐서 반환한다(결정 5). 그래서 서로 다른 client에 같은 role 이름을 두지 않는다. `대상:` 접두어를 서비스 사이에서 겹치지 않게 정한다.
  - `member:manage`는 j-auth가 검사하지만 j-groupware 기능 묶음에 속하므로 `j-groupware` client에 둔다.
- **이유:** 서비스가 늘어도 role 소유가 client 단위로 나뉜다. client별 audience를 줄 수 있어 토큰 검증 기준(결정 19)과 맞는다.

### 결정 17. 샘플 realm과 테스트 계정
- **결정:**
  - realm은 4개다(sample-c는 결정 25에서 추가). tenant ID와 realm 이름을 일부러 다르게 해서 매핑 표(결정 4)도 함께 검증한다. sample-a·sample-b는 모든 서비스에 가입하고, sample-c는 어떤 서비스에도 가입하지 않는다(j-groupware만).

    | tenant ID | realm | 계정 | role |
    | --- | --- | --- | --- |
    | `operator` | `operator` | `op-admin` | `operator:admin` |
    | `sample-a` | `tenant-sample-a` | `a-admin` | `tenant:admin` |
    | `sample-a` | `tenant-sample-a` | `a-member` | `tenant:member` (기능 role 없음) |
    | `sample-a` | `tenant-sample-a` | `a-msg1` | `tenant:member` + `messenger:use` |
    | `sample-a` | `tenant-sample-a` | `a-msg2` | `tenant:member` + `messenger:use` |
    | `sample-a` | `tenant-sample-a` | `a-mail` | `tenant:member` + `mail:read` (결정 23에서 추가) |
    | `sample-a` | `tenant-sample-a` | `a-appr1` | `tenant:member` + `approval:use` (결정 24, 작성자) |
    | `sample-a` | `tenant-sample-a` | `a-appr2` | `tenant:member` + `approval:use` (결정 24, 결재자 1단계) |
    | `sample-a` | `tenant-sample-a` | `a-appr3` | `tenant:member` + `approval:use` (결정 24, 결재자 2단계) |
    | `sample-a` | `tenant-sample-a` | `a-appr4` | `tenant:member` + `approval:use` (결정 24, 결재선 밖 회원) |
    | `sample-b` | `tenant-sample-b` | `b-admin` | `tenant:admin` |
    | `sample-b` | `tenant-sample-b` | `b-member` | `tenant:member` (기능 role 없음) |
    | `sample-c` | `tenant-sample-c` | `c-admin` | `tenant:admin` (가입 서비스 없음, 결정 25) |

  - `a-member`는 기능 role이 하나도 없는 하위 회원이다(board, `messenger:use`, guest, `mail:read`, `approval:use`, `org:manage` 모두 없음). 결재 테스트에서 "권한 없는 회원"으로도 쓴다. `a-appr1`~`a-appr4`는 j-approval 순차 결재 테스트용이다. `c-admin`은 미가입 서비스의 role·aud가 토큰에 없는지 확인하고, 서비스 가입 API(I7) 테스트 대상이 된다. `a-mail`은 j-mail 웹 UI 테스트(j-mail 결정 2)에서 `mail:read` 보유 회원으로 쓰고, 미보유 회원은 `a-member`를 쓴다. `a-msg1`·`a-msg2`는 j-messenger 연결 테스트(j-groupware 결정 16, M3)에서 같은 tenant 대화용으로 쓴다.
  - username은 realm 사이에서 겹치지 않게 한다. 그래야 다른 tenant로 로그인하는 시도가 확실히 실패한다.
  - 테스트 계정 비밀번호와 client secret은 realm JSON에 `${...}` 환경 변수 placeholder로만 쓰고, 실제 값은 Git 제외 env에 둔다(결정 8, 10).
  - 결정 11에 다음 통합 테스트 케이스를 더한다.
    7. `a-admin`이 tenant `sample-b`로 로그인 → `{ok:false}`
    8. 로그인 응답의 `tenant`와 토큰의 iss·azp·aud·`tenant` claim이 결정 19 기준과 같음
- **이유:** j-groupware 결정 6-1·13의 tenant 분리 시나리오와 "권한 없는 하위 회원" 시나리오를 실제 realm으로 검증한다.

### 결정 18. contracts 패키지
- **결정:**
  - `packages/contracts`를 `@j-auth/contracts` 패키지로 만든다. 첫 버전은 `0.1.0`이다.
  - 빌드 결과 `dist`(JS + 타입 선언)만 `files`에 넣는다. `npm pack`으로 `j-auth-contracts-<version>.tgz`를 만든다.
  - TypeBox는 정확한 버전으로 고정한 dependency로 둔다.
  - semver 규칙: 호환이 깨지는 변경은 major(1.0 이전에는 minor), 필드 추가는 minor, 수정은 patch다. 계약이 바뀌면 버전을 올리고 변경 내용을 `packages/contracts/CHANGELOG.md`에 적는다.
  - 로그인·회원 관리 계약과 토큰 검증 상수(결정 19)를 이 패키지에 둔다.
- **이유:** j-groupware 결정 8처럼 `.tgz`를 vendor에 커밋해 쓰는 방식을 지원한다. 버전이 고정되고 저장소를 형제 폴더로 받아 둘 필요가 없다.

### 결정 19. 토큰 검증 기준과 tenant 정보
- **결정:**
  - issuer는 `${KC_PUBLIC_URL}/realms/{realm}`이다. Keycloak `KC_HOSTNAME`을 공개 URL로 고정한다. j-auth가 loopback으로 호출해도 iss가 바뀌지 않게 backchannel만 동적으로 둔다(`hostname-backchannel-dynamic`).
  - JWKS 주소는 `{issuer}/protocol/openid-connect/certs`이다. 서명 알고리즘은 RS256만 허용한다. 서비스는 JWKS를 캐시하고 모르는 `kid`가 오면 다시 가져온다.
  - `azp`는 로그인 client인 `j-auth`여야 한다.
  - `aud`에는 그 토큰을 받는 서비스의 client ID가 들어 있어야 한다. 고객 realm 토큰의 aud는 `j-groupware` + 그 tenant가 가입한 서비스의 client ID다(결정 25). 전 서비스 가입 기준으로 `j-groupware`, `j-messenger`, `j-customer-auth-db`, `j-mail`, `j-approval`이다(`j-customer-auth-db`는 결정 21, `j-mail`은 결정 23, `j-approval`은 결정 24에서 추가). 운영사 realm 토큰의 aud는 `j-console`이다. 2026-10-07 j-groupware 결정 22 이후 고객 realm에서 `POST /auth/login`을 호출하는 서비스는 j-groupware 하나다. 다른 서비스는 j-groupware가 Bearer로 전달한 그 토큰을 받는다. 각 서비스는 자기 client ID가 aud에 있는지만 검사한다. 기능 role이 없는 회원의 토큰에도 aud가 들어가도록 `j-auth` client에 서비스마다 고정 audience mapper를 둔다. 서비스가 늘면 mapper를 하나씩 더한다.
  - realm마다 `j-auth` client에 고정 claim mapper를 두어 토큰에 `tenant` claim(tenant ID)을 넣는다. 서비스는 iss와 `tenant` claim이 둘 다 자기 설정의 허용 tenant와 맞는지 검사한다.
  - 로그인 성공 응답에 `tenant`(tenant ID)를 넣는다. realm 이름은 응답에 넣지 않는다.
  - 서비스가 판단할 때는 응답 본문이 아니라 서명된 토큰의 claim을 기준으로 한다.
  - j-auth 회원 관리 API(결정 14)는 iss가 매핑 표의 realm인지, 서명, `exp`, `azp`, `tenant` claim을 검사한다.
  - claim 이름, `azp` 값, 서비스별 aud 값, JWKS 경로 규칙은 contracts에 상수로 둔다.
- **이유:** 서명된 claim이라 위조할 수 없고, aud로 다른 서비스용 토큰을 재사용하는 것을 막는다. iss가 고정되어야 VM 밖에서도 검증 결과가 같다.

### 결정 20. VM 2대 구성의 Keycloak 노출 범위
- **결정:**
  - control plane VM에서 Keycloak과 j-auth는 `127.0.0.1`에만 bind한다. Keycloak은 I1의 로컬 HTTPS를 그대로 쓴다.
  - 같은 VM의 Nginx가 HTTPS로 다음 경로만 통과시킨다.
    - `GET /realms/{realm}/.well-known/openid-configuration`
    - `GET /realms/{realm}/protocol/openid-connect/certs`
    - j-auth API(`/auth/*`)
  - `/admin`, token 엔드포인트, account 콘솔, 그 밖의 Keycloak 경로는 모두 막는다. ROPC 호출은 j-auth가 loopback으로 한다.
  - `KC_HOSTNAME`은 Nginx의 공개 URL로 두고 `proxy-headers=xforwarded`를 쓴다. 관리 콘솔은 `hostname-admin`을 loopback 주소로 두고 SSH 터널로만 연다. management 포트(health·metrics)도 loopback에만 둔다.
  - VM 방화벽은 Nginx HTTPS 포트만 연다. 고객 VM은 로컬 CA를 신뢰하도록 설정한다(예: `NODE_EXTRA_CA_CERTS`).
  - 로컬 개발(I1~I6)에서는 Nginx 없이 loopback으로 쓴다. Nginx 구성은 I5에서 추가한다.
- **이유:** 고객 VM에 필요한 것은 공개키와 j-auth API뿐이다. 경로 단위로 막으면 관리 화면과 비밀번호 대입 경로가 밖으로 나가지 않는다(결정 7, 12).

## 8. j-customer-auth-db 변경 요청 반영

j-customer-auth-db `docs/decisions.md` 6장의 j-auth 대상 요청 R1~R3(PMT backlog `ffb03202…`, `e2864443…`, `0c90f2b0…`)을 반영한다. 근거는 j-customer-auth-db 결정 4·5·11이다. `tenant:admin`에 guest 권한을 넣는 것은 j-customer-auth-db 결정 11에서 사용자가 확정했다. 묶음 role의 `messenger:use` 유지, 토큰 갱신 방식, aud 방식은 이번에 사용자가 권고안을 선택했다. 이에 따라 결정 14·16·19를 갱신(PMT supersede)했고, 7장 본문에도 같은 내용을 반영했다.

결정일: 2026-10-07

### 결정 21. j-customer-auth-db 변경 요청 반영
- **결정:**
  - **R1 기능 role:**
    - 고객 realm마다 role 전용 client `j-customer-auth-db`를 두고 로그인 흐름은 모두 끈다(결정 16 방식).
    - 이 client에 `guest:read`(손님 조회)와 `guest:write`(손님 등록·수정·삭제, API 키 발급·회수)를 둔다.
    - `tenant:admin` = `board:read` + `board:write` + `member:manage` + `messenger:use` + `guest:read` + `guest:write` (당시 식. 현재 식은 결정 25 서비스 카탈로그로 계산)
      - R1이 보낸 식에는 `messenger:use`가 빠져 있다. 결정 16 rev2 이전의 식으로 보고 합집합으로 반영한다. j-customer-auth-db 결정 11의 식도 이에 맞게 고치도록 R1 레코드에 남긴다.
    - `tenant:member`는 바꾸지 않는다.
    - `j-auth` client scope mapping(결정 15)에 guest 두 role을 더한다.
  - **R2 aud:**
    - `j-auth` client에 고정 audience mapper `j-customer-auth-db`를 더한다. 고객 realm 토큰의 aud는 `j-groupware`, `j-messenger`, `j-customer-auth-db`이다.
    - 한 토큰이 세 서비스에서 모두 통한다. 권한은 각 서비스가 role로 따로 검사한다(결정 19 방식 유지).
    - contracts의 서비스별 aud 상수에 `j-customer-auth-db`를 더한다.
    - contracts는 아직 한 번도 pack하지 않았으므로 `0.1.0`에 포함하고 버전을 올리지 않는다. 첫 pack 이후 aud 상수를 추가하는 변경은 minor다(결정 18).
  - **R3 회원 관리 API:**
    - 부여·회수 가능 role에 `guest:read`, `guest:write`를 더한다(결정 14).
    - `GET /auth/members`의 roles에 guest 권한이 보인다.
  - **테스트 기대값:**
    - 결정 11 케이스 1(관리자 역할)의 기대 roles에 `messenger:use`, `guest:read`, `guest:write`가 들어간다.
    - 결정 17 케이스 8의 고객 realm 기대 aud는 `j-groupware`, `j-messenger`, `j-customer-auth-db`이다.
    - I6에 `a-admin`이 `a-member`에게 guest 권한을 부여하고 회수하는 케이스를 더한다. 새 테스트 계정은 만들지 않는다.
- **이유:** 결정 16·19의 방식(서비스별 role client, 고정 audience mapper)을 그대로 확장해 규칙이 하나로 유지된다. 손님 관리 권한 검사는 데이터를 가진 j-customer-auth-db에 남는다(j-customer-auth-db 결정 5).

### 결정 22. 토큰 갱신과 로그아웃
- **문제:**
  - j-groupware는 세션(최대 8시간)에 보관한 j-auth access token을 j-auth 회원 관리 API(결정 14)와 j-customer-auth-db 관리 API로 전달한다.
  - Keycloak access token 기본 수명이 5분이라, 로그인 5분 뒤부터 이 호출이 401로 실패한다.
- **결정:**
  - 로그인 성공 응답에 refresh token과 access·refresh token의 만료 초를 더한다. 필드명은 contracts에서 확정한다.
  - `POST /auth/refresh {tenant, refreshToken}`
    - j-auth가 그 realm의 `j-auth` client secret으로 Keycloak `refresh_token` grant를 호출한다.
    - 로그인 성공과 같은 형태로 응답한다: 새 access·refresh token, 갱신 시점 기준 effective roles, `tenant`.
    - 결과 토큰의 `tenant` claim이 요청한 tenant와 다르면 거절한다. 미등록 tenant도 거절한다.
    - refresh token이 만료·무효이거나 세션이 끝났으면 `{ok:false}`, Keycloak 장애는 503으로 응답한다(결정 7과 같은 구분).
  - `POST /auth/logout {tenant, refreshToken}`
    - Keycloak 세션을 끝낸다. 여러 번 호출해도 결과가 같다(멱등).
  - realm 설정
    - access token 5분, SSO Session Idle 30분, SSO Session Max 8시간으로 둔다. j-groupware 결정 2의 세션 기본값과 같고, 설정으로 바꿀 수 있다.
    - Revoke Refresh Token(재사용 금지)은 끈다. 같은 세션에서 동시에 갱신할 때 실패하지 않게 하기 위해서다. 켜는 것은 이후 범위로 둔다.
  - refresh token은 호출 서비스의 서버 세션에만 저장한다. 브라우저로 보내거나 로그에 남기지 않는다.
  - j-groupware 결정 2("access token은 로그인 순간에만 쓴다")를 바꾸는 요청을 j-groupware PMT backlog `55de09fb-b54e-4c99-be79-202167db17e5`로 넘겼다.
    - 내용: 토큰 전달 전 만료 30초 이내면 갱신, 갱신 실패 시 재로그인, 세션 삭제 시 logout
  - 2026-10-07: j-groupware는 이 방식을 최소 구현의 최종안으로 확정했다(j-groupware 결정 2). 이벤트 기반 무효화는 OIDC 전환 backlog다.
  - j-groupware 결정 22 이후 j-messenger·j-mail·j-approval도 j-groupware가 전달한 토큰을 받는다. 갱신은 j-groupware가 하므로 이 서비스들은 refresh를 호출하지 않는다.
- **이유:**
  - access token을 짧게 유지하면서 장시간 세션에서도 토큰을 전달할 수 있다.
  - 갱신할 때 권한이 새로 반영되고, logout으로 세션을 강제로 끝낼 수 있다.
  - access token 수명을 8시간으로 늘리는 방안은 유출 시 끊을 수 없어서 택하지 않았다.

## 9. j-mail 변경 요청 반영

j-mail `docs/decisions.md` 5장의 j-auth 대상 요청 1~3번을 반영한다. 근거는 j-mail 결정 2·5·6이고, 요청 Item은 j-mail PMT E6(`e76c1ce3-1acb-47c2-9a17-9a99d68f438e`)이다. j-customer-auth-db 요청(결정 21)은 이미 반영되어 있으므로, 그 위에 `mail:read`를 더한다. 이에 따라 결정 14·16·17·19를 갱신(PMT supersede)했고, 7장 본문에도 같은 내용을 반영했다. 테스트 계정 구성은 사용자가 권고안("`a-mail` 추가 + `a-member` 재사용")을 선택했다.

결정일: 2026-10-07

### 결정 23. j-mail 변경 요청 반영
- **결정:**
  - **기능 role:**
    - 고객 realm마다 role 전용 client `j-mail`을 두고 로그인 흐름은 모두 끈다(결정 16 방식).
    - 이 client에 `mail:read`(메일 웹 UI 열람)를 둔다.
    - `tenant:admin` = `board:read` + `board:write` + `member:manage` + `messenger:use` + `guest:read` + `guest:write` + `mail:read` (당시 식. 현재 식은 결정 25 서비스 카탈로그로 계산)
    - `tenant:member`는 바꾸지 않는다.
    - `j-auth` client scope mapping(결정 15)에 `mail:read`를 더한다.
  - **aud:**
    - `j-auth` client에 고정 audience mapper `j-mail`을 더한다.
    - 고객 realm 토큰의 aud는 `j-groupware`, `j-messenger`, `j-customer-auth-db`, `j-mail`이다. 운영사 realm은 `j-console`로 바뀌지 않는다.
    - contracts의 서비스별 aud 상수에 `j-mail`을 더한다.
    - contracts는 아직 한 번도 pack하지 않았으므로 `0.1.0`에 포함한다(결정 18). 첫 pack 이후라면 minor 변경이다.
  - **회원 관리 API:**
    - 부여·회수 가능 role에 `mail:read`를 더한다(결정 14).
  - **테스트 계정 (결정 17):**
    - `tenant-sample-a`에 `a-mail`(`tenant:member` + `mail:read`)을 추가한다.
    - `mail:read`가 없는 하위 회원은 기존 `a-member`를 쓴다.
    - 다른 tenant 확인에는 `tenant-sample-b`의 `b-admin`·`b-member`를 쓴다.
    - 결정 11 케이스 1의 관리자 기대 roles와 결정 17 케이스 8의 기대 aud에 `mail:read`·`j-mail`을 넣는다.
  - **토큰 갱신:**
    - (2026-10-07 갱신) j-mail은 자체 로그인·세션 없이 j-groupware가 전달한 Bearer 토큰을 요청마다 검증한다(j-groupware 결정 22). 갱신은 j-groupware가 하므로 j-mail은 결정 22를 직접 쓰지 않는다.
- **이유:**
  - 결정 16·19·21과 같은 방식이라 규칙이 하나로 유지된다.
  - 테스트 계정을 용도별로 나누면 메신저 테스트(`a-msg1`·`a-msg2`)와 메일 테스트가 서로의 기대 roles를 바꾸지 않는다.
  - 고정 계정이라 j-mail 테스트가 회원 관리 API(I6)를 기다리지 않아도 된다.

## 10. j-approval 요청과 서비스 가입 연동

결정일: 2026-10-07. j-approval `docs/decisions.md` 6장의 j-auth 대상 요청 R1~R3(PMT backlog `c1e2788e…`, `df820d52…`, `085152fb…`)과 j-groupware 결정 20(서비스 가입 모델)·22(화면 일원화)을 반영한다. 이에 따라 결정 14·16·17·19·22·23을 갱신했다(PMT supersede 대기). "가입 시 realm role까지 연동"은 사용자가 정했고, 나머지 세부는 권고안으로 위임받았다.

### 결정 24. j-approval 권한 반영
- **결정:**
  - **기능 role:**
    - 고객 realm에 role 전용 client `j-approval`을 두고 로그인 흐름은 모두 끈다(결정 16 방식). 이 client에 `approval:use`(결재 메뉴·상신·내 문서·결재함)를 둔다.
    - client `j-groupware`에 `org:manage`(조직도 편집)를 더한다.
    - 둘 다 `tenant:admin` 묶음과 `j-auth` client scope mapping에 넣는다. 단, `approval:use`는 j-approval에 가입한 tenant에만 있다(결정 25).
  - **aud:** `j-auth` client에 고정 audience mapper `j-approval`을 더하고, contracts의 서비스별 aud 상수에 `j-approval`을 더한다. contracts는 아직 pack하지 않았으므로 `0.1.0`에 포함한다(결정 18).
  - **회원 관리 API:** 부여 가능 role에 `approval:use`, `org:manage`를 더한다(결정 14).
  - **테스트 계정:** `a-appr1`(작성자), `a-appr2`·`a-appr3`(결재자), `a-appr4`(결재선 밖 회원)를 `tenant-sample-a`에 추가한다. 권한 없는 회원은 `a-member`, 다른 tenant는 `b-admin`·`b-member`를 쓴다(결정 17).
- **이유:** 결정 16·19·21·23과 같은 방식이다. 결재 처리 자격은 j-approval이 결재선으로 검사하므로 role은 메뉴 권한만 다룬다(j-approval 결정 3).
- **반영 상태:** j-approval R1~R3은 "반영됨(결정 24, Item: I2·I3·I4·I6 보강)"이다.

### 결정 25. 서비스 가입 연동
- **결정:**
  - **서비스 카탈로그:** contracts에 서비스 카탈로그 상수를 둔다. 서비스 ID, role client ID(= aud), 기능 role, 부여 가능 role을 담는다. `tenant:admin` 식, 부여 가능 role, aud 목록은 이 상수 하나에서 계산한다. 문서마다 식을 다시 적지 않는다.

    | 서비스 | 구분 | 기능 role | 부여 가능 role |
    | --- | --- | --- | --- |
    | `j-groupware` | 기본(항상) | `board:read`, `board:write`, `member:manage`, `org:manage` | `board:read`, `board:write`, `org:manage` |
    | `j-messenger` | 선택 | `messenger:use` | 같음 |
    | `j-mail` | 선택 | `mail:read` | 같음 |
    | `j-customer-auth-db` | 선택 | `guest:read`, `guest:write` | 같음 |
    | `j-approval` | 선택 | `approval:use` | 같음 |

    j-talk 등 새 서비스는 이 표에 한 줄을 더하는 것으로 시작한다(minor 변경).
  - **가입 API (운영사 전용):**
    - `GET /auth/tenants/{tenant}/services`: Keycloak 실제 상태 기준 가입 서비스 목록
    - `PUT /auth/tenants/{tenant}/services/{service}`: 활성화
    - `DELETE /auth/tenants/{tenant}/services/{service}`: 해제
    - 호출자는 운영사 realm 토큰(aud `j-console`)이고 `customer:write`가 있어야 한다. 고객 realm 토큰은 403이다. 기본 서비스 `j-groupware`의 해제와 카탈로그에 없는 서비스는 거절한다(400·404).
    - 둘 다 멱등이다. 중간에 실패하면 503으로 응답하고, 같은 요청을 다시 보내면 남은 단계를 마저 한다.
  - **활성화 단계:** 서비스 client(흐름 모두 끔)와 기능 role을 만들고, `tenant:admin` 묶음에 넣고, `j-auth` client scope mapping에 넣고, `j-auth` client에 그 서비스의 고정 audience mapper를 만든다.
  - **해제 단계:** audience mapper를 지우고, scope mapping과 `tenant:admin` 묶음에서 빼고, 서비스 client를 지운다. client를 지우면 회원에게 직접 부여한 그 서비스 role도 함께 사라진다. 다시 가입하면 권한은 처음부터 다시 부여한다.
  - **반영 시점:**
    - 활성화·해제는 이미 발급된 토큰에 바로 반영되지 않는다. 다음 갱신(결정 22, 최대 5분) 때 새 roles·aud가 들어간다.
    - 해제 직후 남은 토큰은 하위 서비스에서 aud 검사로 막히지 않을 수 있다. 하지만 서비스가 멈추므로(j-groupware 결정 20) 실제 접근은 없다.
  - **Keycloak 자격:**
    - 고객 realm마다 service account 전용 confidential client `j-auth-provisioner`를 둔다. 회원 관리용 `j-auth-admin`(결정 15)과 나눈다. 그래서 회원 관리 API 코드 경로에서는 client·mapper·묶음 role을 바꿀 수 없다. 단, `j-auth-admin`의 `view-clients`로 provisioner secret을 읽을 수 있으므로 비밀값 격리는 아니다(결정 15 알려진 한계).
    - 최소 realm-management role은 I7에서 실제 호출로 확인해 결정 15처럼 표로 기록한다. 후보는 `manage-clients` + `manage-realm` + `view-clients`다.
    - secret은 `KC_PROVISION_SECRET_<realm>`이고 env에만 둔다.
  - **원본과 동기화:** 가입 정보의 원본은 운영 콘솔 DB다(j-groupware 결정 20). j-auth의 조회 API는 Keycloak 실제 상태를 돌려주고, 콘솔은 둘이 다르면 "반영 실패"로 보여 준다.
  - **샘플 realm:** sample-a·sample-b는 realm JSON에 모든 선택 서비스를 활성화한 상태로 넣는다. sample-c는 기본 서비스만 넣는다(결정 17).
  - **새 고객 realm 생성:** realm 자체를 만드는 일은 기존 프로비저닝 backlog로 둔다.
- **이유:**
  - 미가입 서비스의 role과 aud가 토큰에 아예 없으므로, 메뉴·중계·하위 서비스 검사가 별도 설정 없이 닫힌다.
  - 카탈로그 상수 하나로 문서·코드의 식 중복을 없앤다.
  - 자격을 용도별로 나눠 실수로 회원 관리 경로에서 realm 구성을 바꾸는 일을 막는다.
