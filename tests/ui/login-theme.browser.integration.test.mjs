import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns';
import { chromium } from '@playwright/test';
import { Agent, fetch as undiciFetch } from 'undici';
import { buildCustomerRealm } from '../../scripts/realm/templates.mjs';
import * as contracts from '../../packages/contracts/dist/index.js';

const scratch = process.env.JGW_TEST_TMP_ROOT ?? '/tmp/jgw-task25-tests-1000';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`UI integration fixture needs ${name}.`);
  return value;
}

const runtime = async () => {
  if (required('JAUTH_TEST_RUNTIME') !== 'isolated-cloud')
    throw new Error('An isolated Keycloak runtime is required.');
  const publicUrl = required('KC_PUBLIC_URL');
  if (new URL(publicUrl).hostname !== 'auth.jgw.test')
    throw new Error('Unexpected Keycloak fixture hostname.');
  const ca = await readFile(required('JAUTH_TLS_CERTIFICATE'), 'utf8');
  const agent = new Agent({
    connect: {
      ca,
      lookup: (host, options, callback) => {
        if (host === 'auth.jgw.test') {
          if (options.all)
            callback(null, [{ address: '127.0.0.1', family: 4 }]);
          else callback(null, '127.0.0.1', 4);
        } else lookup(host, options, callback);
      },
    },
  });
  const fetch = async (url, init = {}) =>
    await undiciFetch(url, {
      ...init,
      dispatcher: agent,
      redirect: init.redirect ?? 'error',
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
  return { publicUrl, agent, fetch };
};

async function browserOptions() {
  const { mkdir } = await import('node:fs/promises');
  const cache = `${scratch}/keycloak-ui-cache`;
  const config = `${scratch}/keycloak-ui-config`;
  const profile =
    process.env.JGW_PROFILE_DIR ?? `${scratch}/keycloak-ui-profile`;
  await Promise.all(
    [cache, config, profile].map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 }),
    ),
  );
  return {
    profile,
    launch: {
      executablePath:
        process.env.JGW_CHROMIUM_PATH ?? '/usr/lib/chromium/chromium',
      headless: true,
      ignoreHTTPSErrors: true,
      timeout: 20_000,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-breakpad',
        '--no-proxy-server',
        '--host-resolver-rules=MAP auth.jgw.test 127.0.0.1,EXCLUDE localhost',
      ],
      env: {
        ...process.env,
        TMPDIR: '/tmp',
        XDG_CACHE_HOME: cache,
        XDG_CONFIG_HOME: config,
      },
      viewport: { width: 1440, height: 900 },
    },
  };
}

const tenantId = `ui-${randomUUID().slice(0, 10)}`;
const realmName = `tenant-${tenantId}`;
let fixture;
let created = false;
let context;
let page;
const browserRouteTrace = [];

