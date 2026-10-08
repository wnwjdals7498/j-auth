# 클라우드 인증 구현·검증 기록

2026-10-08, 클라우드 `/workspace`에서 수행했다. 시작 시 원격 main을 fetch하여 j-auth `35f53d7`, j-groupware `a61f58e`, j-customer-auth-db `9d239d2`와 체크아웃이 일치하고 기존 변경이 없는 것을 확인했다. j-auth·j-groupware의 작업 브랜치는 `codex/cloud-auth-foundation-20261008`이다. 회사 노트북 설치·기동은 하지 않았다. 원격 push·PR·merge·배포도 수행하지 않았다.

## 구현 범위

- `apps/server`: HTTPS Fastify 서버, 환경 검증, migration·readiness·정상 종료, 활성 tenant와 회원 관리 API.
- `deploy/migrations/001-tenant-control-plane.sql`: tenant 생성 중·사용·실패 상태, 서비스 키 해시와 교체 유효 기간, client·role UUID와 외래키. transaction advisory lock과 checksum 검사로 migration 중복·변경을 보호한다.
- `packages/token-verifier`: RS256·issuer·azp·aud·tenant·필수 claim 검증, 제한된 role namespace, bounded JWKS cache·새 kid 조회, 무효 토큰과 연결·HTTP·JSON 장애 구별.
- `apps/server/src/security`: Bearer+tenant/console 서비스 키 인증, SHA-256 digest의 상수 시간 비교, 등록되지 않은 tenant와 잘못된 키를 JWKS 접근 전에 거절.
- `apps/server/src/keycloak`: master 자격으로 admin/provisioner secret을 메모리에만 읽는 코드, FGAP v2 정책 설정 함수, realm 전용 회원 관리·허용 role·세션 종료.
- `scripts/realm/templates.mjs`: 실제 발급에서 누락된 subject mapper 추가, username/password만 생성한 회원에게 profile 보완을 강제하지 않도록 사용자 profile 수정.
- `scripts/prepare-cloud-test-runtime.mjs`, `scripts/run-integration.mjs`, `tests/server`, `tests/integration`: 격리된 실제 DB·Keycloak 테스트 및 재현 명령.

회원 API는 목록·추가·삭제·role 부여/회수·grantable role 조회를 구현했다. 가입 서비스 밖의 role과 신분·관리 role은 부여할 수 없다. 쓰기에 포함된 읽기 권한과 직접 부여한 읽기 권한을 구별해 회수한다. 자기 자신·tenant 관리자·service account는 삭제하지 않는다. 중복 username은 409, 권한 거절은 403, 타 realm·service account 대상은 비노출 404다. 권한 변경 성공 후 세션 종료가 실패하면 부분 실패 503을 반환한다.

## 환경과 재현

Node `24.19.0`, npm `11.9.0`, Docker `28.4.0`, Compose `2.40.3`을 사용했다. 앱 지원 기준은 Node `>=22.18.0`이며 이번 실행은 Node 24에서 했다. 의존성·lockfile과 실제 이미지 태그를 고정했다.

| 이미지 | 실행 digest |
| --- | --- |
| `postgres:18.6-bookworm` | `sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c` |
| `quay.io/keycloak/keycloak:26.8.0` | `sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc` |

Compose project는 `j-auth-cloud-test`다. PostgreSQL·TLS·env·import·JSON 결과는 checkout 밖 `/workspace/.suite-runtime/j-auth`에 보관했다. 환경 파일은 0600으로 생성하고 기존 파일을 덮어쓰지 않는다. OS hosts·CA 저장소를 바꾸지 않고 테스트 전용 resolver와 CA를 사용한다. TLS 검증을 끄지 않았다. 호스트 포트는 전부 `127.0.0.1`: PostgreSQL 54230, Keycloak HTTPS 58443, management 59000, 테스트 중 앱 HTTPS 54231이다.

```bash
npm ci --cache /workspace/.cloud-setup/cache/npm
npm run prepare:cloud-tests
docker compose --env-file ../.suite-runtime/j-auth/compose.env \
  -f deploy/compose.yaml -f ../.suite-runtime/j-auth/compose.integration.yaml \
  -p j-auth-cloud-test up -d
npm run check
npm run test:integration:db
npm run test:integration -- --reporter=json \
  --outputFile=/workspace/.suite-runtime/j-auth/integration-results.json
npm pack --dry-run --workspace=@j-auth/token-verifier
```

재현 명령의 prepare는 **새 disposable 클라우드 runtime에만** 실행한다. 기존 runtime을 교체하는 명령은 포함하지 않는다. PostgreSQL 컨테이너 재시작 후 전체 통합 검사를 다시 실행했다. 컴파일된 서버도 두 차례 기동·정상 종료했다. 초기 import에서 발견한 template 오류는 이번 작업의 테스트 데이터만 별도 보관한 뒤 새 runtime으로 수정본을 확인했다.

## 검사 결과

