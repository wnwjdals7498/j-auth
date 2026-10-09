# Task 25 AU-09 로그인 테마 검증

`themes/jgw/login`은 Keycloak v2 기본 구조·폼·오류 표시를 상속하고 공통 UI의
색상·간격·표면·키보드 focus 토큰을 적용한다. Compose는 테마를 읽기 전용으로
연결한다. 기존 `loginTheme=jgw` realm 설정을 사용하며 인증 정책은 변경하지 않는다.

Node 22.18.0·24.19.0에서 각각 package `check`, 실제 Auth 통합시험 74개,
실제 Chromium 테마 시험이 통과했다. 테마 시험은 고유한 임시 tenant realm을
생성해 CSS 200·실제 렌더링·360px/1440px 경계·키보드 focus를 검사하고 그 realm만
삭제한다. 기존 realm·사용자는 수정하지 않는다. 브라우저의 fixture GET은 지정된
Keycloak origin에만 CA 검증한 실제 요청으로 전달한다. 테마 시험에서는 로그인
자격 증명을 제출하지 않으며 실제 로그인 회귀는 별도의 Auth 통합시험 근거다.

명령은 외부 isolated fixture env를 지정한 `node --env-file=<env> --test
tests/ui/login-theme.browser.integration.test.mjs`다. 저장소의 `@playwright/test`
1.63.0을 고정하고 [Playwright BrowserType API](https://playwright.dev/docs/api/class-browsertype)의
소유 profile 방식을 사용했다. operating CA trust는 변경하지 않았다.

로그는 `/workspace/.suite-runtime/j-groupware/`의
`task25-auth-check-final22.log/.exit`, `task25-auth-check-final24.log/.exit`,
`task25-auth-integration-final22.log/.exit`, `task25-auth-integration-final24.log/.exit`,
`task25-auth-theme-final22.log/.exit`, `task25-auth-theme-final24.log/.exit`다.
모두 exit 0이다. 초기 DNS·PKCE fixture·브라우저 profile 실패 증거는 보존했다.

운영 배포 및 실제 Hyper-V VM 인수는 실행하지 않았다. 잘못된 project 이름으로
생성돼 시작하지 못한 두 fixture container는 상태를 기록하고 제거했으며,
기존 `j-auth-cloud-test`의 Keycloak fixture만 정확한 Compose 설정으로 재생성했다.
PostgreSQL fixture는 재생성하지 않았다.
