/**
 * DeepLore Enhanced — Emma bootstrap prompts + seeded greetings.
 *
 * Historically held inline string constants. As of v2.5, the 5 prompt strings
 * (EMMA_*_GREETING, DLE_PRIMER_FOR_EMMA, FIRSTRUN_QA_SCRIPT) live in the
 * canonical EN dict at `src/i18n/prompts/en.js` under their formal names
 * (EMMA_*_GREETING, LIBRARIAN_PRIMER, LIBRARIAN_FIRSTRUN_QA_SCRIPT) and are
 * resolved at call time via `getPrompt(key)`. The constants were renamed
 * during the migration:
 *
 *   DLE_PRIMER_FOR_EMMA  → LIBRARIAN_PRIMER
 *   FIRSTRUN_QA_SCRIPT   → LIBRARIAN_FIRSTRUN_QA_SCRIPT
 *
 * Old import paths from this file are dropped — callers must import
 * `getPrompt` from `../prompts/prompt-store.js` and pass the canonical key.
 */
import { vaultIndex } from '../state.js';
import { getSettings } from '../../settings.js';
import { getPrompt } from '../prompts/prompt-store.js';

/**
 * Hidden system-prompt fragment for guide-mode sessions.
 * @param {{ includeFirstRunScript?: boolean }} opts
 */
export function buildLibrarianBootstrapSystemPrompt({ includeFirstRunScript = false } = {}) {
    const settings = getSettings();
    const cap = Math.max(1000, Number(settings.librarianManifestMaxChars) || 8000);

    // Constants only — the always-injected world backbone.
    const constants = vaultIndex.filter(e => e.constant && !e.guide);
    let snapshot;
    if (constants.length === 0) {
        snapshot = '## Current vault snapshot\n\nThe vault is currently empty — the user is starting from scratch.';
    } else {
        const lines = [];
        let used = 0;
        for (const e of constants) {
            const blurb = (e.summary || e.content || '').replace(/\s+/g, ' ').trim().slice(0, 200);
            const line = `- **${e.title}** — ${blurb}`;
            if (used + line.length > cap) {
                lines.push(`- ...(${constants.length - lines.length} more constants not shown)`);
                break;
            }
            lines.push(line);
            used += line.length + 1;
        }
        snapshot = `## Current vault snapshot (constants — always-injected backbone)\n\n${lines.join('\n')}`;
    }

    const parts = [getPrompt('LIBRARIAN_PRIMER'), snapshot];
    if (includeFirstRunScript) parts.push(getPrompt('LIBRARIAN_FIRSTRUN_QA_SCRIPT'));
    return parts.join('\n\n');
}
