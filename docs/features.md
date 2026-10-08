# j-auth 기능 목록

j-auth가 제공해야 하는 기능 목록이다. 근거는 [`decisions.md`](decisions.md)의 결정 번호와 제품군 공통 결정(`j-groupware/docs/architecture.md`의 S 번호)이고, 담당 Item은 PMT 통합 project `j-groupware-suite`의 분류 `j-auth`다. 현재 구현 상태는 `j-groupware/docs/implementation-progress.json`, 실제 검증 범위는 [기반 검증](cloud-verification-2026-10-08.md)과 [가입·고객 생성 후속 검증](cloud-provisioning-verification-2026-10-08.md)을 따른다.

작성일: 2026-10-07

상세 동작·입출력·실패 처리·인수 시험은 [기능 명세](feature-specifications.md)를 따른다.

## 1. Keycloak 구성

| ID | 기능 | 핵심 동작 | 사용 주체 | 근거 | Item |
| --- | --- | --- | --- | --- | --- |
| AU-01 | Keycloak 실행 환경 | Compose로 Keycloak(26.2 이상 고정) + PostgreSQL(`jauth` 포함), 로컬 HTTPS, 비표준 포트, 관리 콘솔 로컬 전용, `KC_HOSTNAME` 고정 | 운영자 | 결정 6·18 | I1 |
| AU-02 | 고객 realm 템플릿 | 기본 서비스 role(쓰기→읽기 복합), `tenant:*` 신분 role, `j-groupware` OIDC client, aud·`tenant` mapper, `j-auth-admin`·`j-auth-provisioner`, 토큰 설정, brute force, 테마를 담은 JSON 템플릿 | j-auth(realm 생성), 샘플 import | 결정 3·4·7·13 | I2 |
| AU-03 | 운영사 realm | `operator` realm, `j-console` OIDC client, `customer:read`·`customer:write`, `operator:admin` | 운영 콘솔 | 결정 4·13 | I2 |
| AU-04 | 샘플 realm·기본 계정 | `sample-a`·`sample-b`(전 서비스 가입), `sample-c`(기본만), 기본 계정 6개, 샘플 realm에서만 Direct Access Grants | 테스트 | 결정 16 | I2 |
| AU-05 | OIDC 로그인 | Authorization Code + PKCE(S256) 강제, redirect URI `gw.<tenant>/auth/callback`, 계정 없음·비밀번호 틀림 같은 메시지, brute force 잠금 | 회원(브라우저), j-groupware | 결정 4, S4 | I2·I4 |
| AU-06 | 토큰 수명·갱신·로그아웃 설정 | access 5분, 유휴 30분, 최대 8시간, Revoke Refresh Token(재사용 0), RP-initiated logout, 백채널 로그아웃 URL | j-groupware | 결정 10 | I2 |
| AU-07 | 토큰 축소(token exchange) 허용 | `j-groupware`가 aud를 서비스 하나로 줄인 토큰을 받을 수 있게 standard token exchange 설정 | j-groupware(G23) | S4 | I2 |
| AU-08 | FGAP v2 권한 | `j-auth-admin`은 사용자 관리·세션 종료와 부여 가능 role 매핑만 허용, client secret 조회·`tenant:admin` 부여 불가, 확인 결과 표 기록 | j-auth 내부 | 결정 12 | I2 |
| AU-09 | 로그인 화면 테마 | `themes/jgw`, Keycloak 기본 login 테마 상속 + j-groupware UI 토큰 CSS | 회원·운영자 | 결정 21, S5 | I2 |

## 2. j-auth 서버 기반

