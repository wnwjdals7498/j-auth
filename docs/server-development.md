# j-auth 서버 개발·실행

Node.js 22.18 이상, npm workspace를 사용한다. 서버는 Fastify, PostgreSQL 드라이버는 pg, RS256/JWKS 검증은 jose를 사용한다. `apps/server`는 내부 앱이고 공유 검증 코드는 `packages/token-verifier`에 있다.

```bash
npm ci
npm run check
npm run build
```

`check`는 contracts·realm·runtime Node 검사, TypeScript 빌드와 테스트 타입 검사, 암호 검증 단위 테스트, ESLint·Prettier 검사다. 실제 DB·Keycloak은 연결하지 않는다. 통합 검사는 별도 명령으로 실행하며 환경이 없으면 실패로 종료한다.

## 서버 환경

[`deploy/server.env.example`](../deploy/server.env.example)을 checkout 밖에 복사해 채운다. TLS 인증서·개인키도 checkout 밖의 절대 경로다. 환경 파일·Keycloak realm별 secret을 Git에 넣지 않는다. DB는 `jauth` 계정과 `jauth` database를 강제하며 migration은 superuser 연결을 거절한다.

```bash
node --env-file=../.suite-runtime/j-auth/server.env apps/server/dist/db/migrate-cli.js
node --env-file=../.suite-runtime/j-auth/server.env apps/server/dist/main.js
```

서버 시작 시 migration도 실행한다. transaction advisory lock과 적용 파일 checksum으로 동시 실행·수정된 migration을 보호한다. listener는 `127.0.0.1`, 기본 port는 `54231`이며 HTTPS만 사용한다. SIGINT/SIGTERM에서 listener와 DB pool을 닫는다. `/health/live`는 프로세스, `/health/ready`는 DB 연결을 확인한다. Keycloak 상태는 readiness에 포함하지 않는다.

tenant 활성화는 `TenantStore.reserve` → 실제 realm/client/role 구성 → `activate` 순서다. DB에는 상태, 서비스 키 SHA-256 해시와 내부 UUID만 저장한다. 현재 운영사 provisioning API는 없으므로 테스트 fixture가 샘플 tenant를 등록한다. 서비스 키 교체용 저장 함수는 존재하지만 공개 교체 API는 아직 없다.

회원 API는 Bearer와 `X-JGW-Service-Key`, 활성 tenant, `member:manage`를 모두 확인한다. grantable roles는 가입 서비스와 catalog의 교집합이다. 회원 추가의 `roles`는 필수 배열이며 선택 권한이 없으면 `[]`를 보낸다. `service-account-` username 접두사는 예약한다. 직접 부여분만 회수하고 자기 자신·tenant 관리자·service account는 삭제하지 않는다. 권한 변경 후 세션 종료 실패는 부분 실패 503으로 명시한다.

realm별 admin/provisioner secret은 master의 전용 service account로 조회하고 메모리에만 보관한다. 실제 사용자 변경은 해당 realm의 `j-auth-admin` 자격만 사용한다. `configureMemberAdmin`은 생성 시 적용할 FGAP v2 설정 함수이며 서버 요청에 master 권한 우회 처리를 넣지 않는다. 기존 수동 import realm은 생성 자격의 소유 realm이 아니므로 별도 bootstrap 권한 설정이 필요하다.

## 격리된 클라우드 통합 검사

회사 노트북에서 시스템 설치·Docker 기동을 하지 않는다. 다음 명령은 새 클라우드 테스트 환경용이며 기존 자격 파일이 있으면 덮어쓰지 않는다. OS hosts나 CA 저장소 변경 없이 테스트 전용 DNS resolver와 CA를 사용한다.

```bash
npm run prepare:cloud-tests
docker compose --env-file ../.suite-runtime/j-auth/compose.env \
  -f deploy/compose.yaml -f ../.suite-runtime/j-auth/compose.integration.yaml \
  -p j-auth-cloud-test up -d
npm run test:integration:db
npm run test:integration
```

기본 runtime 위치는 checkout 옆 `../.suite-runtime/j-auth`다. `JAUTH_TEST_ENV`로 checkout 밖의 다른 `integration.env`를 지정할 수 있다. Docker volumes/env/TLS/import 파일은 runtime 안에 둔다. 테스트는 `JAUTH_TEST_RUNTIME=isolated-cloud`를 요구하고 샘플 realm만 변경한다. 운영 환경에 테스트 env를 사용하지 않는다.

샘플은 기존에 import한 realm이므로 통합 fixture의 master client에는 bootstrap 관리 역할을 준다. 이것은 테스트 한정이다. 별도 검사는 master `create-realm`만 가진 새 client가 만든 realm의 secret을 읽고 기존 다른 realm 접근은 거절되는 것을 확인한다. 운영 tenant 생성 및 최소 provisioner 권한 검증을 대체하지 않는다.

처음 만들 때 PostgreSQL 초기화 스크립트가 계정과 DB 권한을 설정한다. 기존 volume에는 초기화를 재실행하지 않는다. realm template 변경도 기존 import를 자동 갱신하지 않으므로 disposable test runtime으로 다시 검증해야 한다. 실제 실행 결과와 미실행 범위는 [클라우드 검증 기록](cloud-verification-2026-10-08.md)을 따른다.
