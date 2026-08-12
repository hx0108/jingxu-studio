import { describe, expectTypeOf, it } from 'vitest';

import type { CredentialPort } from './credential-port';
import type { CredentialRef } from './credential-types';

describe('Credential Application Port', () => {
  it('公开边界—Port 签名不暴露明文 Key 字段（AGENTS.md §13.2）', () => {
    expectTypeOf<CredentialPort>().toHaveProperty('isAvailable');
    expectTypeOf<CredentialPort>().toHaveProperty('saveCredential');
    expectTypeOf<CredentialPort>().toHaveProperty('loadCredential');
    expectTypeOf<CredentialPort>().toHaveProperty('deleteCredential');
  });

  it('凭据引用—只含元数据，不含明文', () => {
    expectTypeOf<CredentialRef>().toHaveProperty('id');
    expectTypeOf<CredentialRef>().toHaveProperty('last4');
    expectTypeOf<CredentialRef>().not.toHaveProperty('plaintext');
    expectTypeOf<CredentialRef>().not.toHaveProperty('apiKey');
  });
});
