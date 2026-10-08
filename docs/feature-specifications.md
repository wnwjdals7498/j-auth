# j-auth 기능 명세

작성일: 2026-10-08. 상태: **서버 기반·회원 API 구현 및 클라우드 범위 검증, 전체 인수 시험 미완료**. [기능 목록](features.md), [서비스 결정](decisions.md), [제품군 명세 기준](../../j-groupware/docs/suite-feature-specifications.md)을 따른다. 로그인은 Keycloak, 관리 API·구성·공유 카탈로그는 j-auth가 소유한다. 실행한 결과와 미실행 범위는 [클라우드 검증 기록](cloud-verification-2026-10-08.md)에서 구별한다.

## 입출력과 데이터

| 대상 | 최소 계약 |
| --- | --- |
| tenant 등록 | `tenantId`는 `^[a-z][a-z0-9-]{2,30}$`; `operator`는 예약값이다. 고객 realm은 `tenant-<tenantId>`다. 상태는 생성 중·사용·실패, Keycloak 내부 client/role id와 서비스 키 해시를 저장한다. |
| 회원 | Keycloak id, username, 활성 여부, effective roles. 추가 입력은 username·영구 초기 비밀번호·선택 role이다. 비밀번호 원문은 Keycloak 호출 뒤 저장·로그에서 제외한다. |
| 회원 관리 인증 | 원래 고객 사용자 Bearer(`azp=j-groupware`, 해당 tenant)와 그 tenant 서비스 키. `member:manage`가 필수다. 관리 API 수신자가 j-auth라고 임의의 `aud=j-auth`를 새로 만들지 않고 I3 계약에서 기존 발급 audience와 검증값을 일치시킨다. |
| 운영사 관리 인증 | 운영사 realm Bearer(`azp=j-console`, `aud`에 `j-console`), `customer:write`, 콘솔 서비스 키. path tenant는 관리 대상이고 호출자의 tenant로 위장하지 않는다. |
| 카탈로그 | service id, role client id/aud, 기능 role, 쓰기→읽기 포함, 부여 가능 role. 신분 role과 `member:manage`는 하위 회원에게 부여할 수 없다. |
| 비밀값 | tenant 서비스 키는 해시만, master 자격·DB 접속·콘솔 키 해시는 env. `j-auth-admin`·`j-auth-provisioner` secret은 필요한 때 Keycloak에서 읽어 메모리에만 둔다. |

## 정상 흐름

1. I1·I2에서 고정 버전 실행 환경과 공통 템플릿·샘플 realm을 만든다. I3 contracts가 카탈로그·claim·관리 API 규격의 원본이 된다.
2. 로그인은 등록된 callback과 PKCE로 진행하고 BFF가 코드를 교환한다. 자동 생성 고객 realm의 Direct Access Grants는 끈다.
3. 회원 관리 요청은 Bearer·서비스 키·허용 role을 확인한 뒤 해당 realm만 변경하고 대상 회원의 세션을 종료한다.
4. 가입 반영은 client·role·scope·aud·FGAP 실제 상태를 맞춘다. 중간 실패 후 재시도는 이미 반영된 부분을 확인하며 이어간다.
5. 고객 생성은 생성 중 기록 → realm·관리자·내부 id → 키 해시 → 사용 상태 순서다. 완료한 tenant를 다시 생성하면 409; 비밀값 유실은 교체 API로 처리한다.

## 기능별 계약