| 검사 | 결과 | 실제 연결 |
| --- | --- | --- |
| 기존 contracts·realm·runtime Node 검사 | 18 통과 | 없음 |
| RSA·claim·키·설정 및 JWKS HTTP/JSON 장애 단위 검사 | 30 통과 | 로컬 암호 연산; 장애 응답만 단위 fixture |
| TypeScript 빌드·테스트 타입 검사, ESLint, Prettier | 통과 | 없음 |
| DB integration | 10 통과 | PostgreSQL TCP |
| 인증·토큰 integration | 11 통과 | Keycloak + j-auth HTTPS |
| FGAP admin integration | 5 통과 | Keycloak Admin REST |
| 회원 API integration | 8 통과 | PostgreSQL + Keycloak + 실제 API handler |
| 최소 realm 생성 자격 integration | 1 통과 | Keycloak Admin REST |
| 컴파일 서버 프로세스 integration | 1 통과 | 실제 HTTPS 프로세스·DB·Keycloak |
| 공유 검증 패키지 dry-run pack | 통과 | registry 게시 없음 |

통합 36개는 실패·skip·pending 없이 통과했다. 합계 84개 검사가 통과했지만 제품군 전체 인수 완료를 의미하지 않는다. DB 전용 명령은 Keycloak 없이도 실행할 수 있다. 통합 runner는 외부 환경이 없을 때 성공이나 skip으로 처리하지 않고 실패 종료한다.

실제로 확인한 경계는 다음과 같다.

- `jauth`·`keycloak` 계정은 자기 DB에 접속하고 상대 DB·`postgres` 접속은 SQLSTATE 42501로 거절된다. superuser migration은 거절된다. 동시·반복 migration과 잘못된 tenant 활성화의 rollback을 확인했다.
- operator·sample-a/b/c 4 realm을 import하고 샘플 계정 6개의 토큰을 발급했다. 원본 토큰·tenant key 혼용과 운영사/고객 자격 혼용은 거절한다. sample-c에는 선택 서비스 audience·grantable role이 없다.
- 실제 signing key 변경 후 새 kid에 JWKS를 다시 조회했다. 잘못된 audience는 무효 토큰, 연결 단절은 검증 장애다. HTTP 오류와 잘못된 JSON의 장애 분류는 별도 단위 검사로 확인했다.
- standard token exchange로 sample-a 토큰을 `aud=j-mail` 하나로 줄이고 해당 서비스 role을 유지한다. 줄인 토큰은 회원 API audience로 사용할 수 없으며 sample-c의 미가입 j-mail 교환은 400이다.
- refresh 회전 후 사용한 refresh token 재사용은 400이며 그 세션의 새 refresh token도 400이다. role 변경·회원 삭제 뒤 이전 refresh도 거절된다. 이미 발급된 access token을 즉시 폐기한다는 의미는 아니다.
- master에서 가져온 realm secret은 tenant DB에 없다. 실제 서버 로그에서 요청 Bearer·서비스 키·DB 비밀번호·master secret이 출력되지 않는 것을 확인했다.

## FGAP v2 실측

`configureMemberAdmin` 반복 적용 후 같은 고객 `j-auth-admin` client-credentials 자격으로 실행했다. 광역 `realm-management` role은 부여하지 않았다.

| 작업 | 실제 응답 |
| --- | --- |
| 회원 생성 / 조회 | 201 / 200 |
| 회원 enabled false·true 변경 | 204 / 204 |
| 회원 세션 종료 / 삭제 | 204 / 204 |
| 허용 `board:read` role 매핑 | 204 |
| `member:manage` 매핑 | 403 |
| `tenant:admin` 매핑 | 403 |
| `realm-management/manage-users` 매핑 | 403 |
| 가입 client metadata 조회 | 200 |
| 같은 client secret 조회 | 403 |

기존 import 샘플에 연결하는 master fixture는 격리된 테스트 한정 관리 자격이다. 별도 생성 자격 검사에서는 새 master client에 `create-realm`만 부여하고 새 realm 생성 201, 자신이 생성한 realm secret 조회 200, 기존 sample-a client 접근 403을 확인했다. 따라서 fixture 광역 권한을 운영 요구 권한으로 기록하지 않는다. tenant 생성 orchestration·provisioner 최소 권한은 아직 완료하지 않았다.

## 미실행·남은 작업

브라우저 Authorization Code + PKCE, callback·화면 오류·brute-force 잠금, RP-initiated logout, BFF backchannel 수신과 세션·WSS 제거는 미실행이다. Keycloak refresh·세션 결과를 이 시험의 통과로 대체하지 않는다. 현재 j-groupware 체크아웃에 BFF `apps/server`가 없고 `docs/ui-guidelines.md`도 없어 정식 로그인 theme의 UI 기준과 수신 흐름 구현이 선행되어야 한다.

I7 가입 서비스 조회·활성화·해제 API, I8 공개 고객 realm 생성·비밀값 교체 API는 미구현이다. DB 상태·키 교체 저장 함수와 FGAP·master 생성 자격 검사만으로 완료 처리하지 않는다. registry 게시·다른 repo 실제 설치, Nginx 외부 경로/속도 제한, Hyper-V/VM·고객 서버·CPU/메모리 측정도 미실행이다. 이 환경에서 전체 외부 접근 격리를 입증하지 않았다.

`j-groupware/docs/implementation-progress.json`은 코드 구현과 실행한 검증의 범위를 별도로 기록한다. 제품군 전체 검증값은 계속 false다.
