# 개발 runtime 준비

Compose 구성은 Keycloak `26.8.0` (`quay.io/keycloak/keycloak:26.8.0`)과 PostgreSQL `18.6-bookworm`으로 고정했습니다. Keycloak 26.8은 PostgreSQL 18을 지원합니다. [Keycloak 이미지](https://www.keycloak.org/getting-started/getting-started-docker), [Keycloak DB 지원](https://www.keycloak.org/server/db), [26.8 업그레이드 안내](https://www.keycloak.org/docs/26.8.0/upgrading/), [PostgreSQL 18.6 출시](https://www.postgresql.org/about/news/postgresql-186-1711-1615-1519-1424-and-19-beta-3-released-3365/)

PostgreSQL 데이터는 `github/.suite-runtime/j-auth/postgres`에 두고 컨테이너의 `/var/lib/postgresql`에 연결합니다. PostgreSQL 18 공식 이미지는 `PGDATA=/var/lib/postgresql/18/docker`를 사용합니다. [PostgreSQL 공식 이미지 문서](https://github.com/docker-library/docs/blob/master/postgres/README.md#pgdata)

호스트 port는 모두 `127.0.0.1`에만 bind합니다. 기본값은 Keycloak HTTPS `8443`, management `9000`, PostgreSQL `54230`이며 env 파일에서 바꿀 수 있습니다. 결정에 따라 `3001`만 예약 port로 금지합니다. 공개 issuer는 고정된 `.jgw.test` HTTPS URL입니다. 로컬 직접 개발은 `https://auth.jgw.test:8443`, Nginx가 443을 받는 구성이면 `https://auth.jgw.test`를 씁니다. Keycloak은 `KC_HOSTNAME`과 `xforwarded` proxy header를 사용합니다. 실제 public endpoint 경로는 뒤에 놓이는 Nginx가 제한합니다. [Keycloak hostname 설정](https://www.keycloak.org/server/hostname), [management interface](https://www.keycloak.org/server/management-interface)

PostgreSQL 한 인스턴스 안에 `keycloak`과 `jauth` database를 만들고 각각 `keycloak`과 `jauth` login role이 소유합니다. 초기화 SQL은 접속 가능한 database에서 `PUBLIC`의 `CONNECT`와 `TEMPORARY`를 회수한 뒤 각 계정에 자기 database 권한만 줍니다. Password는 psql 인수나 SQL source에 넣지 않고, Postgres 공식 `\getenv` 방식으로 환경에서 읽습니다. 초기화 script는 **비어 있는 데이터 디렉터리에서 한 번만** 실행됩니다. 이미 만들어진 volume에 설정을 고친다고 다시 적용되지는 않습니다. [PostgreSQL REVOKE](https://www.postgresql.org/docs/18/sql-revoke.html), [psql `\getenv`와 `\gexec`](https://www.postgresql.org/docs/18/app-psql.html), [공식 이미지 초기화 동작](https://hub.docker.com/_/postgres)

실제 Compose env, TLS certificate/key, PostgreSQL 데이터는 checkout 밖 `github/.suite-runtime/j-auth`에 둡니다. [`deploy/.env.example`](../deploy/.env.example)은 복사용 template이며 placeholder만 담습니다. I1 Compose env의 `KC_BOOTSTRAP_ADMIN_USERNAME/PASSWORD`는 최초 master realm 개발 설정입니다. I3 j-auth 애플리케이션 환경은 별도 범위이며 결정 5의 master realm 생성 자격은 checkout 밖 j-auth env에 둡니다. 이후 realm 생성용 `j-auth-realm-creator`는 그 자격으로 쓰는 별도 service account입니다. 고객 realm별 `j-auth-admin`·`j-auth-provisioner` secret은 Keycloak에서 읽어 메모리에만 보관하고 env나 database에 쓰지 않습니다.

검사 명령은 실제 서비스와 연결하지 않습니다.

```powershell
node scripts/runtime-config.mjs
node scripts/runtime-config.mjs --env-file ..\.suite-runtime\j-auth\compose.env
node --test tests/config/runtime-config.test.mjs
node scripts/check.mjs --contracts-only
```

이번 회사 노트북 작업에서는 OS package 설치, Docker/Compose 설정 적용·서비스 기동, 실제 PostgreSQL 계정·`PUBLIC CONNECT`·cross-database 권한, Keycloak 접속·FGAP를 검증하지 않았습니다. Node 테스트는 OS 임시 폴더의 synthetic env와 임시 TLS key pair만 사용합니다. VM에서 실제 database 권한 경계를 확인해야 합니다.
