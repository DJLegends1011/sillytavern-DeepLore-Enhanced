/** DeepLore — Slash Commands Orchestrator. Delegates to sub-modules. */
import { registerPipelineCommands } from './commands-pipeline.js';
import { registerVaultCommands } from './commands-vault.js';
import { registerAiCommands } from './commands-ai.js';
import { registerGatingCommands } from './commands-gating.js';
import { registerAdminCommands } from './commands-admin.js';
import { registerLintCommand } from './commands-lint.js';

export function registerSlashCommands() {
    registerPipelineCommands();
    registerVaultCommands();
    registerAiCommands();
    registerGatingCommands();
    registerAdminCommands();
    registerLintCommand();
}
