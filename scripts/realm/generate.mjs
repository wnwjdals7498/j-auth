import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadContracts } from './contracts-loader.mjs';
import {
  buildCustomerBootstrapPlan,
  buildCustomerRealm,
  buildOperatorBootstrapPlan,
  buildSampleRealm,
  buildSampleRealms,
  buildSampleBootstrapPlan,
  validateRealmImportStructure,
} from './templates.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/realm/generate.mjs customer <tenantId> [serviceId ...]',
    '  node scripts/realm/generate.mjs sample <operator|sample-a|sample-b|sample-c>',
    '  node scripts/realm/generate.mjs samples',
    '  node scripts/realm/generate.mjs plan <tenantId> [serviceId ...]',
    '  node scripts/realm/generate.mjs sample-plan <operator|sample-a|sample-b|sample-c>',
  ].join('\n');
}

function validateRealm(realm, contracts) {
  const errors = validateRealmImportStructure(realm, contracts);
  if (errors.length > 0) {
    throw new Error(`Generated realm failed structural checks: ${errors.join(' ')}`);
  }
  return realm;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(args) {
  const [command, name, ...selectedServiceIds] = args;
  if (!command) {
    throw new Error(usage());
  }

  const contracts = await loadContracts();
  if (command === 'customer') {
    if (!name) throw new Error(usage());
    printJson(validateRealm(buildCustomerRealm({ tenantId: name, selectedServiceIds }, contracts), contracts));
    return;
  }
  if (command === 'sample') {
    if (!name || selectedServiceIds.length > 0) throw new Error(usage());
    printJson(validateRealm(buildSampleRealm(name, contracts), contracts));
    return;
  }
  if (command === 'samples') {
    if (name || selectedServiceIds.length > 0) throw new Error(usage());
    printJson(buildSampleRealms(contracts).map((realm) => validateRealm(realm, contracts)));
    return;
  }
  if (command === 'plan') {
    if (!name) throw new Error(usage());
    printJson(buildCustomerBootstrapPlan({ tenantId: name, selectedServiceIds }, contracts));
    return;
  }
  if (command === 'sample-plan') {
    if (!name || selectedServiceIds.length > 0) throw new Error(usage());
    printJson(name === 'operator'
      ? buildOperatorBootstrapPlan(contracts)
      : buildSampleBootstrapPlan(name, contracts));
    return;
  }

  throw new Error(usage());
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
