# 서비스 가입·고객 생성 후속 클라우드 검증

2026-10-08, 기존 클라우드와 `codex/cloud-auth-foundation-20261008` 브랜치에서 계속 구현했다. 회사 노트북 작업은 수행하지 않았다. 실제 운영 고객·계정·자격 증명은 변경하지 않았다. 신규 realm·관리자·비밀값은 모두 `j-auth-cloud-test` 환경에서 만든 disposable fixture이며 테스트 종료 후 정리했다.

기반 코드와 테스트는 [이전 기록](cloud-verification-2026-10-08.md)에 보존한다. 사용자 승인 이후 기반 j-auth `01a6365`, j-groupware `577853f`를 각 GitHub 작업 브랜치로 푸시했고 원격 SHA 일치를 확인했다. 해당 SHA의 Actions 실행은 없었다. 후속 검증 완료 커밋도 같은 작업 브랜치에 푸시한다. main 병합·강제 푸시·PR·배포는 수행하지 않는다.

## 구현과 실패 경계

`apps/server/src/keycloak/subscriptions.ts`와 운영사 routes에 가입 조회·활성화·해제를 구현했다. client·role·쓰기→읽기 composite·tenant 관리자 composite·login scope·role/audience mapper·FGAP·DB UUID snapshot을 맞춘다. 중복 호출은 멱등이며 실패 후 재호출이 남은 단계에 수렴한다. 해제는 FGAP 허용을 먼저 거두고 참조와 client를 삭제한다. 이전에 발급한 토큰은 그대로이고 새 발급/갱신부터 role·aud가 사라진다.

`apps/server/src/keycloak/provisioning.ts`에 고객 생성·비밀 교체를 구현했다. migration 002는 생성 소유권 UUID와 bootstrap username만 추가한다. 생성 API는 공유 CLI template에서 시작하고 runtime secret placeholder를 제거하여 Keycloak이 새 값을 만들게 한다. 활성화 직전에 서비스 키를 만들고 DB에는 해시만 저장한다. 기존 realm의 소유권 표식이 다르면 인수하지 않는다. 실패 상태 재개는 같은 bootstrap username만 허용하며 이미 만든 관리자 비밀번호를 재설정하지 않는다. 사용 상태 재호출은 409이며 비밀값을 재전송하지 않는다.

DB session advisory lock으로 생성·가입·교체를 tenant별로 직렬화한다. 동시 작업은 409다. Keycloak 변경과 DB write 사이에는 분산 transaction이 없으므로 실패를 숨기지 않는다. 가입 snapshot은 전체 단계 성공 뒤에만 transaction으로 갱신한다. 활성화 DB 실패는 rollback하고 tenant는 실패 상태로 남는다.

서비스 키는 300초 동안 이전/새 해시 두 개를 허용한다. 기간 중 추가 교체는 409이며 만료 뒤 재교체가 가능하다. OIDC client secret은 즉시 교체되며 이전 값은 거절된다. Keycloak 응답 확인 불가와 Keycloak 성공 후 DB 실패를 각각 부분 결과가 드러나는 503으로 반환한다. 교체 응답 유실 뒤 DB에 두 해시가 적용된 경우에는 overlap 종료 후 다시 교체해야 한다.

## 실제 최소 권한

가입 변경은 realm의 `j-auth-provisioner` 자격만 사용한다. 실측 매핑은 `manage-clients`·`manage-realm` 두 역할이다. `view-clients`를 별도로 부여하지 않았다. 각 역할을 하나씩 회수한 뒤 해당 관리 작업이 403임을 확인했다. 다른 realm client와 사용자 생성도 403이다. 이 자격은 해당 realm client/설정을 관리하는 광역 권한이며, 회원 admin 자격의 secret 비조회 보장을 의미하지 않는다.