| 기능 ID | PMT Item | 입력·정상 동작·출력 | 권한·실패 경계 | 인수 시험 |
| --- | --- | --- | --- | --- |
| AU-01 | I1 | 고정 이미지·DB/env·HTTPS·포트 설정으로 Keycloak과 jauth 기동 | 비밀값 Git 제외, 관리·management 접근 로컬 한정 | AU-T01 |
| AU-02 | I2 | tenant 템플릿으로 기본 role·client·mapper·보호 설정 생성 | 샘플과 자동 생성이 같은 기준; client별 flow 구별 | AU-T01 |
| AU-03 | I2 | operator realm·j-console·customer role 생성 | 고객 토큰으로 운영사 관리 불가 | AU-T01 |
| AU-04 | I2 | sample-a/b 전체·sample-c 기본·계정 6개 import | Direct Access Grants 예외는 샘플만 | AU-T01 |
| AU-05 | I2·I4 | 브라우저 Authorization Code·PKCE 로그인 → 기대 claim | PKCE/redirect 위반 거절, 없는 계정·틀린 암호 동일 안내 | AU-T02 |
| AU-06 | I2 | access 5분·idle 30분·max 8시간·refresh 회전·로그아웃 설정 | 같은 refresh 재사용과 로그아웃의 실제 결과 확인 | AU-T03 |
| AU-07 | I2 | confidential j-groupware의 standard exchange 설정 | 다른 서비스 audience 권한이 새로 늘지 않음 | AU-T04 |
| AU-08 | I2 | admin의 사용자 관리·세션 종료·허용 role 매핑 | secret 읽기·관리 role·tenant:admin 부여 거절 | AU-T05 |
| AU-09 | I2 | jgw 테마 CSS에 UI 토큰 반영 → 로그인·오류 화면 | 기본 테마 상속, 비밀번호 입력은 Keycloak 화면 | AU-T02 |
| AU-10 | I3 | tenant 상태·키 해시·내부 id migration → jauth | 다른 서비스 DB 접속 불가 | AU-T06 |
| AU-11 | I3 | 관리 API·claim·카탈로그 contracts 0.1.0 게시 | 정확한 버전 설치·호환 변경 이력; X1 결정 선행 | AU-T06 |
| AU-12 | I3 | 카탈로그에서 admin 묶음·grantable roles·aud 계산 | 기본 서비스는 항상, 미가입 서비스는 제외 | AU-T07 |
| AU-13 | I3 | RS256·iss·exp·azp·aud·tenant·JWKS 검증 | 모르는 kid 재조회, JWKS 장애와 무효 토큰 구별 | AU-T04 |
| AU-14 | I3 | X-JGW-Service-Key 해시 상수 시간 검사, 교체 중 두 해시 | 고객 키를 다른 tenant·콘솔 API에 사용 불가 | AU-T07 |
| AU-15 | I3 | master 자격으로 admin/provisioner secret 조회·메모리 사용 | DB·env 복제·로그 비노출, 실패 시 해당 작업 장애 | AU-T06 |
| AU-20 | I6 | GET /auth/members → id·username·활성·effective roles | member:manage·고객 realm만, 401·403 | AU-T07 |
| AU-21 | I6 | POST /auth/members → 회원 1명 생성·선택 role 적용 | username 중복 409, 허용 밖 role 403 | AU-T07 |
| AU-22 | I6 | DELETE /auth/members/{id} → 대상 삭제·세션 종료 | 자기 자신·tenant:admin 삭제 거절, 타 realm 대상 비노출 | AU-T07 |
| AU-23 | I6 | PUT/DELETE role 경로 → 직접 부여분 변경·effective roles | 쓰기 포함 읽기와 직접 읽기 구별, 허용 밖 403 | AU-T07 |
| AU-24 | I6 | GET /auth/members/grantable-roles → 카탈로그∩가입 | 신분·member:manage·미가입 role 없음 | AU-T07 |
| AU-25 | I6 | 권한 변경·삭제 후 Keycloak 세션 종료·backchannel 요청 | 변경 성공/세션 종료 실패의 부분 결과를 숨기지 않음 | AU-T03·AU-T07 |
| AU-30 | I7 | GET /auth/tenants/{tenant}/services → Keycloak 실제 상태 | 운영사 token·customer:write·콘솔 키 | AU-T08 |
| AU-31 | I7 | PUT service → client·role·묶음·scope·aud·FGAP 반영 | 재호출 무중복; 중간 장애 503·재개 | AU-T08 |
| AU-32 | I7 | DELETE service → 참조·권한 제거·client 삭제 | 반복 해제 멱등, 새 토큰에 제거 상태 반영 | AU-T08 |
| AU-40 | I8 | POST /auth/tenants → realm·관리자·1회 bootstrap 비밀값 | 잘못된 tenant 입력 거절, 사용 상태 재생성 409 | AU-T09 |
| AU-41 | I8 | POST rotate-secrets → 새 client secret·서비스 키 1회 | 이전/새 키 유효 구간은 I8 계약에서 고정 | AU-T09 |
| AU-50 | I5 | Nginx OIDC·theme·/auth 허용 목록과 속도 제한 | /admin·account·management 외부 차단 | AU-T10 |
| AU-51 | I5 | VM에서 로그인·관리 API·JWKS·backchannel·측정 | 로컬 통과와 VM 통과를 구별해 증거 기록 | AU-T10 |

## 인수 시험

| ID | 관찰할 결과 |
| --- | --- |
| AU-T01 | 샘플 4 realm·기본 계정·템플릿 비교, sample-c 선택 role/aud 없음, 새 고객 realm의 password grant 꺼짐, 관리 포트 외부 거절. |
| AU-T02 | 실제 브라우저 로그인·callback·테마, 잘못된 암호/없는 계정 동일 화면, PKCE 누락·redirect 불일치 거절, brute force 설정 확인. |
| AU-T03 | 실제 갱신·refresh 재사용, 로그아웃·권한 변경 시 Keycloak 세션 종료와 BFF 세션·WSS 제거. 거절/세션 종료 범위는 고정 버전의 실측 표로 남긴다. |
| AU-T04 | 원본과 교환 토큰 claim 비교; aud가 목표 1개, 필요한 role 유지, 다른 aud·issuer·tenant·서명·만료 거절, JWKS 장애 503. |
| AU-T05 | 같은 admin 자격으로 허용 사용자 작업 성공과 secret·tenant:admin·관리 role·미가입 role 작업 거절을 각각 실제 Admin REST로 확인. |
| AU-T06 | DB migration·재기동, 다른 DB 접근 거절, contracts 게시/설치, secret 원문이 DB·로그·배포 설정에 남지 않음. |
| AU-T07 | 실제 회원 추가·목록·삭제·role 변경, direct/effective role 차이, tenant 서비스 키 혼용 거절, 금지된 변경의 Keycloak 상태 불변. |
| AU-T08 | sample-c 활성화·반복·해제·반복, scope/aud/FGAP 실제 상태 비교, 중간 단계 장애 후 재시도로 목표 상태에 수렴, provisioner 최소 자격 표. |
| AU-T09 | 신규 tenant 생성·로그인·1회 비밀 응답·완료 후 409, 중간 실패 재개, 비밀 교체, Keycloak 장애가 성공/사용 상태로 기록되지 않음. |
| AU-T10 | VM 고객 서버에서 전체 흐름, OIDC 경로 허용/관리 경로 거절, backchannel 도달·자원 측정·실제 Nginx 제한 응답. |

## 미정과 경계

I2는 정확한 Keycloak 버전과 FGAP 실측 표, I3은 DTO·관리 API audience, I7은 최소 provisioner 권한, I8은 비밀 교체 병행 기간·부분 실패 응답을 고정한다. FGAP로 표현되지 않는 작업의 예외는 기존 결정 12가 허용한 범위 안에서 결과표에 명시한다. realm 삭제·비밀번호 변경 화면은 추가하지 않는다. 공통 관문은 [FS-U02·03](../../j-groupware/docs/suite-feature-specifications.md)을 따른다.
