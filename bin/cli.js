#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { registerScan } from '../src/commands/scan.js';
import { registerInspect } from '../src/commands/inspect.js';
import { registerFind } from '../src/commands/find.js';
import { registerReport } from '../src/commands/report.js';
import { registerDashboard } from '../src/commands/dashboard.js';
import { registerValidate } from '../src/commands/validate.js';

const program = new Command();

program
  .name('oclaw-cost-debugger')
  .description(chalk.bold('🔍 Scan OpenClaw sessions and diagnose token burn'))
  .version('1.0.0');

registerScan(program);
registerInspect(program);
registerFind(program);
registerReport(program);
registerDashboard(program);
registerValidate(program);

program.parse();
