import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compilerVersion = '5.9.3';

function run(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', () => reject(new Error('Could not start the selected TypeScript CLI.')));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function existingFile(candidate) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function selectCompiler() {
  if (process.env.JGW_TYPESCRIPT_CLI) {
    const selected = path.resolve(process.env.JGW_TYPESCRIPT_CLI);
    if (!(await existingFile(selected))) {
      throw new Error('JGW_TYPESCRIPT_CLI must point to an existing TypeScript CLI file.');
    }
    return { path: selected, source: 'JGW_TYPESCRIPT_CLI' };
  }

  const localCompiler = path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (await existingFile(localCompiler)) return { path: localCompiler, source: 'j-auth local TypeScript' };

  const messengerCompiler = path.resolve(repositoryRoot, '..', 'j-messenger', 'node_modules', 'typescript', 'bin', 'tsc');
  if (await existingFile(messengerCompiler)) return { path: messengerCompiler, source: 'existing j-messenger TypeScript' };

  throw new Error('TypeScript 5.9.3 was not found. Set JGW_TYPESCRIPT_CLI to an existing local tsc entry point; the build does not download packages.');
}

async function main() {
  const compiler = await selectCompiler();
  const versionResult = await run(process.execPath, [compiler.path, '--version'], repositoryRoot);
  const reportedVersion = (versionResult.stdout + versionResult.stderr).trim();
  if (versionResult.code !== 0 || !new RegExp('\\b' + compilerVersion.replaceAll('.', '\\.') + '\\b').test(reportedVersion)) {
    throw new Error('The selected TypeScript CLI must be version ' + compilerVersion + '; version output was rejected.');
  }

  const tsconfigPath = path.join(repositoryRoot, 'packages', 'contracts', 'tsconfig.json');
  try {
    await access(tsconfigPath);
  } catch {
    throw new Error('Required contract source is missing: packages/contracts/tsconfig.json.');
  }

  const buildResult = await run(process.execPath, [compiler.path, '--project', tsconfigPath, '--pretty', 'false'], repositoryRoot);
  if (buildResult.stdout) process.stdout.write(buildResult.stdout);
  if (buildResult.stderr) process.stderr.write(buildResult.stderr);
  if (buildResult.code !== 0) throw new Error('The @j-auth/contracts TypeScript build failed.');
  process.stdout.write('Built @j-auth/contracts with TypeScript ' + compilerVersion + ' (' + compiler.source + ').\n');
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : 'Contract build failed.') + '\n');
  process.exitCode = 1;
});
