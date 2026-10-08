# @j-auth/contracts

`SERVICE_CATALOG`가 서비스·역할 정의의 원본입니다. 패키지는 tenant/realm 도우미, OIDC·토큰 정책 상수, 관리 API 경로·DTO·오류 계약을 제공합니다. 동적 경로는 인코딩하며 빈 값, 제어 문자, `.`·`..` segment를 거절합니다.

이 패키지는 계약과 순수 함수만 제공하며 API 서버, 서비스 키 인증, OIDC/JWKS 조회, 토큰 검증을 구현하지 않습니다. `npm run build:contracts`로 빌드합니다. 런타임 의존성은 없습니다.
