# j-auth

Keycloak 기반 인증과 회원·서비스 가입 관리 API를 위한 프로젝트입니다.

현재는 공유 contracts, realm 생성기, Compose·DB 분리 설정의 준비 코드입니다. Node 빌드·단위·정적 검사와 실제 Keycloak·PostgreSQL 검증을 구별하며, 회사 노트북에서 시스템 설치·Docker 기동은 하지 않습니다.

검사: `npm run check`. 새 의존성 설치 없이 기존 workspace의 TypeScript·YAML 도구를 재사용할 수 있습니다. [기능 명세](docs/feature-specifications.md), [realm 생성](docs/realm-templates.md), [실행 설정과 검증 한계](docs/development-runtime.md).

Part of the j-groupware suite. See `j-groupware/docs/architecture.md`.
