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

tenant 활성화는 예약 → 실제 realm/client/role 구성 → `activate` 순서다. DB에는 상태, 서비스 키 SHA-256 해시, 내부 UUID, 생성 소유권 UUID와 bootstrap username만 저장한다. 샘플은 테스트 fixture가 등록하고 새 고객은 운영사 생성 API가 등록한다. 환경 자격이나 DB에 adminPassword·realm별 client secret·serviceKey 원문을 복제하지 않는다.

회원 API는 Bearer와 `X-JGW-Service-Key`, 활성 tenant, `member:manage`를 모두 확인한다. grantable roles는 가입 서비스와 catalog의 교집합이다. 회원 추가의 `roles`는 필수 배열이며 선택 권한이 없으면 `[]`를 보낸다. `service-account-` username 접두사는 예약한다. 직접 부여분만 회수하고 자기 자신·tenant 관리자·service account는 삭제하지 않는다. 권한 변경 후 세션 종료 실패는 부분 실패 503으로 명시한다.

realm별 admin/provisioner secret은 master의 전용 service account로 조회하고 메모리에만 보관한다. 실제 사용자 변경은 해당 realm의 `j-auth-admin` 자격만 사용한다. `configureMemberAdmin`은 생성 시 적용할 FGAP v2 설정 함수이며 서버 요청에 master 권한 우회 처리를 넣지 않는다. 기존 수동 import realm은 생성 자격의 소유 realm이 아니므로 별도 bootstrap 권한 설정이 필요하다.

## 운영사 API

운영사 Bearer(`azp=j-console`, `aud=j-console`, `customer:write`)와 콘솔 키가 모두 필요하다. path tenant는 대상 고객이며 호출자의 `operator` claim과 혼동하지 않는다.

- `GET /auth/tenants/{tenant}/services`: 실제 Keycloak client 상태에서 가입 목록을 읽는다.
- `PUT`/`DELETE /auth/tenants/{tenant}/services/{service}`: 선택 서비스 활성화·해제. 기본 서비스와 운영사·모르는 service는 400, 활성 등록이 없는 tenant는 404다.
- `POST /auth/tenants`: `{tenantId, adminUsername, adminPassword}` → 생성 완료 201 및 `{clientSecret, serviceKey}` 1회 응답. 사용 상태 재호출은 409다.
- `POST /auth/tenants/{tenant}/rotate-secrets`: 새 `{clientSecret, serviceKey}` 1회 응답. 동일 서비스 키 overlap 중에는 409다.

가입 변경은 해당 realm의 provisioner 자격만 사용하고 중간 실패 503 후 재호출로 남은 단계에 수렴한다. 실패하면 DB snapshot은 완료 상태로 갱신하지 않는다. 조회는 partial 상태에서도 실제 client 목록을 반환하므로 실패 후에는 변경 API를 재시도해야 한다. provisioner의 실측 역할은 `manage-clients`·`manage-realm` 두 개다. 광역 권한의 범위와 검증 표는 [후속 기록](cloud-provisioning-verification-2026-10-08.md)을 따른다.

생성·가입·교체는 동일 tenant의 PostgreSQL session advisory lock으로 직렬화하며 동시 요청은 409다. 생성 소유권 UUID가 일치하는 realm만 재개한다. bootstrap username은 앞뒤 공백 제거·소문자로 정규화하며 예약 service-account 접두사를 거절한다. 재시도에서 기존 관리자 비밀번호를 재설정하지 않는다. 처음 생성할 때 provisioner service account의 두 역할을 import에 넣고, 일반 회원에게는 관리 역할을 부여하지 않는다.

키 교체의 이전/새 서비스 키 병행 기간은 300초다. 정확히 두 해시를 유지하므로 이 기간 중 추가 교체는 409이며 기간 종료 후 가능하다. OIDC client secret은 즉시 교체된다. 응답을 잃은 뒤 overlap이 시작된 경우에도 기간 종료 후 다시 교체해야 한다. Keycloak 교체 성공 뒤 DB 실패는 그 부분 결과를 503 메시지에 명시하며 DB 키는 원래 상태다. 응답을 확인할 수 없는 Keycloak 장애도 키 갱신 성공으로 처리하지 않는다.

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

기본 runtime 위치는 checkout 옆 `../.suite-runtime/j-auth`다. `JAUTH_TEST_ENV`로 checkout 밖의 다른 `integration.env`를 지정할 수 있다. Docker volumes/env/TLS/import 파일은 runtime 안에 둔다. 테스트는 `JAUTH_TEST_RUNTIME=isolated-cloud`를 요구하고 격리 샘플 realm과 자신이 만든 disposable 고객만 변경한다. 운영 환경에 테스트 env를 사용하지 않는다.

샘플은 기존에 import한 realm이므로 통합 fixture의 master client에는 bootstrap 관리 역할을 준다. 이것은 테스트 한정이다. 별도 고객 생성 검사에서는 master `create-realm`만 가진 client로 새 고객 API·Authorization Code + PKCE·가입 변경·비밀 교체를 실제로 실행하고 기존 다른 realm 접근 거절을 확인한다. 모두 disposable 테스트 고객이며 운영 계정 생성·자격 변경은 수행하지 않는다.

처음 만들 때 PostgreSQL 초기화 스크립트가 계정과 DB 권한을 설정한다. 기존 volume에는 초기화를 재실행하지 않는다. realm template 변경도 기존 import를 자동 갱신하지 않으므로 disposable test runtime으로 다시 검증해야 한다. 실제 실행 결과와 미실행 범위는 [기반 기록](cloud-verification-2026-10-08.md)과 [가입·고객 생성 후속 기록](cloud-provisioning-verification-2026-10-08.md)을 따른다.
