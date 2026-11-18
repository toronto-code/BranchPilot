import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { inspectMuseCadBudget, loadMuseCadBudget } from '../dist/src/campaign-budget.js';
import { inspectMuseSpendLimit, readMuseSpendLedger } from '../dist/src/muse-gateway.js';

const { values: args } = parseArgs({ options: { ledger: { type: 'string' }, budget: { type: 'string' } } });
if (!args.ledger || !args.budget) throw Error('--ledger and --budget are required');
const ledgerFile = resolve(args.ledger);
const policy = loadMuseCadBudget(resolve(args.budget), ledgerFile);
const ledger = readMuseSpendLedger(ledgerFile);
const cash = inspectMuseCadBudget(policy, ledger.entries);
const nominal = inspectMuseSpendLimit(ledger);
const report = { ...cash, ...nominal, canDispatch: cash.canDispatch && nominal.canReserveNominal };
console.log(JSON.stringify(report, null, 2));
if (!report.canDispatch) process.exitCode = 1;
