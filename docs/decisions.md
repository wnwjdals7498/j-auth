# j-auth 설계 결정

j-auth만의 설계 결정을 적는다. 제품군 공통 결정은 [`j-groupware/docs/architecture.md`](https://github.com/wnwjdals7498/j-groupware/blob/main/docs/architecture.md)(이하 architecture.md)의 S 번호를 따르고 여기서는 링크만 한다. PMT는 통합 project `j-groupware-suite`의 분류 `j-auth`에 같은 번호로 기록한다(S16).

정리일: 2026-10-07. 통합 정리에서 결정 번호를 다시 매겼다(끝의 대응 표). 같은 날 OIDC Authorization Code를 처음부터 쓰기로 하면서 결정 2·4·5·9·10·11·12·15·16·17·19를 고치고 결정 20·21을 더했다.

관련 공통 결정: S2(서비스·DB·자동화 범위), S3(권한 모델·서비스 카탈로그), S4(OIDC·토큰 전달·서비스 키), S5(로그인 화면 예외), S10(레지스트리), S12(테스트 계정), S13(배포), S14(해지).

j-auth의 역할: Keycloak과 그 구성(realm·client·role·테마)을 관리하고, 관리 API(회원 관리, 서비스 가입, 고객 realm 생성)와 서비스 카탈로그 contracts를 제공한다. 로그인 자체는 Keycloak이 한다(S4).

## 1. 테넌트와 역할

### 결정 1. 고객 분리 방식
- **결정:** 고객(tenant)마다 Keycloak realm을 하나씩 둔다. 운영사 realm 1개 + 고객별 realm.
- **이유:** 분리가 강하고 최소 구현 단계에서 이해·검증이 쉽다.

### 결정 2. tenant 등록과 realm 이름
- **결정:**
  - 고객 realm 이름은 `tenant-<tenantId>` 규칙으로 정한다. 운영사는 예약어 `operator` → realm `operator`다.
  - 등록된 tenant 목록은 j-auth DB(control plane PostgreSQL의 `jauth`, S2)의 tenant 표에 둔다. 상태(생성 중, 사용, 실패), 생성 시각, 서비스 키 해시(결정 15)를 함께 둔다.
  - 표에 없는 tenant의 관리 API 호출은 거절한다.
  - tenant ID는 `^[a-z][a-z0-9-]{2,30}$`다. 서브도메인 `gw.<tenantId>`와 realm 이름에 그대로 쓴다.
- **이유:** realm 자동 생성(결정 20)과 j-groupware 접속 이름에서 realm을 바로 정할 수 있다.

### 결정 3. 역할 모델
- **결정:**
  - 신분은 realm role, 기능 권한은 서비스 role client의 client role이다(architecture.md S3). 이름은 `대상:동작`, 소문자, 콜론 구분이다.
  - 권한은 사람마다 직접 부여한다. 그룹은 쓰지 않는다.
  - 토큰과 응답의 roles는 복합 role을 펼친 effective roles다. client 구분 없이 이름만 쓰므로 서비스 사이에 같은 role 이름을 두지 않는다. Keycloak 기본 role은 걸러낸다.
  - **쓰기는 읽기를 포함한다:** `<대상>:write`를 같은 client의 `<대상>:read`를 포함하는 복합 client role로 만든다(board, guest, talk, web).

## 2. 로그인과 토큰

### 결정 4. 로그인 흐름 (OIDC Authorization Code)
- **결정 (사용자: 처음부터 OIDC):**
  - **고객 realm의 로그인 client는 `j-groupware`다.**
    - confidential client이고 Standard Flow를 켜며 PKCE(S256)를 강제한다. Direct Access Grants는 끈다(샘플 realm만 예외, 결정 16).
    - redirect URI는 `https://gw.<tenantId>.jgw.test/auth/callback`이다. post logout redirect는 `https://gw.<tenantId>.jgw.test/`, 백채널 로그아웃 URL은 `https://gw.<tenantId>.jgw.test/auth/backchannel-logout`이다.
    - `fullScopeAllowed=false`로 두고, scope mapping에 신분 realm role과 가입 서비스 기능 role만 넣는다. 묶음 role의 하위 role도 하나씩 넣는다.
    - 이 client가 원래 가진 기본 서비스 role(`board:*`, `member:manage`, `org:manage`)은 그대로다.
  - **운영사 realm의 로그인 client는 `j-console`이다.** 같은 방식이고, URI는 콘솔 주소다.
  - j-auth는 로그인 API를 만들지 않는다. 비밀번호는 Keycloak 로그인 화면(결정 21)에만 입력한다.
  - Keycloak brute force detection을 켠다. 계정 없음과 비밀번호 틀림은 Keycloak이 같은 메시지로 보여 준다.
- **이유:** 비밀번호가 j-groupware·j-auth를 지나지 않고, Keycloak 표준 흐름과 보호를 그대로 쓴다.

### 결정 5. Keycloak client와 비밀값
- **결정:**
  - 고객 realm의 confidential client는 `j-groupware`(로그인, 결정 4), `j-auth-admin`(회원 관리, 결정 12), `j-auth-provisioner`(가입 반영, 결정 14)다. 서비스 role client는 흐름이 모두 꺼진 role 보관용이라 secret이 없다.
  - `j-groupware` secret은 realm 생성 때 1회 반환해 고객 서버 j-groupware env에 넣는다(결정 20). j-auth는 보관하지 않는다.
  - `j-auth-admin`·`j-auth-provisioner` secret은 j-auth가 기동하거나 필요할 때 master realm 자격(결정 20)으로 Keycloak에서 읽어 메모리에만 둔다. env와 DB에 저장하지 않는다.
  - j-auth env에 두는 비밀값은 다음뿐이다: master realm 생성 자격, `jauth` DB 접속 정보, 운영 콘솔 키 해시. 로컬은 Git 제외 `.env`, VM은 소유자만 읽는 env 파일이다.
- **이유:** realm이 자동으로 늘어도 env 파일을 고칠 필요가 없고, 저장된 비밀값이 적다.

### 결정 6. Keycloak DB와 기동
- **결정:** Docker Compose로 Keycloak + PostgreSQL을 함께 띄운다. 같은 PostgreSQL 인스턴스에 j-auth database `jauth`와 전용 계정을 둔다. Keycloak 이미지는 정확한 버전(26.2 이상, standard token exchange·FGAP v2 지원)으로 고정한다.

### 결정 7. realm 구성 관리
- **결정:**
  - 고객 realm 템플릿(JSON)을 저장소에 둔다. realm 자동 생성(결정 20)과 샘플 realm이 같은 템플릿을 쓴다.
  - 운영사 realm과 샘플 realm은 Keycloak 시작 때 import한다. 비밀값은 `${...}` placeholder로만 쓴다.

### 결정 8. contracts 패키지
- **결정:**
  - `packages/contracts`를 `@j-auth/contracts`로 만들어 패키지 레지스트리에 게시한다(S10). 첫 버전은 `0.1.0`이다.
  - 다음을 이 패키지에 둔다: 관리 API 계약, 토큰 검증 상수(결정 9), 서비스 카탈로그(결정 13), 서비스 키 헤더 이름(결정 15), realm 이름 규칙(결정 2), j-groupware OIDC 경로(콜백·백채널 로그아웃).
  - semver를 지킨다(1.0 이전에는 호환이 깨지면 minor). `CHANGELOG.md`에 적는다.

### 결정 9. 토큰 검증 기준
- **결정:**
  - issuer는 `${KC_PUBLIC_URL}/realms/{realm}`이다. `KC_HOSTNAME`을 공개 URL로 고정한다.
  - JWKS는 `{issuer}/protocol/openid-connect/certs`이고 RS256만 허용한다. 서비스는 JWKS를 캐시하고, 모르는 `kid`가 오면 다시 가져온다.
  - **`azp`는 `j-groupware`다.** 운영사 realm은 `j-console`이다.
  - `aud`에는 받는 서비스의 client ID가 있어야 한다. `j-groupware` client에 고정 audience mapper를 둔다: `j-groupware` + 가입 서비스 client ID(결정 14). token exchange로 줄인 토큰(S4)은 aud가 그 서비스 하나다.
  - realm마다 고정 claim mapper로 `tenant` claim을 넣는다. 서비스는 iss와 `tenant`가 둘 다 허용 tenant와 맞는지 검사한다.
  - claim 이름, `azp`, aud, JWKS 경로 규칙은 contracts 상수로 둔다.
- **이유:** 서명된 claim이라 위조할 수 없고, aud가 가입 상태와 받는 서비스를 나타낸다.

### 결정 10. 토큰 수명, 갱신, 로그아웃
- **결정:**
  - realm 설정은 access token 5분, SSO Session Idle 30분, SSO Session Max 8시간이다. 설정으로 바꿀 수 있다.
  - **Revoke Refresh Token을 켜고 Refresh Token Max Reuse는 0이다.** 갱신할 때마다 새 refresh token이 나오고, 이미 쓴 것을 다시 내면 Keycloak이 거절하고 그 세션을 끝낸다.
  - 갱신은 j-groupware가 Keycloak 토큰 엔드포인트로 직접 한다. 같은 세션의 동시 갱신은 j-groupware가 한 번으로 묶는다(j-groupware 결정 1).
  - 로그아웃은 RP-initiated logout이다. Keycloak 세션이 끝나면 Keycloak이 j-groupware 백채널 로그아웃 엔드포인트로 알린다.
  - 회원 권한을 바꾸거나 삭제하면 j-auth가 그 회원의 Keycloak 세션을 끝낸다(결정 11). 그러면 백채널 로그아웃이 j-groupware 세션을 지운다.
- **이유:** refresh token이 새어도 한 번밖에 쓸 수 없고, 세션 무효화가 이벤트 기반이 된다(S4).

## 3. 관리 API

### 결정 11. 회원 관리 API
- **결정:**
  - 고객 tenant 전용 API다. 경로 초안은 아래와 같고, 필드명은 contracts에서 정한다.
    - `GET /auth/members`: 목록(id, username, 활성 여부, effective roles)
    - `POST /auth/members`: 추가. username, 초기 비밀번호(영구, required action 없음), 선택 role
    - `DELETE /auth/members/{id}`: 삭제. 자기 자신과 `tenant:admin` 보유자는 삭제할 수 없다.
    - `PUT /auth/members/{id}/roles/{role}`: 부여
    - `DELETE /auth/members/{id}/roles/{role}`: 회수
    - `GET /auth/members/grantable-roles`: 현재 부여 가능 role
  - **호출 조건:**
    - Bearer(결정 9)와 `X-JGW-Service-Key`(결정 15)가 모두 있어야 한다.
    - tenant는 토큰 `tenant` claim에서만 정하고, 대상은 그 realm 안에서만 찾는다.
    - 호출자에게 `member:manage`가 있어야 한다. `operator` tenant는 쓸 수 없다.
  - **부여 가능 role:** 카탈로그의 부여 가능 role 가운데 그 tenant가 가입한 서비스의 것뿐이다(결정 13). Keycloak FGAP v2(결정 12)도 같은 목록만 허용한다.
  - **회수:** 직접 부여한 role만 지운다. 쓰기를 회수하면 직접 부여한 읽기만 남는다.
  - **세션 종료:** 부여·회수·삭제가 끝나면 그 회원의 Keycloak 세션을 끝낸다(결정 10).
  - **응답 구분:** 401(토큰·서비스 키), 403(권한 없음·부여 불가 role), 404, 409(username 중복), 503(Keycloak 장애).

### 결정 12. 회원 관리용 Keycloak 자격 (FGAP v2)
- **결정 (AI 위임):**
  - 고객 realm마다 service account 전용 client `j-auth-admin`을 둔다. Standard Flow와 Direct Access Grants는 끈다.
  - 고객 realm 템플릿에서 **Admin Permissions(fine-grained admin permissions v2)를 켠다.**
  - `j-auth-admin`에는 realm-management role(`manage-users`, `view-clients`)을 주지 않는다. 대신 FGAP v2 권한만 준다.
    - **Users:** 그 realm 모든 사용자의 조회·관리·role 매핑·세션 종료
    - **Roles/Clients:** 카탈로그의 부여 가능 role에만 role 매핑 허용. 서비스 role client만 조회 허용
  - 서비스 role client와 role의 Keycloak 내부 id는 realm 생성·가입 반영 때 j-auth DB에 저장한다. 그래서 client 목록을 조회할 필요가 없다.
  - 가입 반영(결정 14)으로 부여 가능 role이 바뀌면 `j-auth-provisioner`가 FGAP 권한도 함께 고친다.
  - j-auth 코드의 허용 목록 검사는 그대로 둔다(두 겹).
- **이전 확인 결과 (Keycloak 26.8.0, 기본 권한 모델, 참고):**
  - 회원 관리 전 동작에 필요한 최소 조합은 `manage-users` + `view-clients` 하나뿐이었다.
  - 그런데 `view-clients`로는 그 realm의 client secret까지 읽힌다.
  - service account는 자기가 가진 관리 role과 realm role(`tenant:admin`)을 부여할 수 있었다.
  - 이 두 문제가 FGAP v2로 바꾸는 이유다.
- **검증:** I2에서 FGAP v2로 위 동작이 모두 되는지, 그리고 아래가 모두 거절되는지 실제 호출로 확인해 표로 기록한다.
  - client secret 조회
  - `tenant:admin`·관리 role 부여
  - 허용 목록 밖 role 부여
  - FGAP v2로 표현할 수 없는 동작이 있으면 그 동작만 이전 방식으로 두고 표에 남긴다.
- **이유:** Keycloak 자체가 부여 가능 role만 허용하고, 회원 관리 자격으로 비밀값을 읽을 수 없게 된다.

### 결정 13. 서비스 카탈로그와 role client
- **결정:**
  - contracts에 서비스 카탈로그 상수를 둔다. 항목: 서비스 ID, role client ID(= aud), 기능 role, 쓰기→읽기 포함, 부여 가능 role. 내용은 architecture.md S3 표와 같고, 이 상수가 원본이다.
  - 기본 서비스 `j-groupware`의 role은 모든 고객 realm에 있다. 선택 서비스의 client와 role은 가입한 realm에만 있다(결정 14).
  - 운영사 realm은 `j-console`(`customer:read`, `customer:write`)과 묶음 `operator:admin`이다.
  - `tenant:admin` = 기본 + 가입 서비스 role 전체. `tenant:member`는 기능 role이 없다.

### 결정 14. 서비스 가입 API
- **결정:**
  - 운영사 전용 API다.
    - `GET /auth/tenants/{tenant}/services`: 가입 서비스 조회
    - `PUT /auth/tenants/{tenant}/services/{service}`: 활성화
    - `DELETE /auth/tenants/{tenant}/services/{service}`: 해제
  - 호출 조건: 운영사 realm 토큰(aud `j-console`), `customer:write`, 운영 콘솔 키(결정 15).
  - **활성화:** 서비스 role client(흐름 끔)와 기능 role(쓰기 복합)을 만든다. `tenant:admin`과 `j-groupware` scope mapping에 넣고, `j-groupware` client에 audience mapper를 만들고, FGAP 부여 허용을 고친다.
  - **해제:** 활성화를 반대로 하고 client를 지운다. 회원에게 준 그 서비스 role도 사라진다(S14).
  - 둘 다 멱등이다. 중간 실패는 503이고, 다시 보내면 남은 단계를 마저 한다. 이미 발급된 토큰에는 다음 갱신 때 반영된다.
  - **자격:** realm마다 `j-auth-provisioner`(realm-management `manage-clients`, `manage-realm`, `view-clients`)를 둔다. 최소 role은 I7에서 실제 호출로 확인해 기록한다. 이 자격은 가입 반영 경로에서만 쓴다.

### 결정 15. 호출 서비스 키
- **결정:**
  - 관리 API는 Bearer와 함께 `X-JGW-Service-Key`를 요구한다.
    - 회원 관리: tenant별 j-groupware 키. 고객 서버 j-groupware env에만 있다.
    - 가입·realm 생성: 운영 콘솔 키. 콘솔 env에만 있다.
  - j-auth는 키의 SHA-256 해시만 둔다. tenant 키는 `jauth` tenant 표에, 콘솔 키는 j-auth env에 두고 상수 시간으로 비교한다.
  - tenant 키는 realm 생성 때 만들어 1회 반환한다(결정 20). 교체할 때는 두 해시를 잠시 함께 허용한다.
- **이유:** 하위 서비스로 넘어간 사용자 토큰이 새어도, 키가 없으면 회원 권한·가입 상태를 바꿀 수 없다(S4).

## 4. 검증과 배포

### 결정 16. 샘플 realm과 기본 계정
- **결정:**
  - realm 4개를 import한다. 고객 realm은 결정 7의 템플릿으로 만든다.

    | tenant ID | realm | 가입 서비스 | 계정 | role |
    | --- | --- | --- | --- | --- |
    | `operator` | `operator` | - | `op-admin` | `operator:admin` |
    | `sample-a` | `tenant-sample-a` | 전체 | `a-admin` / `a-member` | `tenant:admin` / `tenant:member` |
    | `sample-b` | `tenant-sample-b` | 전체 | `b-admin` / `b-member` | `tenant:admin` / `tenant:member` |
    | `sample-c` | `tenant-sample-c` | 없음(기본만) | `c-admin` | `tenant:admin` |

  - **샘플 realm에서만** `j-groupware`·`j-console` client의 Direct Access Grants를 켠다. 테스트가 브라우저 없이 토큰을 받기 위해서다. 자동 생성 realm에서는 꺼져 있다.
  - 서비스별 권한 회원은 각 서비스 테스트가 회원 관리 API로 만들고 지운다(S12).
  - 비밀번호와 secret은 placeholder로만 쓴다.

### 결정 17. 테스트
- **결정:** Vitest와 실제 Keycloak 통합 테스트(브라우저 흐름은 Playwright)로 증명한다.
  1. Authorization Code + PKCE 로그인(Playwright, 테마 화면): `a-admin` 성공, 기대 roles(sample-a 전 서비스, sample-c 기본만)
  2. 비밀번호 틀림·없는 계정: 같은 오류 화면, brute force 잠금
  3. PKCE 없는 요청·등록되지 않은 redirect URI 거절
  4. 토큰 claim: iss·`azp=j-groupware`·aud·`tenant`가 결정 9와 같음, 다른 realm 토큰은 tenant 불일치
  5. 갱신: 새 refresh token 발급, 이미 쓴 refresh token 재사용 거절과 세션 종료
  6. 로그아웃: RP-initiated logout, 백채널 로그아웃 요청 수신(테스트 수신기)
  7. 회원 관리: 서비스 키 없음 401, 추가·삭제, 부여·회수, 쓰기 부여 시 읽기 포함, 허용 목록 밖·미가입 role 거절(j-auth 검사 + FGAP v2 거절 둘 다), 권한 변경 시 세션 종료와 백채널 로그아웃
  8. FGAP v2: `j-auth-admin`으로 client secret 조회·`tenant:admin` 부여 거절
  9. 가입: sample-c 활성화 → roles·aud 반영 → 해제, 멱등, 원상복구
  10. realm 생성: 새 tenant 생성 → 관리자 로그인·기본 roles → 1회 비밀값 응답 → 같은 요청 재시도 409 → 테스트 후 realm 정리
  11. Keycloak 장애 → 관리 API 503

### 결정 18. 배포와 접근
- **결정:** 로컬 완료 후 Hyper-V VM에서 다시 검증한다. 로컬 HTTPS, 비표준 포트(설정 가능). Keycloak 관리 콘솔은 로컬 전용이다(S13).

### 결정 19. control plane의 Keycloak 노출 범위
- **결정:**
  - Keycloak과 j-auth는 `127.0.0.1`에만 bind한다. 같은 서버의 Nginx가 HTTPS로 다음만 통과시킨다.
    - 로그인 흐름: `/realms/{realm}/protocol/openid-connect/auth`, `/realms/{realm}/login-actions/*`, `/resources/*`(테마)
    - 고객 서버 j-groupware용: `/realms/{realm}/protocol/openid-connect/token`, `/logout`, `/certs`, `/.well-known/openid-configuration`
    - j-auth API `/auth/*`
  - 막는 경로: `/admin`(관리 콘솔·Admin REST), account 콘솔, 그 밖의 Keycloak 경로. Admin REST는 j-auth가 loopback으로만 쓴다.
  - 로그인·토큰 경로에는 IP별 요청 속도 제한(`limit_req`)을 건다.
  - `KC_HOSTNAME`은 Nginx 공개 URL이고 `proxy-headers=xforwarded`다. 관리 콘솔은 `hostname-admin` loopback + SSH 터널로만 연다. management 포트도 loopback이다.
  - 방화벽은 Nginx HTTPS 포트만 연다. Keycloak이 고객 서버의 백채널 로그아웃 주소로 나가는 HTTPS는 허용한다.
  - 로컬 개발은 Nginx 없이 loopback으로 쓰고, Nginx는 I5에서 더한다.
- **이유:** 브라우저와 고객 서버에 필요한 OIDC 경로만 열고, 관리 화면과 Admin REST는 밖으로 나가지 않는다.

## 5. 고객 realm 생성과 로그인 화면

### 결정 20. 고객 realm 자동 생성
- **결정 (사용자: realm 생성 자동화):**
  - `POST /auth/tenants {tenantId, adminUsername, adminPassword}`
    - 운영사 토큰, `customer:write`, 콘솔 키가 있어야 한다.
    - 운영 콘솔이 고객을 등록할 때 호출한다.
  - **처리 순서:**
    1. tenant 표에 "생성 중"으로 기록한다.
    2. 고객 realm 템플릿으로 realm `tenant-<tenantId>`를 만든다. 템플릿에는 기본 서비스 role, `j-groupware` client(URI는 tenantId로 채움), `j-auth-admin`·`j-auth-provisioner`, mapper, FGAP v2, 토큰 설정, brute force, 로그인 테마가 들어 있다.
    3. 고객 관리자 계정(`tenant:admin`, 영구 비밀번호)을 만든다.
    4. 서비스 role client·role 내부 id를 저장한다.
    5. tenant 서비스 키를 만들어 해시를 저장한다.
    6. "사용"으로 바꾼다.
  - **응답(1회):** `j-groupware` client secret, tenant 서비스 키. 콘솔은 이 값을 고객 서버 부트스트랩 정보로 운영자에게 한 번만 보여 준다. j-auth와 콘솔 모두 원문을 저장하지 않는다.
  - 멱등이다. 같은 tenantId로 다시 부르면 남은 단계를 마저 하고, 이미 "사용"이면 409다(비밀값을 다시 주지 않는다). 비밀값을 잃으면 교체 API(`POST /auth/tenants/{tenant}/rotate-secrets`)로 새로 받는다.
  - **자격:** master realm의 service account client `j-auth-realm-creator`(`create-realm`)를 쓴다. Keycloak은 realm을 만든 계정에 그 realm 관리 권한을 준다. j-auth는 이 권한으로 새 realm의 `j-auth-admin`·`j-auth-provisioner` secret을 읽는다(결정 5).
  - **범위 밖:** 고객 서버(VM) 생성은 수동이고, 사양 자동화도 없다(S2). realm 삭제는 backlog다.
- **이유:** 고객 등록부터 가입 반영까지 사람이 Keycloak 콘솔을 만질 필요가 없다.

### 결정 21. 로그인 화면 테마
- **결정:**
  - Keycloak 로그인·로그아웃·오류 화면에 j-auth 저장소 `themes/jgw` 테마를 쓴다.
  - j-groupware `ui-guidelines.md`의 색·간격·타이포 토큰을 CSS 변수로 복사한다. 템플릿은 Keycloak 기본 login 테마를 상속하고 CSS만 바꾼다.
  - 고객 realm 템플릿과 운영사 realm에 지정한다. 토큰이 바뀌면 j-auth에서 테마 CSS를 갱신한다.
- **이유:** 화면 일원화 원칙의 예외(S5)지만 같은 UI 기준을 따른다. 템플릿 상속만 쓰면 Keycloak 업그레이드 부담이 작다.

## 6. 작업 구성

PMT 통합 project 분류 `j-auth`. 순서는 I1 → I2 → I3 → I4 → I6 → I7 → I8 → I5다. 공통 X1(레지스트리)이 먼저다.

| Item | 완료 기준 요약 | 선행 |
| --- | --- | --- |
| I1 Keycloak 실행 환경 | Compose로 Keycloak(26.2 이상 고정) + PostgreSQL(`jauth` 포함), 로컬 HTTPS, 포트 설정, 관리 콘솔 로컬 전용, Git 제외 env, `KC_HOSTNAME` 고정 | X1 |
| I2 realm 템플릿·OIDC 구성 | 고객 realm 템플릿(결정 4·7·10·13), `j-groupware`·`j-console` OIDC client(PKCE, URI, 백채널 로그아웃), Revoke Refresh Token, FGAP v2(결정 12, 확인 표 기록), 테마(결정 21), 샘플 realm 4개(결정 16) | I1 |
| I3 j-auth 서버·contracts | S11 골격, `jauth` 마이그레이션(tenant 표), `@j-auth/contracts` 0.1.0 게시(결정 8), 토큰 검증 공통 코드, 서비스 키 검사, Keycloak 비밀값 읽기(결정 5) | I2 |
| I4 로그인 통합 테스트 | 결정 17의 1~6 통과 | I3 |
| I6 회원 관리 API | 결정 11·15, 세션 종료, 결정 17의 7·8 통과 | I4 |
| I7 서비스 가입 API | 결정 14, FGAP 갱신, provisioner 최소 role 기록, 결정 17의 9 통과 | I6 |
| I8 realm 자동 생성 API | 결정 20(템플릿 생성, 관리자 계정, 1회 비밀값, 멱등, 비밀값 교체), 결정 17의 10·11 통과 | I7 |
| I5 Hyper-V VM 검증 | 결정 19 Nginx 경로·속도 제한, 고객 서버에서 OIDC 로그인·갱신·JWKS·관리 API, 백채널 로그아웃 도달, VM 대상 결정 17 전체, 메모리·CPU 측정(S15) | I8 |

backlog: 고객 realm 삭제(고객 해지), 회원 비밀번호 변경·재설정 화면(Keycloak account 기능 사용 여부 포함).

## 이전 번호 대응

| 새 | 이전 | 새 | 이전 |
| --- | --- | --- | --- |
| 1 | 3 | 12 | 15 (+FGAP v2) |
| 2 | 4 (규칙 이름 + DB) | 13 | 16, 21, 23, 24, 26, 25의 카탈로그 |
| 3 | 5 (+쓰기 복합) | 14 | 25 |
| 4 | 6, 7 (OIDC로 대체) | 15 | 새로 추가 |
| 5 | 8 | 16 | 17 |
| 6 | 9 | 17 | 11, 17의 케이스 (OIDC로 대체) |
| 7 | 10 | 18 | 12 |
| 8 | 13, 18 | 19 | 20 (OIDC 경로 추가) |
| 9 | 19 | 20 | 새로 추가 |
| 10 | 22 (Revoke 켬, j-auth 갱신 API 없음) | 21 | 새로 추가 |
| 11 | 14 (+삭제, 서비스 키, 세션 종료) | - | 0 → 5장 작업 구성 |
