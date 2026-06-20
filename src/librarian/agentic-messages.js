/**
 * DeepLore Enhanced — Agentic loop message assembly.
 */
import { getContext } from '../../../../../extensions.js';
import { chat_metadata } from '../../../../../../script.js';
import { getPrompt, resolvePromptOrOverride } from '../prompts/prompt-store.js';

/**
 * Indexed-placeholder interpolation: `interp("${0} of ${1}", "A", "B")` → `"A of B"`.
 * Used to substitute runtime values (nonce, tool counts, plural-s, max search/flag
 * limits, name2) into AGENTIC_* prompt strings from the canonical EN dict (or the
 * locale-active dict, or the user's vault override). Numeric indices only —
 * named placeholders are not supported by design (the dict declares `${0}`,
 * `${1}` etc. and the validator enforces parity).
 *
 * @param {string} template
 * @param  {...any} args
 * @returns {string}
 */
function interp(template, ...args) {
    return String(template ?? '').replace(/\$\{(\d+)\}/g, (_, idx) => {
        const v = args[Number(idx)];
        return v == null ? '' : String(v);
    });
}

// ════════════════════════════════════════════════════════════════════════════
// System Prompt Builder
// ════════════════════════════════════════════════════════════════════════════

// BUG-AUDIT (prompt-injection hardening): untrusted content (vault entries, char
// card, notebook, notepad, scribe summary) is wrapped in XML fences whose tag
// name carries a per-build random nonce. Attacker prose inside an entry can't
// forge a closing tag without knowing it. Also strips any pre-existing nonce
// tags from content before wrapping (defense in depth), and the role section
// re-states the data-not-instructions rule.

// 12 hex chars (~48 bits) — unguessable from inside attacker content.
function randomNonce() {
    try {
        if (globalThis.crypto?.getRandomValues) {
            const bytes = new Uint8Array(6);
            globalThis.crypto.getRandomValues(bytes);
            return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        }
    } catch { /* fall through to Math.random fallback */ }
    return Math.random().toString(36).slice(2, 14);
}

/** Strip `<dle_*_NONCE>` / `</dle_*_NONCE>` so attackers can't forge a closing fence. */
function scrubFences(content, nonce) {
    if (!content) return '';
    const re = new RegExp(`</?dle_[a-z_]+_${nonce}[^>]*>`, 'gi');
    return String(content).replace(re, '');
}

function fence(kind, header, content, nonce) {
    const tag = `dle_${kind}_${nonce}`;
    const safe = scrubFences(content, nonce);
    return `[${header}]\n<${tag}>\n${safe}\n</${tag}>`;
}

/**
 * Build the 9-section system prompt. Static per loop run.
 * @param {string} pipelineContext
 * @param {Set<string>} injectedTitles - lowercased
 * @param {object} settings
 */