try {
  fixture = await runtime();
  const discovery = await fixture.fetch(
    `${fixture.publicUrl}/realms/master/.well-known/openid-configuration`,
  );
  assert.equal(discovery.status, 200);
  const tokenResponse = await fixture.fetch(
    `${fixture.publicUrl}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      body: new URLSearchParams({
        client_id: 'admin-cli',
        grant_type: 'password',
        username: required('KC_BOOTSTRAP_ADMIN_USERNAME'),
        password: required('KC_BOOTSTRAP_ADMIN_PASSWORD'),
      }),
    },
  );
  assert.equal(tokenResponse.status, 200);
  const adminToken = (await tokenResponse.json()).access_token;
  const template = buildCustomerRealm(
    { tenantId, selectedServiceIds: [] },
    contracts,
  );
  assert.equal(template.loginTheme, 'jgw');
  const createRealm = await fixture.fetch(`${fixture.publicUrl}/admin/realms`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(template),
  });
  assert.equal(createRealm.status, 201);
  created = true;

  const realmResponse = await fixture.fetch(
    `${fixture.publicUrl}/admin/realms/${realmName}`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  assert.equal(realmResponse.status, 200);
  const realm = await realmResponse.json();
  assert.equal(realm.loginTheme, 'jgw');
  const clientsResponse = await fixture.fetch(
    `${fixture.publicUrl}/admin/realms/${realmName}/clients?clientId=j-groupware`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  assert.equal(clientsResponse.status, 200);
  const clients = await clientsResponse.json();
  const client = clients.find((item) => item.clientId === 'j-groupware');
  assert.ok(client);
  assert.ok(client.redirectUris.length > 0);
  const loginUrl = new URL(
    `${fixture.publicUrl}/realms/${realmName}/protocol/openid-connect/auth`,
  );
  const verifier = randomBytes(32).toString('base64url');
  loginUrl.search = new URLSearchParams({
    client_id: 'j-groupware',
    redirect_uri: client.redirectUris[0],
    response_type: 'code',
    scope: 'openid',
    state: randomBytes(24).toString('base64url'),
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }).toString();

  const options = await browserOptions();
  context = await chromium.launchPersistentContext(
    options.profile,
    options.launch,
  );
  page = await context.newPage();
  const styleResponses = [];
  const failedRequests = [];
  const pageResponses = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname === 'auth.jgw.test')
      pageResponses.push({ status: response.status(), path: url.pathname });
    if (url.pathname.endsWith('.css'))
      styleResponses.push({ status: response.status(), path: url.pathname });
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    failedRequests.push({
      path: url.pathname,
      error: request.failure()?.errorText,
    });
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (requestUrl.origin !== fixture.publicUrl) {
      await route.continue();
      return;
    }
    browserRouteTrace.push(`${request.method()} ${requestUrl.pathname}`);
    if (request.method() !== 'GET') {
      await route.abort('blockedbyclient');
      return;
    }
    const upstream = await fixture.fetch(requestUrl, {
      method: 'GET',
      redirect: 'manual',
    });
    browserRouteTrace.push(`${upstream.status} ${requestUrl.pathname}`);
    const redirect = upstream.headers.get('location');
    if (redirect) {
      const target = new URL(redirect, requestUrl);
      browserRouteTrace.push(
        `redirect ${target.protocol}//${target.host}${target.pathname}${target.searchParams.get('error') ? ` error=${target.searchParams.get('error')}` : ''}`,
      );
    }
    const headers = {};
    for (const name of [
      'cache-control',
      'content-language',
      'content-security-policy',
      'content-type',
      'location',
      'referrer-policy',
      'set-cookie',
      'x-content-type-options',
    ]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    const body = [204, 304].includes(upstream.status)
      ? undefined
      : Buffer.from(await upstream.arrayBuffer());
    if (body && body.byteLength > 2_000_000)
      throw new Error('Keycloak theme response exceeded fixture size cap.');
    await route.fulfill({
      status: upstream.status,
      headers,
      ...(body ? { body } : {}),
    });
  });
  const navigation = await page.goto(loginUrl.toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 20_000,
  });
  const navigationStatus = navigation?.status() ?? 0;
  await page.waitForTimeout(1500);
  const initialPage = await page.evaluate(() => ({
    title: document.title,
    text: document.body.innerText.slice(0, 240),
    styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map(
      (link) => new URL(link.href).pathname,
    ),
  }));
  assert.ok(
    styleResponses.some(
      (entry) =>
        entry.status === 200 &&
        entry.path.includes('/login/jgw/css/styles.css'),
    ),
    `Keycloak theme stylesheet was not loaded (HTTP ${navigationStatus}; ${JSON.stringify({ ...initialPage, styleResponses, pageResponses, failedRequests })}).`,
  );
  await page
    .locator('input[type="submit"], button[type="submit"]')
    .first()
    .waitFor();
  const theme = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const card = document.querySelector(
      '.pf-v5-c-login__main, .pf-c-login__main, .card-pf, .pf-v5-c-card, .pf-c-card',
    );
    return {
      token: root.getPropertyValue('--jgw-color-primary').trim(),
      background: getComputedStyle(document.body).backgroundColor,
      button: getComputedStyle(
        document.querySelector('input[type="submit"], button[type="submit"]'),
      ).backgroundColor,
      card: card ? getComputedStyle(card).backgroundColor : '',
      cardBounds: card?.getBoundingClientRect().toJSON() ?? null,
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  assert.equal(theme.token, '#2454d6');
  assert.equal(theme.background, 'rgb(243, 246, 251)');
  assert.equal(theme.button, 'rgb(36, 84, 214)');
  assert.ok(theme.card);
  assert.ok(theme.cardBounds);

  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const card = document.querySelector(
        '.pf-v5-c-login__main, .pf-c-login__main, .card-pf, .pf-v5-c-card, .pf-c-card',
      );
      const rect = card?.getBoundingClientRect();
      return {
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        left: rect?.left ?? -1,
        right: rect?.right ?? Number.POSITIVE_INFINITY,
      };
    });
    assert.ok(layout.scrollWidth <= width, `${width}px page overflow`);
    assert.ok(
      layout.left >= 0 && layout.right <= width,
      `${width}px login card overflow`,
    );
  }
  await page.keyboard.press('Tab');
  let visibleFocus = false;
  for (let attempt = 0; attempt < 16; attempt++) {
    visibleFocus = await page.evaluate(
      () =>
        document.activeElement instanceof HTMLElement &&
        getComputedStyle(document.activeElement).outlineWidth === '3px',
    );
    if (visibleFocus) break;
    await page.keyboard.press('Tab');
  }
  assert.equal(visibleFocus, true, 'keyboard focus indicator is visible');
} catch (error) {
  process.stderr.write(
    `Keycloak browser route trace: ${JSON.stringify(browserRouteTrace)}\n`,
  );
  if (page) {
    const state = await page
      .evaluate(() => ({
        title: document.title,
        text: document.body.innerText.slice(0, 120),
      }))
      .catch(() => null);
    if (state) error.message += `; page=${JSON.stringify(state)}`;
  }
  if (page && process.env.JGW_BROWSER_EVIDENCE_PATH) {
    await page
      .screenshot({ path: process.env.JGW_BROWSER_EVIDENCE_PATH })
      .catch(() => {});
  }
  throw error;
} finally {
  await context?.close();
  if (fixture && created) {
    const tokenResponse = await fixture.fetch(
      `${fixture.publicUrl}/realms/master/protocol/openid-connect/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          client_id: 'admin-cli',
          grant_type: 'password',
          username: required('KC_BOOTSTRAP_ADMIN_USERNAME'),
          password: required('KC_BOOTSTRAP_ADMIN_PASSWORD'),
        }),
      },
    );
    if (tokenResponse.ok) {
      const adminToken = (await tokenResponse.json()).access_token;
      const removed = await fixture.fetch(
        `${fixture.publicUrl}/admin/realms/${realmName}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      assert.ok([204, 404].includes(removed.status));
    }
  }
  await fixture?.agent.close();
}
