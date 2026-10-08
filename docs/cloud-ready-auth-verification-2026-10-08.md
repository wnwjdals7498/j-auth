# AU-06·AU-25·AU-50 검증

클라우드 테스트 전용 Keycloak 26.8·PostgreSQL 18.6과 실제 Nginx 1.30.5에서 실행했다. 회사 노트북 설치, 운영 Nginx 적용, VM 인수는 수행하지 않았다.

AU-06은 실제 realm REST 설정의 access token 300초, idle 1800초, max 28800초, refresh 회수 및 재사용 0을 확인했다. 발급 JWT의 exp-iat도 300초다. 실제 refresh 교체·이전 refresh 재사용 거절과 기존 BFF의 RP/백채널 로그아웃·WSS/SSE 종료를 함께 근거로 삼는다. 시간을 8시간 기다리는 장기 운용 시험을 실행한 것은 아니다.

AU-25는 실제 회원 권한 변경·회수·삭제 후 Keycloak 세션 종료와 BFF 연결 종료, 세션 종료 장애의 부분 실패 503을 확인했다. authentication/members 21개 시험은 Node 22.18.0과 24.19.0에서 각각 통과했다. 기존 groupware BFF 전체 회귀시험은 별도 기록한다.

AU-50은 `deploy/gateway/gateway.mjs`의 프로필 기반 allowlist를 실제 Docker Nginx로 검증한다. OIDC auth/token/logout/certs/well-known/login-actions/resources 및 `/auth/*`만 upstream으로 연결한다. admin·account·health·metrics·userinfo·revoke·잘못된 trailing slash는 upstream에 도달하지 않는다. upstream TLS 인증서·SNI를 확인하며 전달 IP는 실제 연결의 주소로 덮어쓴다. 로그인·토큰 경로의 rate limit 429와 query/body/token 로그 비노출을 확인했다. gateway 4개 시험은 Node 22.18.0·24.19.0 모두 통과했다. 전체 auth integration은 Node 24에서 73/73 통과했다.

프로필은 example을 checkout 밖으로 복사해 절대 경로·인증서·포트를 지정한 뒤 `node deploy/gateway/render.mjs --profile /external/profile.json`으로 렌더한다. 출력은 checkout 밖에만 생성하며 기존 파일·symlink 출력은 거절한다. renderer가 Nginx를 설치·기동·reload하지 않는다. 운영 적용 시 Keycloak의 KC_HOSTNAME을 실제 gateway URL로 고정하고 xforwarded proxy 설정·loopback 관리 경계를 별도 확인해야 한다. 이 시험은 기존 fixture의 issuer를 유지했으므로 새 운영 hostname의 브라우저 로그인 인수를 뜻하지 않는다.

외부 증거: `/workspace/.suite-runtime/j-auth/ready-auth-node{22,24}-results.json`, `ready-gateway-node{22,24}-results.json`, `ready-auth-full-results.json`. 첫 gateway 실행은 fixture 비밀번호 환경변수 이름 오류로 1개 실패했으며 `ready-gateway-first-env-failure-*`에 보존했다. 수정 후 양쪽 Node에서 재실행한 결과를 사용한다.

구성 근거: [Nginx proxy SSL·header 공식 문서](https://nginx.org/en/docs/http/ngx_http_proxy_module.html). 이미지 digest: `sha256:9bf97bd7714f5e24c1ccd545ecb9eb5435cb6d109c97cebb15e7e455e0239edb`.
