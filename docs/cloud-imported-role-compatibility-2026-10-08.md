# imported sample 역할 소유자 호환 수정 (2026-10-08)

메일 E3의 신규 tenant 통합 성공과 달리 기존 imported sample-a의 mail:read 회원 생성은 scoped Keycloak 요청403→j-auth503이었다. 기존 realm의 FGAP·role·scope·자격을 바꾸지 않고 원인을 재현하고 수정했다.

## 두 코드 결함과 확인된 인과

1. 고객 realm generator의 clientScopeMappings 방향이 뒤집혀 있었다. map key는 역할 소유 client이고 각 entry.client는 scope 소비 client다. 기존 출력은 j-groupware를 key로 하고 각 선택 서비스를 entry.client로 두었다. [Keycloak26.8 실제 import 구현](https://github.com/keycloak/keycloak/blob/26.8.0/model/storage-private/src/main/java/org/keycloak/storage/datastore/DefaultExportImportManager.java)은 key client에 없는 이름을 만나면 역할을 추가한다. 그래서 j-groupware에도 mail:read 등 잘못된 alias가 생겼다. source template은 이제 서비스별 key에 로그인 client를 소비자로 둔다. 기존 realm은 재import·정리하지 않았다.
2. TenantStore.roleMapping은 tenant+role_name만 검색하고 첫 행을 택했다. sample-a 실제 DB에 j-groupware/mail:read와 j-mail/mail:read 둘이 있었고 이전 코드는 j-groupware를 선택했다. 기존 FGAP는 카탈로그의 실제 j-mail role UUID만 허용하므로 틀린 alias에 대한 부여를 올바르게403으로 거절했다. permission target/DB UUID가 일치하는 것만 검사해도 이 잘못된 행 선택을 놓칠 수 있었다.

DB 조회는 카탈로그의 grantable role 소유 client_id를 함께 제한한다. canonical role이 없거나 unknown/identity/admin이면 alias fallback 없이 undefined다. DB migration·기존 role 삭제·권한 확대·새 운영 키가 필요 없다. 공개 contracts 내용/version도 바꾸거나 다시 게시하지 않았다.

## 실제 검증

| 실행 | 결과 |
| --- | --- |
| Node24.19/22.18 focused compatibility | 각각6/6, fail/skip0 |
| j-auth 전체 실제 통합 |69/69, fail/skip0 |
| j-auth 전체 check | contract9/runtime config1/realm8·서버 unit30·build/typecheck/lint/format 통과 |

6개는 기존 두 행에서 canonical UUID 선택, 기존 sample HTTPS 회원 생성201/실제 j-mail role만 부여, wrong alias가 계속403/정상회수·재부여200, 실제 login/token exchange 뒤 mail:read와 j-mail 단일aud/sid/username 검증, alias-only/비허용 role 조회 거절, 새 realm의 실제 전체 선택 서비스 import/정상 scope 방향/alias 없음/제한된 자격으로 부여204/실제 OIDC+PKCE·축소 role 검증이다.

기존 sample에는 정상 j-mail 역할의 로그인 scope가 비어 있는 configuration drift가 남아 있다. **실제로 발급·검증한 축소 토큰에는 mail:read가 있었다.** 빈 scope가 이 흐름의 추가 실패라고 단정하지 않는다. 초기 추가 시험에서 토큰에 role이 없을 것이라는 가정이 실패했고 실제 측정에 맞게 수정했다. 새 import의 password fixture 누락도 시험 설정 오류로 수정했다. 두 실패는 `/workspace/.suite-runtime/j-auth/mail-compat-scope-assumption-and-fixture-failure.json`에 보존했고 통과로 계산하지 않았다.

기존 sample의 role catalog와 managed FGAP policy/연결 resource·scope·policy를 readonly로 전후 hash 비교해 일치를 확인했다. 기존 realm에 configureMemberAdmin을 적용하는 작업은 이 focused 시험에 없다. 새 import fixture에서만 기존 canonical bootstrap 함수를 적용했다. 테스트가 만든 회원과 새 realm/전용 DB 등록만 제거했다.

결과는 `/workspace/.suite-runtime/j-auth/mail-compat-results.json`, `mail-compat-node22-results.json`, `mail-compat-full-results.json`, `mail-compat-check.log`, `imported-mail-compat-evidence.json`이다. 마지막 증거 JSON에는 기존 create201/alias403, canonical owner, 기존·새 축소 role 검증, 기존 permission/catalog 불변을 기록했다. 원문 token/암호/secret은 저장하거나 로그/commit하지 않았다.

## 남은 범위

기존 import의 alias·scope drift는 보존한다. 원상태를 삭제/재생성하거나 자동 재import하는 migration은 범위에 넣지 않았다. 회원 역할 부여403의 원인은 더 이상 미해결이 아니며 실제 기존 샘플 회귀로 수정됐다. 기존 샘플에서 메일 브라우저/전체 고객 VM 설치를 검증했다는 뜻은 아니다.

E8은 별도다. 전체 SMTP envelope 수신자 보존 방식과 FS-U07의 webhook 수신 전 누락 허용/복구 필요 기준이 결정돼야 한다. 이 호환 수정에서 outbox·ingress proxy·polling recovery·MTA 정책을 추가하지 않았다. 외부 메일/SMS/제3자 송신, 운영 자격 발급·설치·배포, 회사 노트북 설치, PR/main 병합을 하지 않았다.
