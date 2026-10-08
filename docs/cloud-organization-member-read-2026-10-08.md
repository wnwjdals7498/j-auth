# 조직도용 최소 회원 읽기 — 2026-10-08

G15 조직도 등록/복구는 실제 같은 tenant 회원인지 확인해야 한다. 이를 위해 기존 contracts의 `AUTH_API_PATHS.member(id)` 경로에 `GET /auth/members/:id`를 구현했다. 입력·서비스 키·tenant·원래 `j-groupware` Bearer 검증은 기존 기준을 유지한다.

읽기만 `member:manage` 또는 `org:manage`를 허용한다. 응답은 `MemberResponse`의 `id`, `username`, `enabled`만 선택한 구조이며 role·비밀번호·Keycloak 개인정보를 반환하지 않는다. 다른 tenant와 보호된 service-account 대상은 404다. 기존 목록·생성·삭제·역할 API는 계속 `member:manage`를 요구한다. 조직도 편집자에게 그 권한이나 Keycloak 관리 자격을 부여하지 않는다.

`npm run check`의 기존 정적/단위 48개·build·타입·lint·format이 통과했다. 실제 Keycloak/PostgreSQL 통합은 기존 61개와 새 2개를 함께 실행해 **63/63**, 실패 0·미실행 0이다. 새 시험은 실제 org-only 회원을 생성해 로그인 token을 받고 최소 필드 읽기, 기존 회원 API 거절, 역할 없는 읽기 거절, foreign id·다른 tenant/누락 서비스 키 거절을 확인했다.

결과는 체크아웃 밖 `/workspace/.suite-runtime/j-auth/integration-results-phase5.json`, `phase5-check.log`에 보관한다. 격리 클라우드만 사용했으며 회사 노트북 설치·운영 계정/고객 변경·배포는 하지 않았다. 전체 제품군/화면/VM 인수가 완료됐다는 뜻은 아니다.
