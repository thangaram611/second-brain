#!/usr/bin/env node

import { Command } from 'commander';
import {
  registerInitResetCommands,
  registerAdminCommand,
  registerDoctorCommand,
} from './commands/init-reset.js';
import { registerAddCommand } from './commands/add.js';
import { registerSearchCommand } from './commands/search.js';
import { registerStatusCommand } from './commands/status.js';
import { registerDecideCommand } from './commands/decide.js';
import { registerIndexCommand } from './commands/index-cmd.js';
import { registerWatchCommand } from './commands/watch.js';
import { registerEmbedCommand } from './commands/embed.js';
import { registerExportImportCommands } from './commands/export-import.js';
import { registerQueryCommand } from './commands/query.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerTailCommand } from './commands/tail.js';
import { registerRecallCommand } from './commands/recall.js';
import { registerHooksCommands } from './commands/hooks.js';
import { registerWireUnwireCommands } from './commands/wire-unwire.js';
import { registerWireAssistantCommands } from './commands/wire-assistant.js';
import { registerFlipBranchCommand } from './commands/flip-branch.js';
import { registerOwnershipCommand } from './commands/ownership-cmd.js';
import { registerPersonalCommand } from './commands/personal-cmd.js';

const program = new Command();

program
  .name('brain')
  .description('Second Brain — developer knowledge graph CLI')
  .version('0.1.0');

registerInitResetCommands(program);
registerAdminCommand(program);
registerDoctorCommand(program);
registerAddCommand(program);
registerSearchCommand(program);
registerStatusCommand(program);
registerDecideCommand(program);
registerIndexCommand(program);
registerWatchCommand(program);
registerEmbedCommand(program);
registerExportImportCommands(program);
registerQueryCommand(program);
registerSyncCommand(program);
registerTailCommand(program);
registerRecallCommand(program);
registerHooksCommands(program);
registerWireUnwireCommands(program);
registerWireAssistantCommands(program);
registerFlipBranchCommand(program);
registerOwnershipCommand(program);
registerPersonalCommand(program);

program.parse();
