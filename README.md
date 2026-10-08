# j-auth

Keycloak 기반 인증과 회원·서비스 가입 관리 API를 위한 프로젝트입니다.

공유 contracts와 토큰 검증 패키지, HTTPS 서버·tenant DB, 제한된 회원 관리, 서비스 가입 관리, 고객 생성·비밀 교체 API를 구현했습니다. 클라우드의 실제 Keycloak·PostgreSQL로 검증했으며 전체 브라우저·BFF·VM 인수 시험은 아직 완료하지 않았습니다. 회사 노트북에서 시스템 설치·Docker 기동은 하지 않습니다.

설치 후 검사: `npm ci` → `npm run check`. 실제 서비스 검사는 `npm run test:integration`으로 분리합니다. [서버 실행·테스트](docs/server-development.md), [기반 검증 기록](docs/cloud-verification-2026-10-08.md), [가입·고객 생성 검증 기록](docs/cloud-provisioning-verification-2026-10-08.md), [기능 명세](docs/feature-specifications.md), [realm 생성](docs/realm-templates.md), [runtime 설정](docs/development-runtime.md).

Part of the j-groupware suite. See `j-groupware/docs/architecture.md`.
