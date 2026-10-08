# @j-auth/token-verifier

제품군의 RS256 access token 검증 코드다. Node.js 22.18 이상을 사용한다. 등록된 tenant와 수신 서비스 audience는 호출자가 결정하며, 토큰의 미검증 claim으로 허용 여부를 결정하지 않는다.

```typescript
import { createTokenVerifier } from '@j-auth/token-verifier';

const verifier = createTokenVerifier({ publicUrl: 'https://auth.jgw.test' });
const identity = await verifier.verify(accessToken, {
  tenantId: registeredTenantId,
  audience: 'j-groupware',
});
```

서명, issuer, audience, `exp`, `iat`, `sub`, `tenant`, `azp`, Bearer 유형을 검사한다. 고객은 `tenant-<id>` realm과 `azp=j-groupware`, 운영사는 `operator` realm과 `azp=j-console`을 사용한다. role은 contracts의 신분·서비스별 namespace에 속하는 값만 반환한다.

JWKS는 최대 100 realm, 5분 캐시를 사용하고 새 `kid` 조회에는 1초 cooldown과 5초 요청 제한을 둔다. `TokenVerificationError.kind`는 무효 토큰이면 `invalid`, JWKS 연결·HTTP·JSON·키 구성 장애면 `unavailable`이다. 서비스 키와 활성 tenant 검사는 j-auth 서버가 별도로 수행한다.

workspace에서 빌드·사용을 검증했다. registry 게시와 다른 저장소에서의 실제 설치는 미실행이다. [검증 기록](../../docs/cloud-verification-2026-10-08.md)을 따른다.
