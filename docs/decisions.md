# j-auth 설계 결정

j-auth 최소 구현에 필요한 설계 결정을 정리한다. 제품군 공통 기준은 `j-groupware/docs/architecture.md`를 따르고, 이 문서는 그 위에서 j-auth가 정한 내용만 적는다. 각 결정은 PMT project `3dbae127-2180-4787-863f-037421a21257`에 같은 번호의 `결정 N` 레코드로 기록되어 있다.

결정일: 2026-10-06

## 1. 테넌트와 realm

### 결정 3. 고객 분리 방식
- **결정:** 고객(tenant)마다 Keycloak realm을 하나씩 둔다. 운영사 realm 1개 + 고객별 realm.
- **이유:** 분리가 강하고 최소 구현 단계에서 이해·검증이 쉽다. architecture.md 기준안과 같다.

### 결정 4. tenant → realm 매핑
- **결정:** j-auth가 tenant ID ↔ realm 이름 매핑 표를 관리한다. 표에 없는 tenant는 거절한다. 운영사 직원은 tenant 예약어 `operator`로 로그인한다.
- **이유:** 고객 이름이 바뀌어도 realm을 유지하고, 미등록 tenant를 입력 단계에서 막는다.

## 2. 역할

### 결정 5. 역할 모델
- **결정:**
  - 사람의 신분은 realm role, 기능 권한은 client role로 둔다.
  - 이름 규칙은 `대상:동작`, 소문자, 콜론 구분. 예: `operator:admin`, `tenant:admin`, `tenant:member`, `board:read`, `board:write`.
  - 기능 권한도 Keycloak에 저장하고 j-auth가 반환한다.
  - 복합 role은 펼친 최종 목록(effective roles)으로 반환한다.
  - 권한은 사람마다 직접 부여한다. 그룹은 쓰지 않는다.
  - Keycloak 기본 role(`default-roles-*`, `offline_access`, `uma_authorization` 등)은 응답에서 걸러내고, 이름 규칙에 맞는 role만 반환한다.
- **이유:** 모든 서비스가 j-auth 응답만 보고 기능 노출을 결정한다(architecture.md). 펼친 목록이면 각 서비스는 포함 여부만 확인하면 된다. 직접 부여는 최소 구현을 단순하게 한다.

## 3. 로그인 API

### 결정 6. 로그인 응답의 토큰
- **결정:** 로그인 성공 응답에 `ok`, `roles`와 함께 Keycloak access token을 반환한다. 각 서비스는 Keycloak 공개키로 토큰 서명을 검증한다. 구체 필드명은 `packages/contracts`에서 확정한다.
- **이유:** 로그인 다음 요청에서 사용자를 증명할 수단이 필요하다. 이후 OIDC Authorization Code로 옮길 때도 같은 토큰 검증 방식을 쓴다.

### 결정 7. 실패 구분
- **결정:**
  1. 계정 없음과 비밀번호 틀림은 같은 `{ok:false}`로 응답한다.
  2. Keycloak 장애는 별도 오류(예: HTTP 503)로 응답한다.
  3. Keycloak brute force detection을 켠다.
- **이유:** 계정 열거 공격을 막고, 사용자 오류와 시스템 장애를 나누고, 비밀번호 대입 공격을 막는다.

### 결정 13. contracts 위치
- **결정:** 로그인 요청·응답 계약(TypeBox 스키마, DTO, 오류 코드)은 j-auth 저장소의 `packages/contracts`에 둔다.
- **이유:** j-auth가 계약을 독립적으로 관리한다.

## 4. Keycloak 구성

### 결정 8. Keycloak 클라이언트와 비밀값
- **결정:**
  - j-auth는 confidential client(client secret 사용)로 등록하고 Direct Access Grants를 켠다.
  - client secret은 로컬 개발에서는 Git에서 제외된 `.env`, VM에서는 소유자만 읽을 수 있는 env 파일(systemd `EnvironmentFile`)에 둔다.
  - realm별 secret은 `KC_SECRET_<realm>` 이름 규칙으로 구분한다.
- **이유:** 서버 측 앱이라 secret을 보관할 수 있다. 저장소와 로그에 비밀값을 남기지 않는다.

### 결정 9. Keycloak DB와 기동
- **결정:** 처음부터 Docker Compose로 Keycloak + PostgreSQL을 함께 띄운다. Keycloak 이미지는 정확한 버전으로 고정한다.
- **이유:** 운영과 같은 구조로 시작해 dev 모드(H2)에서 옮기는 작업을 없앤다. architecture.md DB 기준과 같다.

### 결정 10. realm 구성 관리
- **결정:** realm, 역할, client, 테스트 계정을 realm JSON 파일로 저장소에 두고 Keycloak 시작 시 import한다. 실제 비밀값은 파일에 넣지 않는다.
- **이유:** 설정을 어디서나 똑같이 재현하고 변경 이력을 Git에 남긴다.

## 5. 검증과 배포

### 결정 11. 테스트 방식
- **결정:** Vitest와 실제 Keycloak(Docker Compose) 통합 테스트로 완료 기준을 증명한다. 최소 케이스:
  1. 관리자 로그인 성공 + 관리자 역할
  2. 하위 회원 로그인 성공 + 하위 회원 역할만
  3. 비밀번호 틀림 → `{ok:false}`
  4. 없는 계정 → 3번과 같은 응답
  5. 미등록 tenant 거절
  6. Keycloak 장애 → 별도 오류
- **이유:** 실제 Keycloak과 맞는지 증명한다. j-messenger와 같은 테스트 도구를 쓴다.

### 결정 12. 배포와 접근
- **결정:**
  - 1차로 로컬에서 완료한 뒤, Hyper-V VM을 만들어 같은 구성으로 생성·검증한다.
  - HTTPS는 로컬 인증서를 생성해 사용한다.
  - 포트는 비표준 임의 값을 기본으로 하되, 실제 서비스 시 설정으로 바꿀 수 있게 한다.
  - Keycloak 관리 콘솔은 로컬에서만 접근할 수 있게 한다.
- **이유:** 단계적으로 검증하고, 비밀번호가 오가는 경로를 암호화하고, 관리 화면이 외부에 노출되지 않게 한다.

## 6. 작업 구성

결정 0(PMT 계층과 Item 구성)은 AI에 위임했다. PMT 계층은 environment `j-groupware-suite` → repository `j-auth` → project `j-auth`이다. Item은 앞 단계가 끝나야 다음 단계를 시작한다.

| 순서 | Item | 완료 기준 요약 |
| --- | --- | --- |
| I1 | Keycloak 실행 환경 | Compose로 Keycloak + PostgreSQL 기동, 버전 고정, 로컬 HTTPS, 포트 설정 가능, 관리 콘솔 로컬 전용, 비밀값은 Git 제외 env에만 |
| I2 | realm 구성 | 운영사·샘플 고객 realm import, 역할 이름 규칙, confidential client + Direct Access Grants, brute force 방어, 테스트 계정, realm JSON에 실제 비밀값 없음 |
| I3 | 로그인 API | contracts, tenant 매핑 표, `operator` 예약어, 성공 시 effective roles + access token, 동일 실패 응답, 장애 시 별도 오류, secret은 env에서 읽음 |
| I4 | 통합 테스트 | 결정 11의 6개 케이스 통과 |
| I5 | Hyper-V VM 검증 | VM 생성, 같은 Compose·realm import, VM HTTPS, 관리 콘솔 외부 비노출, VM 대상 통합 테스트 통과 |
