# Keycloak realm 생성기

`j-auth`에서 실행합니다.

```powershell
node scripts/realm/generate.mjs customer acme-branch j-mail j-talk
node scripts/realm/generate.mjs sample tenant-sample-a
node scripts/realm/generate.mjs sample-plan sample-c
node scripts/realm/generate.mjs sample-plan operator
```

역할·client·audience·tenant 검증·토큰 정책은 `@j-auth/contracts`에서만 가져옵니다. `sample-a/b`는 전체 서비스, `sample-c`는 기본 서비스만 포함하며 기본 계정은 6개입니다. 자동 생성 고객은 Direct Access Grants를 끕니다. 로그인 client에는 PKCE S256, tenant·roles·audience mapper와 `preferred_username` mapper를 설정합니다.

비밀값은 Keycloak import용 `${JGW_...}` 환경변수 참조로만 출력합니다. 생성기는 `.env`나 환경값을 읽지 않습니다. `plan`과 `sample-plan`은 필요한 **키 이름만** 나열하고, 값이 해결되지 않았으며 import하지 않았다고 표시합니다.

## FGAP와 검증 경계

`adminPermissionsEnabled: true`만으로 권한 설정이 끝난 것은 아닙니다. 생성 계획은 실제 UUID별 권한 요청을 제시하지만, 아직 적용·실측하지 않았습니다. `j-auth-admin`에는 `manage-users`나 `view-clients` 같은 realm-management 역할을 부여하지 않습니다. client secret 접근, 사용자·세션 작업, 역할 allowlist, provisioner 및 master realm 권한은 Keycloak에서 확인해야 합니다.

이번 Node 검사에서는 JSON 구조, contracts 기반 role/audience, 환경 placeholder, 입력 경계와 `preferred_username` mapper 구성을 확인했습니다. 실제 claim 발급, Keycloak import, FGAP 동작은 검증하지 않았습니다. 회사 노트북에 Keycloak이나 Docker를 설치·기동하지 않았습니다.

이번 검사에 사용한 `packages/contracts/dist/index.js` SHA-256은 `CEA88DD44C9A89E3782E272BEAE18B03EB42F2064503D3449763DDD422C0FA8F`입니다. 이는 검사 시점의 기록이며 현재 소스와 계속 일치한다는 보장은 아닙니다.

공식 근거: [Keycloak 26.8 관리 안내](https://www.keycloak.org/docs/26.8.0/server_admin/), [realm import 환경 placeholder](https://www.keycloak.org/server/importExport#using-environment-variables-within-the-realm-configuration-files), [UserPropertyMapper.java](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/protocol/oidc/mappers/UserPropertyMapper.java), [ProtocolMapperUtils.java](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/protocol/ProtocolMapperUtils.java).
