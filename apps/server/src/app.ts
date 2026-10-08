import Fastify, { LogController } from 'fastify';
import type { FastifyServerOptions, FastifyError } from 'fastify';
import type { ServerOptions as HttpsOptions } from 'node:https';
import { SERVICE_KEY_HEADER } from '@j-auth/contracts';
import type { CreateMemberRequest } from '@j-auth/contracts';
import type { TokenVerifier } from '@j-auth/token-verifier';
import type { Pool } from 'pg';
import { TenantStore } from './db/tenants.js';
import { ApiError, unavailable } from './errors.js';
import { createAuthorizer } from './security/authorize.js';
import type { RealmCredentials } from './keycloak/client.js';
import { MemberService } from './keycloak/members.js';

export function createApp(options: {
  pool: Pool;
  verifier: TokenVerifier;
  consoleKeyHashes: readonly string[];
  credentials: RealmCredentials;
  https?: HttpsOptions;
  logger?: FastifyServerOptions['logger'];
}) {
  const app = Fastify({
    ...(options.https ? { https: options.https } : {}),
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16_384,
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    genReqId: () => crypto.randomUUID(),
  });
  const tenants = new TenantStore(options.pool);
  const members = new MemberService(tenants, options.credentials);
  const authorize = createAuthorizer({
    tenants,
    verifier: options.verifier,
    consoleKeyHashes: options.consoleKeyHashes,
  });
  const memberIdentity = async (headers: {
    authorization?: string | undefined;
    [key: string]: unknown;
  }) =>
    await authorize(
      {
        ...(headers.authorization
          ? { authorization: headers.authorization }
          : {}),
        serviceKey: headers[SERVICE_KEY_HEADER.toLowerCase()],
      },
      'member',
    );
  const idSchema = {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    pattern: '^(?!\\.\\.?$)[^\\x00-\\x1f\\x7f]+$',
  };

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const publicError =
      error instanceof ApiError
        ? error
        : error.validation ||
            error.statusCode === 400 ||
            error.statusCode === 413
          ? new ApiError(
              error.statusCode === 413 ? 413 : 400,
              'invalid_input',
              'Invalid request.',
            )
          : unavailable();
    // Avoid logging errors or requests containing passwords, bearer tokens, DB details or secrets.
    request.log.warn(
      {
        requestId: request.id,
        statusCode: publicError.statusCode,
        code: publicError.code,
      },
      'Request failed',
    );
    void reply.code(publicError.statusCode).send({
      code: publicError.code,
      message: publicError.message,
      requestId: request.id,
    });
  });
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      code: 'not_found',
      message: 'Route not found.',
      requestId: request.id,
    });
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    try {
      await options.pool.query('SELECT 1');
    } catch {
      throw unavailable();
    }
    return { status: 'ok' };
  });
  app.get('/auth/members/grantable-roles', async (request) => {
    const identity = await memberIdentity(request.headers);
    return { roles: await members.grantableRoles(identity.tenantId) };
  });
  app.get<{ Querystring: { cursor?: string } }>(
    '/auth/members',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cursor: { type: 'string', pattern: '^(0|[1-9][0-9]{0,5})$' },
          },
        },
      },
    },
    async (request) => {
      const identity = await memberIdentity(request.headers);
      return await members.list(
        identity.tenantId,
        Number(request.query.cursor ?? '0'),
      );
    },
  );
  app.post<{ Body: CreateMemberRequest }>(
    '/auth/members',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username', 'password', 'roles'],
          properties: {
            username: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              pattern: '\\S',
            },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
            roles: {
              type: 'array',
              maxItems: 32,
              items: { type: 'string', minLength: 1, maxLength: 128 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = await memberIdentity(request.headers);
      return reply
        .code(201)
        .send(await members.create(identity.tenantId, request.body));
    },
  );
  const roleSchema = {
    params: {
      type: 'object',
      required: ['id', 'role'],
      properties: {
        id: idSchema,
        role: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
  };
  for (const method of ['PUT', 'DELETE'] as const) {
    app.route<{ Params: { id: string; role: string } }>({
      method,
      url: '/auth/members/:id/roles/:role',
      schema: roleSchema,
      handler: async (request) => {
        const identity = await memberIdentity(request.headers);
        return await members.changeRole(
          identity.tenantId,
          request.params.id,
          request.params.role,
          method === 'PUT',
        );
      },
    });
  }
  app.delete<{ Params: { id: string } }>(
    '/auth/members/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: idSchema },
        },
      },
    },
    async (request, reply) => {
      const identity = await memberIdentity(request.headers);
      await members.remove(
        identity.tenantId,
        request.params.id,
        identity.subject,
      );
      return reply.code(204).send();
    },
  );
  return app;
}
