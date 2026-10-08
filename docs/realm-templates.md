# Keycloak realm 생성기

`j-auth`에서 실행합니다.

```powershell
node scripts/realm/generate.mjs customer acme-branch j-mail j-talk
node scripts/realm/generate.mjs sample tenant-sample-a
node scripts/realm/generate.mjs sample-plan sample-c
node scripts/realm/generate.mjs sample-plan operator
```

역할·client·audience·tenant 검증·토큰 정책은 `@j-auth/contracts`에서만 가져옵니다. `sample-a/b`는 전체 서비스, `sample-c`는 기본 서비스만 포함하며 기본 계정은 6개입니다. 자동 생성 고객은 Direct Access Grants를 끕니다. 로그인 client에는 PKCE S256, subject·tenant·roles·audience·`preferred_username` mapper를 설정합니다. 사용자 profile에서 email·이름을 필수로 요구하지 않아 username·영구 초기 비밀번호만 생성한 계정도 추가 profile 입력을 요구하지 않습니다.

비밀값은 Keycloak import용 `${JGW_...}` 환경변수 참조로만 출력합니다. 생성기는 `.env`나 환경값을 읽지 않습니다. `plan`과 `sample-plan`은 필요한 **키 이름만** 나열하고, 값이 해결되지 않았으며 import하지 않았다고 표시합니다.

## FGAP와 검증 경계

`adminPermissionsEnabled: true`만으로 권한 설정이 끝난 것은 아닙니다. 생성 계획과 `apps/server/src/keycloak/admin-permissions.ts`의 설정 함수가 실제 UUID별 FGAP v2 정책을 적용합니다. 클라우드의 실제 Keycloak 26.8.0에서 사용자 생성·조회·활성 상태 변경·세션 종료·삭제와 허용 role 매핑을 확인했습니다. client metadata 조회는 허용하지만 secret 조회, `member:manage`·`tenant:admin`·`manage-users` 매핑은 거절합니다. `j-auth-admin`에 `manage-users`나 `view-clients` 같은 광역 realm-management 역할을 주지 않습니다. 전체 결과 표는 [클라우드 검증 기록](cloud-verification-2026-10-08.md)에 있습니다. provisioner 최소 권한과 공개 tenant 생성 API는 후속 구현입니다.

초기 회사 노트북 작업은 JSON·placeholder·mapper의 Node 검사까지만 수행했습니다. 이후 클라우드에서 4개 realm import, 실제 claim 발급, token exchange, refresh 재사용, FGAP 및 회원 API를 검증했습니다. 회사 노트북 설치·기동 제한은 그대로 유지합니다. 로그인 테마·브라우저 PKCE·BFF 수신과 VM 검증은 미실행입니다.

초기 Node 검사에 사용한 `packages/contracts/dist/index.js` SHA-256은 `CEA88DD44C9A89E3782E272BEAE18B03EB42F2064503D3449763DDD422C0FA8F`입니다. 이는 당시 검사 기록이며 현재 소스와 계속 일치한다는 보장은 아닙니다.

공식 근거: [Keycloak 26.8 관리 안내](https://www.keycloak.org/docs/26.8.0/server_admin/), [realm import 환경 placeholder](https://www.keycloak.org/server/importExport#using-environment-variables-within-the-realm-configuration-files), [UserPropertyMapper.java](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/protocol/oidc/mappers/UserPropertyMapper.java), [ProtocolMapperUtils.java](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/protocol/ProtocolMapperUtils.java).
