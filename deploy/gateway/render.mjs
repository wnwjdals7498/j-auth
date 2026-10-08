import { readFile, writeFile, mkdir, lstat, link, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAuthGateway } from './gateway.mjs';
const checkout = fileURLToPath(new URL('../../', import.meta.url));
function inside(parent, target) {
  const rel = path.relative(parent, target);
  return (
    rel === '' ||
    (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
  );
}
async function noSymlink(file) {
  for (let at = path.resolve(file); ; at = path.dirname(at)) {
    try {
      if ((await lstat(at)).isSymbolicLink())
        throw new Error('Symlink output path');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (path.dirname(at) === at) break;
  }
}
try {
  const [flag, profile] = process.argv.slice(2);
  if (
    flag !== '--profile' ||
    !profile ||
    process.argv.length !== 4 ||
    !path.isAbsolute(profile) ||
    inside(checkout, path.resolve(profile))
  )
    throw new Error('Use --profile /external/profile.json');
  if ((await lstat(profile)).size > 65536)
    throw new Error('Profile is too large');
  const p = JSON.parse(await readFile(profile, 'utf8')),
    config = renderAuthGateway(p),
    output = path.join(p.root, 'nginx.conf');
  if (inside(checkout, p.root))
    throw new Error('Gateway output must stay outside checkout');
  await noSymlink(p.root);
  await mkdir(p.root, { recursive: true, mode: 0o700 });
  const partial = path.join(p.root, '.nginx-' + randomUUID() + '.partial');
  try {
    await writeFile(partial, config, { flag: 'wx', mode: 0o600 });
    await link(partial, output);
  } finally {
    await rm(partial, { force: true });
  }
  process.stdout.write(JSON.stringify({ output, activation: false }) + '\n');
} catch {
  process.stderr.write(
    'Auth gateway profile/render failed; no configuration activated.\n',
  );
  process.exitCode = 1;
}
