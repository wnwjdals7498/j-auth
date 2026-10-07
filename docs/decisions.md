# j-auth 설계 결정

j-auth만의 설계 결정을 적는다. 제품군 공통 결정은 [`j-groupware/docs/architecture.md`](https://github.com/wnwjdals7498/j-groupware/blob/main/docs/architecture.md)(이하 architecture.md)의 S 번호를 따르고 여기서는 링크만 한다. PMT는 통합 project `j-groupware-suite`의 분류 `j-auth`에 같은 번호로 기록한다(architecture.md S16).

정리일: 2026-10-07. 통합 정리에서 결정 번호를 다시 매겼다. 이전 번호는 끝의 대응 표를 본다.

관련 공통 결정: S3(권한 모델·서비스 카탈로그), S4(인증과 토큰 전달·서비스 키), S10(레지스트리), S12(테스트 계정), S13(배포), S14(해지).

## 1. 테넌트와 역할

### 결정 1. 고객 분리 방식
- **결정:** 고객(tenant)마다 Keycloak realm을 하나씩 둔다. 운영사 realm 1개 + 고객별 realm.
- **이유:** 분리가 강하고 최소 구현 단계에서 이해·검증이 쉽다.

### 결정 2. tenant → realm 매핑
- **결정:** j-auth가 tenant ID ↔ realm 이름 매핑 표를 관리한다. 표에 없는 tenant는 거절한다. 운영사 직원은 tenant 예약어 `operator`로 로그인한다.
- **이유:** 고객 이름이 바뀌어도 realm을 유지하고, 미등록 tenant를 입력 단계에서 막는다.

### 결정 3. 역할 모델
- **결정:**
  - 신분은 realm role, 기능 권한은 서비스 role client의 client role이다(architecture.md S3). 이름은 `대상:동작`, 소문자, 콜론 구분이다.
  - 권한은 사람마다 직접 부여한다. 그룹은 쓰지 않는다.
  - 응답의 roles는 복합 role을 펼친 effective roles다. client 구분 없이 이름만 반환하므로 서비스 사이에 같은 role 이름을 두지 않는다.
  - Keycloak 기본 role(`default-roles-*`, `offline_access`, `uma_authorization` 등)은 걸러내고 이름 규칙에 맞는 role만 반환한다.
  - **쓰기는 읽기를 포함한다:** `<대상>:write`를 같은 client의 `<대상>:read`를 포함하는 복합 client role로 만든다(대상: board, guest, talk, web). 회원 관리 API로 쓰기만 부여해도 effective roles에 읽기가 들어간다.
- **이유:** 서비스는 roles에 그 role이 있는지만 보면 된다. 쓰기·읽기 규칙이 화면이 아니라 Keycloak에서 지켜진다.

## 2. 로그인과 토큰

### 결정 4. 로그인 응답과 실패 구분
- **결정:**
  - `POST /auth/login {tenant, username, password}`에 성공하면 다음을 반환한다: `ok`, effective roles, access token, refresh token, 두 토큰의 만료 초, `tenant`. realm 이름은 반환하지 않는다. 필드명은 contracts에서 정한다.
  - 계정 없음과 비밀번호 틀림은 같은 `{ok:false}`다. Keycloak 장애는 503이다. Keycloak brute force detection을 켠다.
  - 고객 realm에서 이 API를 호출하는 서비스는 j-groupware 하나다(architecture.md S4).
- **이유:** 계정 열거와 비밀번호 대입을 막고, 사용자 오류와 시스템 장애를 나눈다.

### 결정 5. Keycloak client와 비밀값
- **결정:**
  - 로그인용 `j-auth`는 confidential client이고 Direct Access Grants를 켠다.
  - client secret은 로컬에서는 Git 제외 `.env`, VM에서는 소유자만 읽는 env 파일(systemd `EnvironmentFile`)에 둔다. 이름 규칙은 `KC_SECRET_<realm>`이다.
  - 고객 realm의 confidential client는 `j-auth`, `j-auth-admin`(결정 12), `j-auth-provisioner`(결정 14)뿐이다.
  - 서비스 role client는 흐름이 모두 꺼진 role 보관용이라 secret이 없다.
- **이유:** 서버 측 앱이라 secret을 보관할 수 있다. 저장소와 로그에 비밀값을 남기지 않는다.

### 결정 6. Keycloak DB와 기동
- **결정:** 처음부터 Docker Compose로 Keycloak + PostgreSQL을 함께 띄운다. Keycloak 이미지는 정확한 버전으로 고정한다.
- **이유:** dev 모드(H2)에서 옮기는 작업을 없앤다.

### 결정 7. realm 구성 관리
- **결정:** realm, role, client, 기본 테스트 계정을 realm JSON 파일로 저장소에 두고 Keycloak 시작 시 import한다. 실제 비밀값은 `${...}` placeholder로만 쓴다.
- **이유:** 어디서나 똑같이 재현하고 변경 이력을 Git에 남긴다.

### 결정 8. contracts 패키지
- **결정:**
  - `packages/contracts`를 `@j-auth/contracts`로 만든다. 첫 버전은 `0.1.0`이다.
  - 로컬 npm 레지스트리에 게시한다(architecture.md S10). `dist`(JS + 타입 선언)만 `files`에 넣는다.
  - 다음을 이 패키지에 둔다: 로그인·갱신·로그아웃·회원 관리·가입 계약, 토큰 검증 상수(결정 9), 서비스 카탈로그 상수(결정 13), 서비스 키 헤더 이름(결정 15). TypeBox는 정확한 버전으로 고정한다.
  - semver를 지킨다. 1.0 이전에는 호환이 깨지면 minor, 필드 추가도 minor, 수정은 patch다. `CHANGELOG.md`에 적는다.
- **이유:** j-auth가 계약을 독립적으로 관리하고, 다른 저장소는 정확한 버전으로 받는다.

### 결정 9. 토큰 검증 기준
- **결정:**
  - issuer는 `${KC_PUBLIC_URL}/realms/{realm}`이다. `KC_HOSTNAME`을 공개 URL로 고정하고 backchannel만 동적으로 둔다(`hostname-backchannel-dynamic`).
  - JWKS는 `{issuer}/protocol/openid-connect/certs`이고 RS256만 허용한다. 서비스는 JWKS를 캐시하고, 모르는 `kid`가 오면 다시 가져온다.
  - `azp`는 `j-auth`다.
  - `aud`에는 받는 서비스의 client ID가 있어야 한다. 고객 realm 토큰의 aud는 `j-groupware` + 그 tenant가 가입한 서비스의 client ID다(결정 13·14). 운영사 realm은 `j-console`이다.
  - 고정 audience mapper는 `j-auth` client에 서비스마다 둔다.
  - realm마다 고정 claim mapper로 `tenant` claim을 넣는다. 서비스는 iss와 `tenant`가 둘 다 허용 tenant와 맞는지 검사한다.
  - 판단은 응답 본문이 아니라 서명된 토큰 claim으로 한다. claim 이름, `azp`, aud, JWKS 경로 규칙은 contracts 상수로 둔다.
- **이유:** 서명된 claim이라 위조할 수 없고, aud가 가입 상태와 받는 서비스를 나타낸다.

### 결정 10. 토큰 갱신과 로그아웃
- **결정:**
  - `POST /auth/refresh {tenant, refreshToken}`:
    - 그 realm의 `j-auth` secret으로 Keycloak `refresh_token` grant를 호출한다.
    - 로그인과 같은 형태로 응답한다: 새 토큰, 갱신 시점 roles, `tenant`.
    - 결과 `tenant` claim이 요청과 다르거나 미등록 tenant면 거절한다. 만료·무효·세션 종료는 `{ok:false}`, Keycloak 장애는 503이다.
  - `POST /auth/logout {tenant, refreshToken}`: Keycloak 세션을 끝낸다. 멱등이다.
  - realm 설정은 access token 5분, SSO Session Idle 30분, SSO Session Max 8시간이다. 설정으로 바꿀 수 있다.
  - Revoke Refresh Token은 끈다. 동시 갱신이 실패하지 않게 하기 위해서다. 켜는 것은 이후 범위다.
  - refresh token은 호출 서비스의 서버 세션에만 둔다. 브라우저로 보내거나 로그에 남기지 않는다.
- **이유:** access token을 짧게 유지하면서 장시간 세션에서 토큰을 전달할 수 있다(architecture.md S4).

## 3. 관리 API

### 결정 11. 회원 관리 API
- **결정:**
  - 고객 tenant 전용 API다. 경로 초안은 아래와 같고, 필드명은 contracts에서 정한다.
    - `GET /auth/members`: 회원 목록(id, username, 활성 여부, effective roles)
    - `POST /auth/members`: 회원 추가. username, 초기 비밀번호, 선택 role을 받는다. 비밀번호는 영구(`temporary: false`)이고 required action이 없다.
    - `DELETE /auth/members/{id}`: 회원 삭제. 테스트 정리와 관리자 삭제에 쓴다. 자기 자신과 `tenant:admin` 보유자는 삭제할 수 없다.
    - `PUT /auth/members/{id}/roles/{role}`: 기능 권한 부여
    - `DELETE /auth/members/{id}/roles/{role}`: 기능 권한 회수
    - `GET /auth/members/grantable-roles`: 호출자 tenant의 현재 부여 가능 role
  - **호출 조건:**
    - `Authorization: Bearer`(결정 9 기준 검증)와 `X-JGW-Service-Key`(결정 15)가 모두 있어야 한다.
    - tenant는 토큰 `tenant` claim에서만 정하고, 대상은 그 realm 안에서만 찾는다.
    - 호출자에게 `member:manage`가 있어야 한다. `operator` tenant는 쓸 수 없다.
  - **부여 가능 role:** 서비스 카탈로그의 부여 가능 role 가운데 그 tenant가 가입한 서비스의 것뿐이다(결정 13). 신분 role, `member:manage`, realm-management role은 이 API로 바꿀 수 없다. Keycloak service account는 realm role과 자기 관리 role을 부여할 수 있으므로, 이 허용 목록이 실제 방어선이다(결정 12).
  - **회수:** 직접 부여한 role만 지운다. 묶음 role로 받은 권한은 남는다. 쓰기를 회수하면 직접 부여한 읽기만 남는다(결정 3).
  - **응답 구분:** 토큰 무효 401, 서비스 키 없음·틀림 401, 권한 없음·부여 불가 role 403, 대상 없음 404, username 중복 409, Keycloak 장애 503.
  - 권한 변경 뒤 세션 정리는 호출한 j-groupware가 한다. j-auth는 Keycloak 세션을 건드리지 않는다.
- **이유:** Keycloak 관리 열쇠를 j-auth 한 곳에 두고, tenant를 서명된 토큰에서만 가져와 다른 tenant 조작 경로를 없앤다.

### 결정 12. 회원 관리용 Keycloak 자격
- **결정:**
  - 고객 realm마다 service account 전용 confidential client `j-auth-admin`을 둔다. Standard Flow와 Direct Access Grants는 끈다. 운영사 realm에는 두지 않는다.
  - realm-management role은 `manage-users`와 `view-clients` 두 개만 준다. secret 이름은 `KC_ADMIN_SECRET_<realm>`이다.
  - 로그인용 `j-auth` client는 `fullScopeAllowed=false`로 둔다. scope mapping에는 신분 realm role과 서비스 기능 role만 넣는다. 묶음 role의 하위 role도 scope에 있어야 토큰에 들어가므로 하나씩 모두 넣는다.
- **확인 결과 (Keycloak 26.8.0, 기본 권한 모델):**

  | 확인 항목 | 결과 |
  | --- | --- |
  | 회원 목록·추가·client role 조회·부여·회수·effective role 조회를 모두 통과하는 최소 조합 | `manage-users` + `view-clients` 하나뿐 |
  | `query-clients`만으로 client 찾기 | 200이지만 빈 목록이라 client UUID를 얻지 못함 |
  | `view-clients`로 client 조회 | 응답에 그 realm의 client secret이 들어 있음 |
  | service account가 갖지 않은 관리 role(`realm-admin`, `manage-clients`, `manage-realm`) 부여 | 403 |
  | service account가 가진 관리 role(`manage-users`, `view-clients`)과 realm role(`tenant:admin`) 부여 | 허용(204) |
  | 관리 role이 붙은 사용자가 fullScopeAllowed=true인 `j-auth` client로 받은 토큰으로 Admin API 호출 | 200 |
  | 같은 조건에서 fullScopeAllowed=false | 토큰에 관리 role이 없어 403 |
  | ROPC 로그인: 영구 비밀번호 / 임시 비밀번호 | 200 / 400 |

- **알려진 한계:** `view-clients` 때문에 `j-auth-admin`이 같은 realm의 client secret(`j-auth`, `j-auth-provisioner`)을 읽을 수 있다. 그래서 자격 분리는 API 경로 분리이지 비밀값 격리는 아니다. fine-grained admin permissions v2는 backlog다.
- **이유:** 자격이 realm 단위라 한 tenant의 자격으로 다른 tenant를 바꿀 수 없다. 허용 목록, scope 제한, `/admin` 차단(결정 19)을 겹쳐 둔다.

### 결정 13. 서비스 카탈로그와 role client
- **결정:**
  - contracts에 서비스 카탈로그 상수를 둔다. 담는 항목은 서비스 ID, role client ID(= aud), 기능 role, 쓰기→읽기 포함 관계, 부여 가능 role이다. 내용은 architecture.md S3 표와 같고, 이 상수가 원본이다.
  - 기본 서비스 `j-groupware`의 client와 role은 모든 고객 realm에 항상 있다. 선택 서비스(`j-messenger`, `j-mail`, `j-customer-auth-db`, `j-approval`, `j-talk`, `j-web`)는 가입한 realm에만 있다(결정 14).
  - 운영사 realm은 client `j-console`(`customer:read`, `customer:write`)과 묶음 `operator:admin`이다.
  - `tenant:admin` = 기본 서비스 role + 가입 서비스 role 전체. `tenant:member`는 기능 role이 없다.
  - 새 서비스는 카탈로그에 한 줄을 더하는 것으로 시작한다(contracts minor).
- **이유:** `tenant:admin` 식, 부여 가능 role, aud, j-groupware 권한 표가 한 상수에서 나와 문서·코드 중복이 없다.

### 결정 14. 서비스 가입 API
- **결정:**
  - 운영사 전용 API다.
    - `GET /auth/tenants/{tenant}/services`: Keycloak 실제 상태의 가입 서비스
    - `PUT /auth/tenants/{tenant}/services/{service}`: 활성화
    - `DELETE /auth/tenants/{tenant}/services/{service}`: 해제
  - **호출 조건:**
    - 운영사 realm 토큰(aud `j-console`), `customer:write`, 운영 콘솔 서비스 키(결정 15)가 모두 있어야 한다.
    - 고객 realm 토큰은 403이다. 기본 서비스 해제는 400, 카탈로그 밖 서비스는 404다.
  - **활성화:** 서비스 role client(흐름 끔)와 기능 role(쓰기 복합 포함)을 만들고, `tenant:admin`에 넣고, `j-auth` scope mapping에 넣고, 고정 audience mapper를 만든다.
  - **해제:** audience mapper를 지우고, scope mapping과 `tenant:admin`에서 빼고, client를 지운다. 회원에게 준 그 서비스 role도 함께 사라진다(architecture.md S14).
  - 둘 다 멱등이다. 중간 실패는 503이고, 다시 보내면 남은 단계를 마저 한다.
  - 이미 발급된 토큰에는 다음 갱신(최대 5분) 때 반영된다.
  - **자격:** 고객 realm마다 service account 전용 confidential client `j-auth-provisioner`를 둔다. secret은 `KC_PROVISION_SECRET_<realm>`이다. 최소 realm-management role은 I7에서 실제 호출로 확인해 결정 12처럼 표로 기록한다. 후보는 `manage-clients` + `manage-realm` + `view-clients`다.
  - **원본:** 가입 정보의 원본은 운영 콘솔 DB다. 콘솔은 이 API의 조회 결과와 다르면 "반영 실패"로 보여 준다.
  - 새 고객 realm 생성은 프로비저닝 backlog다.
- **이유:** 미가입 서비스의 role·aud가 토큰에 아예 없어 메뉴·중계·서비스 검사가 별도 설정 없이 닫힌다.

### 결정 15. 호출 서비스 키
- **결정:**
  - j-auth 관리 API(결정 11·14)는 사용자 Bearer와 함께 `X-JGW-Service-Key` 헤더를 요구한다.
    - 회원 관리 API: tenant별 j-groupware 키. 고객 서버 j-groupware env(`JGW_SERVICE_KEY`)에만 둔다.
    - 가입 API: 운영 콘솔 키. control plane 콘솔 env에만 둔다.
  - j-auth는 키 원문 대신 SHA-256 해시를 env(`JGW_SERVICE_KEY_HASH_<tenant>`, `CONSOLE_SERVICE_KEY_HASH`)에 두고 상수 시간 비교한다.
  - 키는 고객 서버를 셋팅할 때 생성한다. 교체할 때는 새 해시를 더한 뒤 옛 해시를 지운다(두 개까지 동시 허용).
  - 로그인·갱신·로그아웃은 키를 요구하지 않는다. refresh token은 j-groupware 세션에만 있기 때문이다.
- **이유:** j-groupware가 하위 서비스에 넘긴 사용자 토큰이 새어도, 키가 없으면 회원 권한과 가입 상태를 바꿀 수 없다(architecture.md S4).

## 4. 검증과 배포

### 결정 16. 샘플 realm과 기본 계정
- **결정:**
  - realm은 4개다. tenant ID와 realm 이름을 일부러 다르게 해서 매핑 표(결정 2)도 검증한다.

    | tenant ID | realm | 가입 서비스 | 계정 | role |
    | --- | --- | --- | --- | --- |
    | `operator` | `operator` | - | `op-admin` | `operator:admin` |
    | `sample-a` | `tenant-sample-a` | 전체 | `a-admin` | `tenant:admin` |
    | `sample-a` | `tenant-sample-a` | 전체 | `a-member` | `tenant:member` (기능 role 없음) |
    | `sample-b` | `tenant-sample-b` | 전체 | `b-admin` | `tenant:admin` |
    | `sample-b` | `tenant-sample-b` | 전체 | `b-member` | `tenant:member` |
    | `sample-c` | `tenant-sample-c` | 없음(기본만) | `c-admin` | `tenant:admin` |

  - 서비스별 권한을 가진 회원은 realm JSON에 두지 않는다. 각 서비스 테스트가 회원 관리 API로 만들고 지운다(architecture.md S12).
  - username은 realm 사이에서 겹치지 않게 한다. 비밀번호와 secret은 placeholder로만 쓴다.
- **이유:** 서비스가 늘어도 realm JSON과 j-auth 테스트를 고치지 않는다.

### 결정 17. 테스트
- **결정:** Vitest와 실제 Keycloak 통합 테스트로 증명한다.
  1. 관리자 로그인 성공 + 기대 roles(sample-a 전 서비스, sample-c 기본만)
  2. 하위 회원 로그인 성공 + `tenant:member`만
  3. 비밀번호 틀림 → `{ok:false}`
  4. 없는 계정 → 3과 같은 응답
  5. 미등록 tenant 거절
  6. Keycloak 장애 → 503
  7. `a-admin`이 tenant `sample-b`로 로그인 → `{ok:false}`
  8. 응답 `tenant`와 토큰 iss·azp·aud·`tenant`가 결정 9 기준과 같음(sample-c는 aud `j-groupware`만)
  9. 갱신·로그아웃(결정 10)
  10. 회원 관리(결정 11): 서비스 키 없음 401, 회원 추가·삭제, 부여·회수, 쓰기 부여 시 읽기 포함, 허용 목록 밖·미가입 서비스 role 거절
  11. 가입(결정 14): sample-c 활성화 → roles·aud 반영 → 해제 → 제거, 멱등, 테스트 후 원상복구
- **이유:** 실제 Keycloak과 맞는지 증명한다.

### 결정 18. 배포와 접근
- **결정:** 로컬 완료 후 Hyper-V VM에서 다시 검증한다. 로컬 HTTPS, 비표준 포트(설정 가능)를 쓴다. Keycloak 관리 콘솔은 로컬 전용이다(architecture.md S13).
- **이유:** 단계적으로 검증하고 관리 화면을 외부에 노출하지 않는다.

### 결정 19. control plane의 Keycloak 노출 범위
- **결정:**
  - Keycloak과 j-auth는 `127.0.0.1`에만 bind한다. 같은 서버의 Nginx가 HTTPS로 다음만 통과시킨다.
    - `GET /realms/{realm}/.well-known/openid-configuration`
    - `GET /realms/{realm}/protocol/openid-connect/certs`
    - j-auth API `/auth/*`
  - `/admin`, token 엔드포인트, account 콘솔 등 나머지는 막는다. ROPC는 j-auth가 loopback으로 호출한다.
  - `KC_HOSTNAME`은 Nginx 공개 URL이고 `proxy-headers=xforwarded`를 쓴다. 관리 콘솔은 `hostname-admin` loopback + SSH 터널로만 연다. management 포트도 loopback이다.
  - 방화벽은 Nginx HTTPS 포트만 연다. 고객 서버는 로컬 CA를 신뢰한다(`NODE_EXTRA_CA_CERTS`).
  - 로컬 개발(I1~I7)은 Nginx 없이 loopback으로 쓰고 Nginx는 I5에서 더한다.
- **이유:** 고객 서버에 필요한 것은 공개키와 j-auth API뿐이다.

## 5. 작업 구성

PMT 통합 project 분류 `j-auth`. 순서는 I1 → I2 → I3 → I4 → I6 → I7 → I5이고, I3은 공통 X1(레지스트리) 뒤에 게시한다.

| 순서 | Item | 완료 기준 요약 | 선행 |
| --- | --- | --- | --- |
| I1 | Keycloak 실행 환경 | Compose로 Keycloak + PostgreSQL, 버전 고정, 로컬 HTTPS, 포트 설정, 관리 콘솔 로컬 전용, 비밀값은 Git 제외 env, `KC_HOSTNAME` 고정 | - |
| I2 | realm 구성 | realm 4개 import(결정 16), 카탈로그대로 서비스 role client·쓰기 복합 role·`tenant:admin`(결정 3·13), `j-auth` confidential + DAG·fullScopeAllowed=false, aud·`tenant` mapper, 토큰·세션 수명, `j-auth-admin`·`j-auth-provisioner`, brute force, 기본 계정만, placeholder | I1 |
| I3 | 로그인 API·contracts | `@j-auth/contracts` 0.1.0 레지스트리 게시(결정 8), 매핑 표, `operator`, 로그인·갱신·로그아웃, 동일 실패·503, 검증·카탈로그·서비스 키 상수 | I2, X1 |
| I4 | 통합 테스트 | 결정 17의 1~9 통과 | I3 |
| I6 | 회원 관리 API | 결정 11·15(회원 관리 키), contracts 반영, 결정 17의 10 통과 | I4 |
| I7 | 서비스 가입 API | 결정 14·15(콘솔 키), provisioner 최소 role 확인 기록, contracts 반영, 결정 17의 11 통과 | I6 |
| I5 | Hyper-V VM 검증 | 같은 Compose·realm, VM HTTPS, Nginx 경로 허용 목록(결정 19), 고객 서버에서 JWKS·API 접근, VM 대상 결정 17 전체 통과, 메모리·CPU 측정(architecture.md S15) | I7 |

backlog: fine-grained admin permissions v2, Revoke Refresh Token, 새 고객 realm 자동 생성(프로비저닝), OIDC 전환(architecture.md S4).

## 이전 번호 대응

| 새 | 이전 | 새 | 이전 |
| --- | --- | --- | --- |
| 1 | 3 | 11 | 14 (+회원 삭제, 서비스 키) |
| 2 | 4 | 12 | 15 |
| 3 | 5 (+쓰기 복합) | 13 | 16, 21, 23, 24, 26, 25의 카탈로그 |
| 4 | 6, 7 | 14 | 25 |
| 5 | 8 | 15 | 새로 추가 |
| 6 | 9 | 16 | 17 (서비스 계정 제거) |
| 7 | 10 | 17 | 11 (+17의 케이스) |
| 8 | 13, 18 (레지스트리) | 18 | 12 |
| 9 | 19 | 19 | 20 |
| 10 | 22 | - | 0 → 5장 작업 구성 |
