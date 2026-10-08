import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONTRACTS_DIST_PATH = fileURLToPath(
  new URL('../../packages/contracts/dist/index.js', import.meta.url),
);

const REQUIRED_EXPORTS = [
  'SERVICE_CATALOG',
  'CLIENT_IDS',
  'IDENTITY_ROLES',
  'OIDC_PATHS',
  'TOKEN_POLICY',
  'assertCustomerTenantId',
  'customerRealmName',
  'getTenantServices',
  'getTenantAdminRoles',
  'getGrantableRoles',
];

function missingBuildError(path) {
  return new Error(
    `Compiled @j-auth/contracts is missing or unreadable at ${path}. ` +
      'Build the shared contracts first from j-auth with: node scripts/build-contracts.mjs',
  );
}

export async function loadContracts({ contractsPath = CONTRACTS_DIST_PATH } = {}) {
  const absolutePath = resolve(contractsPath);
  try {
    await access(absolutePath, fsConstants.R_OK);
  } catch {
    throw missingBuildError(absolutePath);
  }

  let contracts;
  try {
    contracts = await import(pathToFileURL(absolutePath).href);
  } catch (cause) {
    throw new Error(
      `Unable to import compiled @j-auth/contracts at ${absolutePath}. ` +
        'Rebuild the shared contracts before generating realm JSON.',
      { cause },
    );
  }

  const missing = REQUIRED_EXPORTS.filter((name) => !(name in contracts));
  if (missing.length > 0) {
    throw new Error(
      `Compiled @j-auth/contracts is missing required exports: ${missing.join(', ')}. ` +
        'Rebuild the shared contracts before generating realm JSON.',
    );
  }

  return contracts;
}