export function buildSystemPromptForLoop(pipelineContext, injectedTitles, settings) {
    const ctx = getContext();
    const name2 = ctx?.name2 || 'Character';
    const charFields = ctx?.getCharacterCardFields?.() || {};

    const sections = [];
    const nonce = randomNonce();

    // Section 1: Role + Constraints. Explicit fence rule so the model treats
    // fenced sections as inert data; nonce makes the tag unguessable from inside.
    // Single template string in the dict — interp injects the nonce as ${0}.
    sections.push(interp(getPrompt('AGENTIC_ROLE_SECTION'), nonce));

    // Section 2: Character Context
    {
        const desc = charFields.description || '';
        const personality = charFields.personality || '';
        const scenario = charFields.scenario || '';
        const persona = [desc, personality].filter(Boolean).join('\n').slice(0, 600);
        const charSection = [];
        if (persona) charSection.push(fence('character', interp(getPrompt('AGENTIC_FENCE_CHARACTER_HEADER'), name2), persona, nonce));
        if (scenario) charSection.push(fence('scenario', getPrompt('AGENTIC_FENCE_SCENARIO_HEADER'), scenario, nonce));
        if (charSection.length) sections.push(charSection.join('\n'));
    }

    // Section 3: Pipeline Lore Context
    if (pipelineContext?.trim()) {
        sections.push(fence('lore_context', getPrompt('AGENTIC_FENCE_LORE_CONTEXT_HEADER'), pipelineContext, nonce));
    }

    // Section 4: Injected Entry List. Fenced so a crafted title can't break out.
    if (injectedTitles.size > 0) {
        const titleList = [...injectedTitles].map(t => `- ${t}`).join('\n');
        sections.push(fence('injected_titles', getPrompt('AGENTIC_FENCE_INJECTED_TITLES_HEADER'), titleList, nonce));
    }

    // Section 5: Author's Notebook
    if (settings.notebookEnabled) {
        const notebook = chat_metadata?.deeplore_notebook;
        if (notebook?.trim()) {
            sections.push(fence('notebook', getPrompt('AGENTIC_FENCE_NOTEBOOK_HEADER'), notebook, nonce));
        }
    }

    // Section 6: AI Notepad
    if (settings.aiNotepadEnabled) {
        const notepad = chat_metadata?.deeplore_ai_notepad;
        if (notepad?.trim()) {
            sections.push(fence('notepad', getPrompt('AGENTIC_FENCE_NOTEPAD_HEADER'), notepad, nonce));
        }
        // notepadPrompt is user-configurable but trusted (settings write is out of
        // scope for prompt-injection) — no fence.
        if ((settings.aiNotepadMode || 'tag') === 'tag') {
            // Trim-then-default matches index.js notepad fallback. Whitespace-only
            // must fall back to default so tag-mode keeps emitting <dle-notes>.
            const notepadPrompt = resolvePromptOrOverride('AI_NOTEPAD_PROMPT', settings.aiNotepadPrompt);
            if (notepadPrompt) sections.push(notepadPrompt);
        }
    }

    // Section 7: Scribe Summary. AI-generated but derives from chat transcript
    // (includes persona/character-card text) — treat as untrusted.
    if (settings.scribeInformedRetrieval) {
        const scribeSummary = chat_metadata?.deeplore_lastScribeSummary;
        if (scribeSummary?.trim()) {
            sections.push(fence('scribe_summary', getPrompt('AGENTIC_FENCE_SCRIBE_HEADER'), scribeSummary, nonce));
        }
    }

    const maxSearches = settings.librarianMaxSearches || 2;
    const maxFlags = 5; // H5
    const toolInstructions = buildToolInstructions(settings, maxSearches, maxFlags);
    sections.push(toolInstructions);

    const promptMode = settings.librarianSystemPromptMode || 'default';
    const customPrompt = settings.librarianCustomSystemPrompt || '';
    if (promptMode === 'strict-override' && customPrompt.trim()) {
        // Pure passthrough — customPrompt IS the entire system prompt.
        return customPrompt;
    }
    if (promptMode === 'append' && customPrompt.trim()) {
        sections.push(customPrompt);
    } else if (promptMode === 'override' && customPrompt.trim()) {
        // Replace role + tool instructions only; manifest/gap/chat/scribe remain.
        sections[0] = '';
        sections[sections.length - 1] = '';
        sections.push(customPrompt);
    }

    return sections.filter(Boolean).join('\n\n');
}