| ID | 기능 | 핵심 동작 | 사용 주체 | 근거 | Item |
| --- | --- | --- | --- | --- | --- |
| AU-10 | 서버 골격·DB | S11 골격, `jauth` 마이그레이션(tenant 표: 상태, 서비스 키 해시, 서비스 client·role 내부 id) | - | 결정 2·6 | I3 |
| AU-11 | contracts 패키지 | `@j-auth/contracts` 게시: 관리 API 계약, 토큰 검증 상수, 서비스 카탈로그, 서비스 키 헤더, realm 이름 규칙, OIDC 경로 | 모든 서비스 | 결정 8·9·13, S10 | I3 |
| AU-12 | 서비스 카탈로그 | 서비스 ID, role client(= aud), 기능 role, 쓰기→읽기, 부여 가능 role의 단일 원본. `tenant:admin` 식·aud 목록·권한 표 계산 | 모든 서비스 | 결정 13, S3 | I3 |
| AU-13 | 토큰 검증 공통 코드 | RS256, iss, `azp=j-groupware`, aud, `tenant` claim, 허용 tenant 검사, JWKS 캐시·`kid` 재조회 | j-auth 관리 API | 결정 9 | I3 |
| AU-14 | 서비스 키 검사 | `X-JGW-Service-Key` SHA-256 해시 상수 시간 비교, tenant 키(DB)·콘솔 키(env), 교체 중 두 키 허용 | j-auth 관리 API | 결정 15 | I3 |
| AU-15 | Keycloak 비밀값 읽기 | master 자격으로 realm의 `j-auth-admin`·`j-auth-provisioner` secret을 읽어 메모리에만 보관 | j-auth 내부 | 결정 5 | I3 |

## 3. 회원 관리 API (고객 tenant)

호출: j-groupware 서버, 사용자 Bearer(`member:manage`) + tenant 서비스 키.

| ID | 기능 | 핵심 동작 | 근거 | Item |
| --- | --- | --- | --- | --- |
| AU-20 | 회원 목록 | `GET /auth/members`: id, username, 활성 여부, effective roles | 결정 11 | I6 |
| AU-21 | 회원 추가 | `POST /auth/members`: username, 영구 초기 비밀번호, 선택 role. username 중복 409 | 결정 11 | I6 |
| AU-22 | 회원 삭제 | `DELETE /auth/members/{id}`: 자기 자신·`tenant:admin` 삭제 불가 | 결정 11 | I6 |
| AU-23 | 권한 부여·회수 | `PUT`/`DELETE /auth/members/{id}/roles/{role}`: 가입 서비스의 부여 가능 role만, 직접 부여분만 회수 | 결정 11·3 | I6 |
| AU-24 | 부여 가능 role 조회 | `GET /auth/members/grantable-roles`: 카탈로그 ∩ 가입 서비스 | 결정 11 | I6 |
| AU-25 | 변경 시 세션 종료 | 부여·회수·삭제 후 그 회원의 Keycloak 세션 종료 → 백채널 로그아웃 | 결정 10·11 | I6 |

## 4. 운영사 관리 API

호출: 운영 콘솔 서버, 운영사 Bearer(`customer:write`) + 콘솔 키.

| ID | 기능 | 핵심 동작 | 근거 | Item |
| --- | --- | --- | --- | --- |
| AU-30 | 가입 서비스 조회 | `GET /auth/tenants/{tenant}/services`: Keycloak 실제 상태 | 결정 14 | I7 |
| AU-31 | 서비스 활성화 | `PUT …/services/{service}`: role client·role 생성, `tenant:admin`·scope mapping·aud mapper·FGAP 반영, 멱등 | 결정 14·12 | I7 |
| AU-32 | 서비스 해제 | `DELETE …/services/{service}`: 활성화 역순 + client 삭제(부여된 권한도 사라짐), 멱등 | 결정 14, S14 | I7 |
| AU-40 | 고객 realm 자동 생성 | `POST /auth/tenants`: 템플릿으로 realm 생성, 고객 관리자 계정, 내부 id 저장, tenant 서비스 키 생성, `j-groupware` secret·서비스 키 1회 반환, 멱등(완료 후 409) | 결정 20 | I8 |
| AU-41 | 고객 비밀값 교체 | `POST /auth/tenants/{tenant}/rotate-secrets`: `j-groupware` secret·서비스 키 재발급, 1회 반환 | 결정 20·15 | I8 |

## 5. 배포·운영

| ID | 기능 | 핵심 동작 | 근거 | Item |
| --- | --- | --- | --- | --- |
| AU-50 | control plane 경로 허용 목록 | Nginx: OIDC 로그인·토큰·로그아웃·JWKS·well-known·테마, `/auth/*`만 통과, `/admin`·account 콘솔 차단, 로그인·토큰 경로 속도 제한 | 결정 19 | I5 |
| AU-51 | VM 검증·측정 | Hyper-V VM에서 전체 테스트, 고객 서버에서 로그인·JWKS·관리 API·백채널 로그아웃 확인, 메모리·CPU 측정 | 결정 17·18, S15 | I5 |

## 6. 범위 밖·backlog

- 고객 realm 삭제(고객 해지)
- 회원 비밀번호 변경·재설정 화면