고객 생성·교체 suite는 master `create-realm`만 가진 새 test client를 사용했다. 전역 master `admin`을 부여하지 않았다. 새 realm의 관리 역할은 생성 시 provisioner service account import에서 초기화한다. 생성 후 protected 관리 역할 매핑을 시도하면 FGAP v2에서 403이므로 이 역할을 일반 회원 매핑으로 우회하거나 전역 admin fallback을 넣지 않았다. 참고하는 고정 버전 원본은 [FGAP v2 role 검사](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/services/resources/admin/fgap/RolePermissionsV2.java)다. 생성 자격의 범위는 [Keycloak 26.8 master 접근 안내](https://www.keycloak.org/docs/26.8.0/server_admin/)와 실제 테스트를 함께 따른다.

가입된 새 고객에서도 HTTP Authorization Code + PKCE 로그인 → 관리 API → 서비스 활성화 → 새 role/aud 발급 → 해제 → 새 role/aud 제거를 확인했다. 자동 생성 고객의 password grant는 계속 꺼져 있다. PKCE 누락은 등록 callback으로 `error=invalid_request` redirect하며 code를 주지 않는다. 잘못된 redirect URI도 거절된다. Playwright·정식 로그인 theme와 BFF callback의 인수 시험은 수행하지 않았다.

## 명령과 검사 수

기존과 동일한 Node 24.19.0, Keycloak 26.8.0, PostgreSQL 18.6-bookworm 및 checkout 밖 `/workspace/.suite-runtime/j-auth`를 사용했다. TLS 검증·loopback 바인딩을 유지했고 OS hosts·CA 저장소를 변경하지 않았다. 재현 준비는 [서버 개발](server-development.md)을 따른다.

```bash
npm run check
npm run test:integration -- --reporter=json \
  --outputFile=/workspace/.suite-runtime/j-auth/integration-results-phase2.json
```

| 명령·suite | 최초 기반 | 후속 최종 | 관찰 범위 |
| --- | --- | --- | --- |
| `npm run check`: contracts Node | 9 | 9 | catalog·claim·경로 계약 |
| `npm run check`: runtime Node | 1 | 1 | 외부 env/TLS·DB 설정 |
| `npm run check`: realm Node | 8 | 8 | 구조·미해결 placeholder·plan |
| `npm run check`: `tests/server/security.test.ts` | 30 | 30 | 실제 RSA·claim·서비스 키·설정·JWKS 장애 분류 |
| `tests/integration/database.test.ts` | 10 | 11 | 실제 TCP DB 격리·migration·checksum 변조 거절·rollback |
| `tests/integration/authentication.test.ts` | 11 | 11 | 실제 HTTPS claim/JWKS/교환/refresh |
| `tests/integration/admin-permissions.test.ts` | 5 | 5 | 실제 FGAP 허용·거절 |
| `tests/integration/members.test.ts` | 8 | 8 | 회원 lifecycle·tenant·권한·예약 namespace |
| `tests/integration/realm-creator.test.ts` | 1 | 1 | create-realm 최소 자격과 기존 realm 거절 |
| `tests/integration/main-process.test.ts` | 1 | 1 | 컴파일 HTTPS 프로세스·생성/교체·재시작·로그 비노출 |
| `tests/integration/subscriptions.test.ts` | — | 10 | 가입·해제·멱등·실패 재개·tenant 격리·최소 자격·잠금 |
| `tests/integration/provisioning.test.ts` | — | 14 | 생성·1회 응답·PKCE·가입 연결·소유권·부분 실패·교체 |

따라서 최초 보고의 **48개는 `npm run check`의 Node 18 + Vitest 30**, **36개는 최초 6개 integration suite**다. 후속 최종은 동일한 48개와 integration 61개, 합계 109개이며 실패·skip·pending은 0이다. build·테스트 TypeScript typecheck·ESLint·Prettier도 통과했다. 최초 JSON `integration-results.json`은 36개 증거로 보존하고 후속 JSON은 별도 파일에 저장했다. 문서의 인수 시험 정의 60개/제품군 정의 9개는 실행 테스트 수에 더하지 않는다. 제품군 기능 추적표는 172개 중 구현 20개·부분 6개·미착수 146개이며 `whole_suite_verified=false`다. 기능/Item/문서 링크 검사도 통과했으며 이 결과는 문서 검증이다.

추가로 확인한 실패/격리 경계는 다음과 같다.

- 실제 read-only 운영사 계정의 조회·생성·가입·해제·교체는 403이며 tenant 상태를 변경하지 않는다. 고객 토큰·tenant key를 운영사 API에 혼용하면 401이다.
- 가입 scope mapping, client 삭제, 생성 realm/FGAP, 교체 endpoint에 **테스트 transport에서 503을 주입**했다. 이전·이후 단계와 재개는 실제 Keycloak을 사용하며 이 주입을 실제 서버 outage 실측으로 부풀리지 않는다.
- PostgreSQL trigger로 활성화·키 교체 write를 실패시켜 실제 transaction rollback과 Keycloak 성공/DB 실패의 부분 결과를 확인했다. trigger/function은 finally에서 제거했다.
- 새 tenant secret/서비스 키/관리자 비밀번호를 j-auth DB에 저장하지 않고, 실제 컴파일 서버 로그에도 출력하지 않는다. 다른 tenant secret·서비스 키·가입 snapshot은 변경하지 않는다.
- 테스트 cleanup은 자신이 만든 realm·tenant·사용자·creator client만 제거한다. 샘플-c의 추가 서비스는 각 가입 검사 뒤 기본 상태로 되돌린다.

## 남은 범위

정식 로그인 theme·화면/브라우저 Playwright·brute-force 잠금, BFF callback·RP logout/backchannel·세션/WSS 제거, 운영 콘솔 호출·고객 서버 bootstrap, Nginx 외부 차단·속도 제한·VM/자원 측정은 아직 미실행이다. j-groupware BFF와 `docs/ui-guidelines.md` 부재를 다른 backend 코드/격리 테스트의 차단으로 취급하지 않았다. registry 게시와 다른 repo의 실제 패키지 설치도 미실행이다. 제품군 전체 검증 완료로 기록하지 않는다.