function buildToolInstructions(settings, maxSearches, maxFlags) {
    const parts = [];
    const searchEnabled = settings.librarianSearchEnabled !== false;
    const flagEnabled = settings.librarianFlagEnabled !== false;

    let toolCount = 1; // write always available
    if (searchEnabled) toolCount++;
    if (flagEnabled) toolCount++;

    // AGENTIC_TOOLS_INTRO carries `${0}` (tool count) + `${1}` (plural suffix).
    parts.push(interp(getPrompt('AGENTIC_TOOLS_INTRO'), toolCount, toolCount !== 1 ? 's' : ''));
    parts.push('');

    if (searchEnabled) {
        // AGENTIC_TOOL_SEARCH carries `${0}` = max search calls.
        parts.push(interp(getPrompt('AGENTIC_TOOL_SEARCH'), maxSearches));
        parts.push('');
    }

    parts.push(getPrompt('AGENTIC_TOOL_WRITE'));
    if (flagEnabled) {
        parts.push(getPrompt('AGENTIC_TOOL_WRITE_FLAG_HINT'));
    }
    parts.push('');

    if (flagEnabled) {
        // AGENTIC_TOOL_FLAG carries `${0}` = max flags.
        parts.push(interp(getPrompt('AGENTIC_TOOL_FLAG'), maxFlags));
        parts.push('');
    }

    const workflow = [getPrompt('AGENTIC_WORKFLOW_STEP_SEARCH'), getPrompt('AGENTIC_WORKFLOW_STEP_WRITE')];
    // AGENTIC_WORKFLOW_STEP_FLAG carries `${0}` = max flags.
    if (flagEnabled) workflow.push(interp(getPrompt('AGENTIC_WORKFLOW_STEP_FLAG'), maxFlags));
    workflow.push(getPrompt('AGENTIC_WORKFLOW_STEP_END'));
    // AGENTIC_WORKFLOW carries `${0}` = arrow-joined workflow steps.
    parts.push(interp(getPrompt('AGENTIC_WORKFLOW'), workflow.join(' → ')));
    parts.push('');
    parts.push(getPrompt('AGENTIC_IMPORTANT_FINAL'));

    return parts.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// Chat Messages Builder
// ════════════════════════════════════════════════════════════════════════════

/** G5: count-based cap. Fallback when no settings override is provided. */
const DEFAULT_AGENTIC_HISTORY_MESSAGES = 40;

/**
 * @param {Array} chatArray - ST's chat[]
 * @param {string} pipelineContext
 * @param {Set<string>} injectedTitles - lowercased
 * @param {object} settings
 * @returns {Array<{role: string, content: string}>}
 */
export function buildChatMessages(chatArray, pipelineContext, injectedTitles, settings) {
    const systemPrompt = buildSystemPromptForLoop(pipelineContext, injectedTitles, settings);

    const messages = [
        { role: 'system', content: systemPrompt },
    ];

    const rawCap = Number(settings?.librarianAgenticHistoryMessages);
    const historyCap = Number.isFinite(rawCap) && rawCap >= 1 ? rawCap : DEFAULT_AGENTIC_HISTORY_MESSAGES;
    const history = [];
    let count = 0;
    for (let i = chatArray.length - 1; i >= 0 && count < historyCap; i--) {
        const msg = chatArray[i];

        if (msg?.is_system) continue;
        if (msg?.extra?.tool_invocations) continue;

        const role = msg?.is_user ? 'user' : 'assistant';
        const content = msg?.mes || '';
        if (!content.trim()) continue;

        history.push({ role, content });
        count++;
    }

    history.reverse();

    // Strict alternation — merge consecutive same-role messages.
    const alternated = [];
    for (const msg of history) {
        if (alternated.length > 0 && alternated[alternated.length - 1].role === msg.role) {
            alternated[alternated.length - 1].content += '\n\n' + msg.content;
        } else {
            alternated.push({ ...msg });
        }
    }

    // Last message must be 'user' — the turn that triggered generation.
    if (alternated.length > 0 && alternated[alternated.length - 1].role !== 'user') {
        alternated.pop();
    }

    // L-17: never return a system-only array. If every chat message was
    // empty/whitespace (filtered at the !content.trim() guard above) or the only
    // surviving tail was an assistant turn (popped just above), `alternated` can be
    // empty — leaving `[system]`, which every provider rejects with a 400 (no user
    // turn). Synthesize a minimal continuation user turn so the request is always
    // well-formed and the writing AI still produces prose.
    if (alternated.length === 0) {
        alternated.push({ role: 'user', content: '(continue)' });
    }

    messages.push(...alternated);
    return messages;
}
