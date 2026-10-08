import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', () => reject(new Error('Could not start a local Node check.')));
    child.once('close', (code) => resolve(code));
  });
}

async function requiredTests(relativeDirectory, description) {
  const absoluteDirectory = path.join(repositoryRoot, relativeDirectory);
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    throw new Error('Required ' + description + ' test directory is missing: ' + relativeDirectory + '.');
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => path.join(absoluteDirectory, entry.name))
    .sort();
  if (files.length === 0) throw new Error('Required ' + description + ' tests are missing: ' + relativeDirectory + '/*.mjs.');
  return files;
}

async function runTests(relativeDirectory, description) {
  const files = await requiredTests(relativeDirectory, description);
  const exitCode = await runNode(['--test', ...files]);
  if (exitCode !== 0) throw new Error(description + ' tests failed.');
}

async function main() {
  const args = process.argv.slice(2);
  const contractsOnly = args.length === 1 && args[0] === '--contracts-only';
  if (args.length > 0 && !contractsOnly) {
    throw new Error('Usage: node scripts/check.mjs [--contracts-only]');
  }

  const buildExitCode = await runNode([path.join(repositoryRoot, 'scripts', 'build-contracts.mjs')]);
  if (buildExitCode !== 0) throw new Error('The contract build failed.');

  await runTests(path.join('packages', 'contracts', 'test'), 'contract');
  if (contractsOnly) {
    process.stdout.write('Checks completed for contracts only.\n');
    return;
  }

  await runTests(path.join('tests', 'config'), 'runtime configuration');
  await runTests(path.join('tests', 'realm'), 'realm configuration');
  process.stdout.write('Checks completed for contracts, runtime configuration, and realm configuration.\n');
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : 'Check failed.') + '\n');
  process.exitCode = 1;
});
