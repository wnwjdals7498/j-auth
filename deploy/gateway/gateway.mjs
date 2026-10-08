import path from 'node:path';
const keys = [
  'root',
  'hostname',
  'listenPort',
  'certificate',
  'privateKey',
  'upstreamCa',
  'keycloakPort',
  'keycloakTlsName',
  'authPort',
  'authTlsName',
  'loginRate',
  'loginBurst',
];
const port = (v) => Number.isInteger(v) && v > 0 && v <= 65535 && v !== 3001;
const host = (v) =>
  typeof v === 'string' &&
  v.length <= 253 &&
  /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(v) &&
  !v.includes('..') &&
  v
    .split('.')
    .every((x) => x.length <= 63 && !x.startsWith('-') && !x.endsWith('-'));
const file = (v) =>
  typeof v === 'string' &&
  path.isAbsolute(v) &&
  v !== '/' &&
  path.normalize(v) === v &&
  /^\/[A-Za-z0-9_.\/-]+$/.test(v) &&
  !v.split('/').includes('..');
export function renderAuthGateway(p) {
  if (
    !p ||
    typeof p !== 'object' ||
    Object.keys(p).some((k) => !keys.includes(k)) ||
    keys.some((k) => p[k] === undefined) ||
    !file(p.root) ||
    !file(p.certificate) ||
    !file(p.privateKey) ||
    !file(p.upstreamCa) ||
    !host(p.hostname) ||
    !host(p.keycloakTlsName) ||
    !host(p.authTlsName) ||
    ![p.listenPort, p.keycloakPort, p.authPort].every(port) ||
    new Set([p.listenPort, p.keycloakPort, p.authPort]).size !== 3 ||
    !Number.isInteger(p.loginRate) ||
    p.loginRate < 1 ||
    p.loginRate > 1000 ||
    !Number.isInteger(p.loginBurst) ||
    p.loginBurst < 1 ||
    p.loginBurst > 1000
  )
    throw new Error('Invalid auth gateway profile');
  const proxy = (port, tlsName) =>
    `proxy_pass https://127.0.0.1:${port};\nproxy_ssl_verify on;\nproxy_ssl_server_name on;\nproxy_ssl_name ${tlsName};\nproxy_ssl_trusted_certificate ${p.upstreamCa};\nproxy_ssl_verify_depth 3;`;
  const kc = proxy(p.keycloakPort, p.keycloakTlsName),
    ja = proxy(p.authPort, p.authTlsName);
  return `worker_processes 1;
pid ${p.root}/nginx.pid;
error_log ${p.root}/error.log crit;
events { worker_connections 256; }
http {
  client_body_temp_path ${p.root}/body;
  proxy_temp_path ${p.root}/proxy;
  fastcgi_temp_path ${p.root}/fastcgi;
  uwsgi_temp_path ${p.root}/uwsgi;
  scgi_temp_path ${p.root}/scgi;
  log_format bounded '$request_method $uri $status $upstream_status';
  access_log ${p.root}/access.log bounded;
  server_tokens off;
  limit_req_zone $binary_remote_addr zone=oidc:1m rate=${p.loginRate}r/s;
  limit_req_status 429;
  server {
    listen 127.0.0.1:${p.listenPort} ssl;
    server_name ${p.hostname};
    ssl_certificate ${p.certificate};
    ssl_certificate_key ${p.privateKey};
    ssl_protocols TLSv1.2 TLSv1.3;
    if ($host != ${p.hostname}) { return 421; }
    client_max_body_size 64k;
    client_header_timeout 10s;
    client_body_timeout 10s;
    keepalive_timeout 10s;
    proxy_connect_timeout 3s;
    proxy_read_timeout 15s;
    proxy_send_timeout 15s;
    proxy_http_version 1.1;
    proxy_set_header Host ${p.hostname}:${p.listenPort};
    proxy_set_header X-Forwarded-Host ${p.hostname};
    proxy_set_header X-Forwarded-Port ${p.listenPort};
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Forwarded "";
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection "";
    proxy_redirect off;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    location ~ "^/realms/[a-zA-Z0-9_-]{1,128}/protocol/openid-connect/(auth|token)$" {
      limit_req zone=oidc burst=${p.loginBurst} nodelay;
      ${kc}
    }
    location ~ "^/realms/[a-zA-Z0-9_-]{1,128}/login-actions/" {
      limit_req zone=oidc burst=${p.loginBurst} nodelay;
      ${kc}
    }
    location ~ "^/realms/[a-zA-Z0-9_-]{1,128}/protocol/openid-connect/(logout|certs)$" { ${kc} }
    location ~ "^/realms/[a-zA-Z0-9_-]{1,128}/\\.well-known/openid-configuration$" { ${kc} }
    location ^~ /resources/ { ${kc} }
    location ^~ /auth/ { ${ja} }
    location / { return 404; }
  }
}
`;
}
