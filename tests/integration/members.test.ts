import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { decodeJwt } from 'jose';
import { createTokenVerifier } from '@j-auth/token-verifier';
import type { MemberResponse, MemberListResponse } from '@j-auth/contracts';
import { createApp } from '../../apps/server/src/app.js';
import { configureMemberAdmin } from '../../apps/server/src/keycloak/admin-permissions.js';
import { RealmCredentials } from '../../apps/server/src/keycloak/client.js';
import { integrationRuntime, requiredTestEnv } from './runtime.js';
import type { IntegrationRuntime } from './runtime.js';

describe('real HTTPS member management with restricted Keycloak credentials', () => {
  let runtime: IntegrationRuntime;
  let app: ReturnType<typeof createApp>;
  let adminToken: string;
  let lowerToken: string;
  let otherId: string;
  let member: MemberResponse;
  const username = `api-${randomUUID()}`;
  const password = randomBytes(24).toString('base64url');
  const cleanup = new Set<string>();
  const url = 'https://jauth.jgw.test:54231';
  beforeAll(async () => {
    runtime = await integrationRuntime();
    await configureMemberAdmin(runtime.master, 'sample-a');
    await configureMemberAdmin(runtime.master, 'sample-c');
    adminToken = (await runtime.passwordToken('sample-a', 'a-admin'))
      .access_token;
    lowerToken = (await runtime.passwordToken('sample-a', 'a-member'))
      .access_token;
    otherId = decodeJwt(
      (await runtime.passwordToken('sample-b', 'b-member')).access_token,
    ).sub!;
    app = createApp({
      pool: runtime.pool,
      verifier: createTokenVerifier({
        publicUrl: runtime.publicUrl,
        fetch: runtime.fetch,
      }),
      consoleKeyHashes: [requiredTestEnv('JAUTH_CONSOLE_KEY_HASH')],
      credentials: new RealmCredentials({
        master: runtime.master,
        tenants: runtime.tenants,
        baseUrl: runtime.publicUrl,
        fetch: runtime.fetch,
      }),
      https: {
        cert: await readFile(requiredTestEnv('JAUTH_TLS_CERTIFICATE')),
        key: await readFile(requiredTestEnv('JAUTH_TLS_KEY')),
      },
    });
    await app.listen({ host: '127.0.0.1', port: 54231 });
  });
  afterAll(async () => {
    if (runtime) {
      for (const id of cleanup)
        await runtime.admin(`/admin/realms/tenant-sample-a/users/${id}`, {
          method: 'DELETE',
        });
      if (app) await app.close();
      await runtime.close();
    }
  });
  const request = async (
    path: string,
    method = 'GET',
    body?: unknown,
    token = adminToken,
    key = requiredTestEnv('JGW_SAMPLE_A_SERVICE_KEY'),
  ) =>
    await runtime.fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-JGW-Service-Key': key,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const memberToken = async () => {
    const response = await runtime.fetch(
      `${runtime.publicUrl}/realms/tenant-sample-a/protocol/openid-connect/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          client_id: 'j-groupware',
          client_secret: requiredTestEnv(
            'JGW_SAMPLE_A_J_GROUPWARE_CLIENT_SECRET',
          ),
          grant_type: 'password',
          username,
          password,
          scope: 'openid',
        }),
      },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      access_token: string;
      refresh_token: string;
    };
  };
  const refresh = async (token: string) =>
    await runtime.fetch(
      `${runtime.publicUrl}/realms/tenant-sample-a/protocol/openid-connect/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          client_id: 'j-groupware',
          client_secret: requiredTestEnv(
            'JGW_SAMPLE_A_J_GROUPWARE_CLIENT_SECRET',
          ),
          grant_type: 'refresh_token',
          refresh_token: token,
        }),
      },
    );
  it('allows org-only profile reads without granting member management or exposing roles/credentials', async () => {
    const editorName = `org-${randomUUID()}`,
      editorPassword = randomBytes(24).toString('base64url');
    const created = await request('/auth/members', 'POST', {
      username: editorName,
      password: editorPassword,
      roles: ['org:manage'],
    });
    expect(created.status).toBe(201);
    const editor = (await created.json()) as MemberResponse;
    cleanup.add(editor.id);
    const login = await runtime.fetch(
      `${runtime.publicUrl}/realms/tenant-sample-a/protocol/openid-connect/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          client_id: 'j-groupware',
          client_secret: requiredTestEnv(
            'JGW_SAMPLE_A_J_GROUPWARE_CLIENT_SECRET',
          ),
          grant_type: 'password',
          username: editorName,
          password: editorPassword,
          scope: 'openid',
        }),
      },
    );
    expect(login.status).toBe(200);
    const token = ((await login.json()) as { access_token: string })
      .access_token;
    const target = decodeJwt(adminToken).sub!;
    const profile = await request(
      `/auth/members/${target}`,
      'GET',
      undefined,
      token,
    );
    expect(profile.status).toBe(200);
    expect(Object.keys(await profile.json()).sort()).toEqual([
      'enabled',
      'id',
      'username',
    ]);
    expect(
      (await request('/auth/members', 'GET', undefined, token)).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/auth/members',
          'POST',
          { username: 'org-cannot-create', password: 'unused', roles: [] },
          token,
        )
      ).status,
    ).toBe(403);
    expect(
      (await request(`/auth/members/${target}`, 'DELETE', undefined, token))
        .status,
    ).toBe(403);
    expect(
      (
        await request(
          `/auth/members/${target}/roles/board:write`,
          'PUT',
          undefined,
          token,
        )
      ).status,
    ).toBe(403);
  });
  it('rejects missing read role, foreign member id and another tenant service key on profile reads', async () => {
    const target = decodeJwt(adminToken).sub!;
    expect(
      (await request(`/auth/members/${target}`, 'GET', undefined, lowerToken))
        .status,
    ).toBe(403);
    expect((await request(`/auth/members/${otherId}`)).status).toBe(404);
    expect(
      (
        await request(
          `/auth/members/${target}`,
          'GET',
          undefined,
          adminToken,
          requiredTestEnv('JGW_SAMPLE_B_SERVICE_KEY'),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          `/auth/members/${target}`,
          'GET',
          undefined,
          adminToken,
          '',
        )
      ).status,
    ).toBe(401);
  });
  it('exposes only active talk writers to talk-only callers and rechecks role/activation changes', async () => {
    const writerName = `talk-${randomUUID()}`,
      writerPassword = randomBytes(24).toString('base64url');
    const created = await request('/auth/members', 'POST', {
      username: writerName,
      password: writerPassword,
      roles: ['talk:write'],
    });
    expect(created.status).toBe(201);
    const writer = (await created.json()) as MemberResponse;
    cleanup.add(writer.id);
    const login = await runtime.fetch(
      `${runtime.publicUrl}/realms/tenant-sample-a/protocol/openid-connect/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          client_id: 'j-groupware',
          client_secret: requiredTestEnv(
            'JGW_SAMPLE_A_J_GROUPWARE_CLIENT_SECRET',
          ),
          grant_type: 'password',
          username: writerName,
          password: writerPassword,
          scope: 'openid',
        }),
      },
    );
    expect(login.status).toBe(200);
    const token = ((await login.json()) as { access_token: string })
      .access_token;
    const list = await request('/auth/talk/assignees', 'GET', undefined, token);
    expect(list.status).toBe(200);
    const page = (await list.json()) as {
      items: { id: string; username: string }[];
      nextCursor: string | null;
    };
    expect(page.items).toContainEqual({ id: writer.id, username: writerName });
    expect(
      page.items.every(
        (item) => Object.keys(item).sort().join(',') === 'id,username',
      ),
    ).toBe(true);
    for (const path of [
      '/auth/members',
      `/auth/members/${writer.id}`,
      '/auth/members/grantable-roles',
    ])
      expect((await request(path, 'GET', undefined, token)).status).toBe(403);
    expect(
      (
        await request(
          '/auth/members',
          'POST',
          { username: 'forbidden', password: 'unused', roles: [] },
          token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          `/auth/talk/assignees/${writer.id}`,
          'GET',
          undefined,
          token,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/auth/talk/assignees/${otherId}`,
          'GET',
          undefined,
          token,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/auth/talk/assignees/${decodeJwt(lowerToken).sub!}`,
          'GET',
          undefined,
          token,
        )
      ).status,
    ).toBe(404);
    expect(
      (await request('/auth/talk/assignees', 'GET', undefined, lowerToken))
        .status,
    ).toBe(403);
    expect(
      (
        await request(
          '/auth/talk/assignees?tenant=sample-b',
          'GET',
          undefined,
          token,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          '/auth/talk/assignees',
          'GET',
          undefined,
          token,
          requiredTestEnv('JGW_SAMPLE_B_SERVICE_KEY'),
        )
      ).status,
    ).toBe(401);
    const disabled = await runtime.admin(
      `/admin/realms/tenant-sample-a/users/${writer.id}`,
      { method: 'PUT', body: JSON.stringify({ enabled: false }) },
    );
    expect(disabled.status).toBe(204);
    expect((await request(`/auth/talk/assignees/${writer.id}`)).status).toBe(
      404,
    );
    expect(
      (await request('/auth/talk/assignees', 'GET', undefined, token)).status,
    ).toBe(403);
    expect(
      (
        await runtime.admin(
          `/admin/realms/tenant-sample-a/users/${writer.id}`,
          { method: 'PUT', body: JSON.stringify({ enabled: true }) },
        )
      ).status,
    ).toBe(204);
    expect(
      (await request(`/auth/members/${writer.id}/roles/talk:write`, 'DELETE'))
        .status,
    ).toBe(200);
    // JWT remains signature-valid, but current effective roles are authoritative for assignment.
    expect(
      (await request('/auth/talk/assignees', 'GET', undefined, token)).status,
    ).toBe(403);
    expect((await request(`/auth/talk/assignees/${writer.id}`)).status).toBe(
      404,
    );
  });
  it('creates a password-ready user with expanded functional roles', async () => {
    const response = await request('/auth/members', 'POST', {
      username,
      password,
      roles: ['board:write'],
    });
    expect(response.status).toBe(201);
    member = (await response.json()) as MemberResponse;
    cleanup.add(member.id);
    expect(member.username).toBe(username);
    expect(member.enabled).toBe(true);
    expect(member.roles).toEqual(['board:read', 'board:write']);
    const token = await memberToken();
    expect(decodeJwt(token.access_token).sub).toBe(member.id);
  });
  it('returns conflict for duplicate usernames and filters service accounts from the list', async () => {
    expect(
      (
        await request('/auth/members', 'POST', {
          username,
          password,
          roles: [],
        })
      ).status,
    ).toBe(409);
    const response = await request('/auth/members');
    expect(response.status).toBe(200);
    const listed = (await response.json()) as MemberListResponse;
    expect(listed.items.some((user) => user.id === member.id)).toBe(true);
    expect(
      listed.items.some((user) => user.username.startsWith('service-account-')),
    ).toBe(false);
    expect((await request('/auth/members?cursor=-1')).status).toBe(400);
  });
  it('rejects lower-member writes and forbidden initial roles before creating a user', async () => {
    expect(
      (
        await request(
          '/auth/members',
          'POST',
          { username: `denied-${randomUUID()}`, password, roles: [] },
          lowerToken,
        )
      ).status,
    ).toBe(403);
    const deniedName = `denied-${randomUUID()}`;
    expect(
      (
        await request('/auth/members', 'POST', {
          username: deniedName,
          password,
          roles: ['member:manage'],
        })
      ).status,
    ).toBe(403);
    expect(
      await runtime.json<{ id: string }[]>(
        `/admin/realms/tenant-sample-a/users?username=${deniedName}&exact=true`,
      ),
    ).toHaveLength(0);
  });
  it('distinguishes inherited reads from direct grants and invalidates target sessions', async () => {
    const inherited = await request(
      `/auth/members/${member.id}/roles/board:read`,
      'DELETE',
    );
    expect(inherited.status).toBe(200);
    expect(((await inherited.json()) as MemberResponse).roles).toEqual([
      'board:read',
      'board:write',
    ]);
    const session = await memberToken();
    expect(
      (await request(`/auth/members/${member.id}/roles/board:read`, 'PUT'))
        .status,
    ).toBe(200);
    expect((await refresh(session.refresh_token)).status).toBe(400);
    const writeRemoved = await request(
      `/auth/members/${member.id}/roles/board:write`,
      'DELETE',
    );
    expect(writeRemoved.status).toBe(200);
    expect(((await writeRemoved.json()) as MemberResponse).roles).toEqual([
      'board:read',
    ]);
  });
  it('rejects identity/admin/unsubscribed roles without modifying the user', async () => {
    for (const role of ['tenant:admin', 'member:manage', 'unknown:read']) {
      expect(
        (await request(`/auth/members/${member.id}/roles/${role}`, 'PUT'))
          .status,
      ).toBe(403);
    }
    const cToken = (await runtime.passwordToken('sample-c', 'c-admin'))
      .access_token;
    expect(
      (
        await request(
          `/auth/members/${member.id}/roles/mail:read`,
          'PUT',
          undefined,
          cToken,
          requiredTestEnv('JGW_SAMPLE_C_SERVICE_KEY'),
        )
      ).status,
    ).toBe(403);
    const current = await request('/auth/members');
    expect(
      ((await current.json()) as MemberListResponse).items.find(
        (entry) => entry.id === member.id,
      )?.roles,
    ).toEqual(['board:read']);
  });
  it('prevents self/admin/service-account deletion and hides other-tenant targets', async () => {
    const selfId = decodeJwt(adminToken).sub!;
    expect((await request(`/auth/members/${selfId}`, 'DELETE')).status).toBe(
      403,
    );
    const bAdminId = decodeJwt(
      (await runtime.passwordToken('sample-b', 'b-admin')).access_token,
    ).sub!;
    expect((await request(`/auth/members/${bAdminId}`, 'DELETE')).status).toBe(
      404,
    );
    expect((await request(`/auth/members/${otherId}`, 'DELETE')).status).toBe(
      404,
    );
    expect(
      (await runtime.admin(`/admin/realms/tenant-sample-b/users/${otherId}`))
        .status,
    ).toBe(200);
    const clientId = await runtime.tenants.clientId('sample-a', 'j-auth-admin');
    const serviceAccount = await runtime.json<{ id: string }>(
      `/admin/realms/tenant-sample-a/clients/${clientId}/service-account-user`,
    );
    expect(
      (await request(`/auth/members/${serviceAccount.id}`, 'DELETE')).status,
    ).toBe(404);
  });
  it('deletes its own test member and invalidates the remaining session', async () => {
    const session = await memberToken();
    expect((await request(`/auth/members/${member.id}`, 'DELETE')).status).toBe(
      204,
    );
    cleanup.delete(member.id);
    expect((await refresh(session.refresh_token)).status).toBe(400);
    expect((await request(`/auth/members/${member.id}`, 'DELETE')).status).toBe(
      404,
    );
  });
  it('protects a different tenant admin and the service-account namespace', async () => {
    for (const username of [
      `service-account-${randomUUID()}`,
      ` SERVICE-ACCOUNT-${randomUUID()} `,
    ])
      expect(
        (
          await request('/auth/members', 'POST', {
            username,
            password,
            roles: [],
          })
        ).status,
      ).toBe(400);
    const created = await request('/auth/members', 'POST', {
      username: `guard-${randomUUID()}`,
      password,
      roles: [],
    });
    expect(created.status).toBe(201);
    const target = (await created.json()) as MemberResponse;
    cleanup.add(target.id);
    const adminRole = await runtime.json<{ id: string; name: string }>(
      '/admin/realms/tenant-sample-a/roles/tenant:admin',
    );
    expect(
      (
        await runtime.admin(
          `/admin/realms/tenant-sample-a/users/${target.id}/role-mappings/realm`,
          { method: 'POST', body: JSON.stringify([adminRole]) },
        )
      ).status,
    ).toBe(204);
    expect((await request(`/auth/members/${target.id}`, 'DELETE')).status).toBe(
      403,
    );
    expect(
      (await runtime.admin(`/admin/realms/tenant-sample-a/users/${target.id}`))
        .status,
    ).toBe(200);
  });
});
