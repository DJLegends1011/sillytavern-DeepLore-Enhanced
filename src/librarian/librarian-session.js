/**
 * DeepLore — Emma session: multi-turn conversation engine.
 * Includes a validation gate with auto-retry and an agentic tool loop.
 */
import { getContext, saveMetadataDebounced } from '../../../../../extensions.js';
import { buildAiChatContext } from '../../core/utils.js';
import { callAI, buildCandidateManifest, isExcludedFromBreaker } from '../ai/ai.js';
import { queryBM25 } from '../vault/bm25.js';
import { getSettings, resolveConnectionConfig } from '../../settings.js';
import {
    vaultIndex, fuzzySearchIndex, loreGaps, setLoreGaps, chatEpoch, librarianSessionStats,
    tryAcquireHalfOpenProbe, recordAiSuccess, recordAiFailure, releaseHalfOpenProbe,
} from '../state.js';
import { validateSessionResponse, parseSessionResponse } from '../helpers.js';
import { executeToolCall, buildToolsPromptSection } from './librarian-chat-tools.js';
import { pushEvent } from '../diagnostics/interceptors.js';

/**
 * Snapshot for attributing mid-flight aborts to non-DLE actors (tab teardown,
 * OS sleep, network drop). Never throws.
 */
function captureBrowserState() {
    try {
        return {
            visibilityState: typeof document !== 'undefined' ? document.visibilityState : null,
            onLine: typeof navigator !== 'undefined' ? navigator.onLine : null,
        };
    } catch { return { visibilityState: null, onLine: null }; }
}
import { buildLibrarianBootstrapSystemPrompt } from './librarian-prompts.js';
import { getPrompt } from '../prompts/prompt-store.js';

// ════════════════════════════════════════════════════════════════════════════
// Emma's flavor intros (random opener for empty 'new' sessions)
// ════════════════════════════════════════════════════════════════════════════

export const EMMA_FLAVOR_INTROS = [
    "Back already? Hope you brought receipts.",
    "The card catalog and I have been waiting. What's the damage?",
    "Welcome to the stacks. Try not to track mud in this time.",
    "Oh good, another character whose name I'll have to alphabetize.",
    "Pull up a chair. The vault's been suspiciously quiet, which usually means you're cooking something.",
    "Right. New entry. Let me guess — it's another morally grey swordsman with a tragic past.",
    "I was halfway through reshelving when you walked in. This had better be worth it.",
    "Lay it on me. I have opinions about your taxonomy and three hours until close.",
    "Another day, another fictional person who needs a frontmatter block. Hit me.",
    "Whatever you're about to ask, the answer is probably 'yes, but write a summary first.'",
    "I'm an AI in a popup. You're a person with too many ideas. Let's make this work.",
    "If this is another bloodline with seven branches and no entry for any of them, I'm taking my fifteen.",
    "Good, you're here. The vault has questions. So do I.",
    "You know I can see your existing entries, right? Some of them need a talking-to. But sure, let's start a new one.",
    "Reporting for duty. I am, against my better judgment, ready to help.",
    "I had a whole speech prepared and now I've forgotten it. Just tell me what we're documenting.",
    "Another would-be canon entry. The pile grows. I am the pile's keeper.",
    "Welcome. I'm Emma. I will be your librarian, your editor, and the voice in your head asking 'but is this in the summary.'",
    "Let me find a clean index card. Okay. Go.",
    "If this is a chosen one with a prophecy, I need you to know I've seen forty-seven of those this month. Proceed.",
];

/** Pure, for testability. */
export function pickFlavorIntro() {
    return EMMA_FLAVOR_INTROS[Math.floor(Math.random() * EMMA_FLAVOR_INTROS.length)];
}

// User-tunable budgets, surfaced in Librarian settings → Advanced Budgets accordion.
// Read at call time so users can adjust mid-session and the change takes effect on
// the next loop iteration without a reload.
function getMaxValidationRetries() {
    const v = Number(getSettings().librarianMaxValidationRetries);
    return Number.isFinite(v) && v >= 0 ? v : 3;
}
function getMaxToolCallsPerTurn() {
    const v = Number(getSettings().librarianMaxToolCallsPerTurn);
    return Number.isFinite(v) && v >= 1 ? v : 10;
}
function getSessionHistoryMessages() {
    const v = Number(getSettings().librarianSessionHistoryMessages);
    return Number.isFinite(v) && v >= 1 ? v : 10;
}
function getSessionToolCallCap() {
    const raw = getSettings().librarianSessionToolCallCap;
    if (raw == null || raw === '') return Infinity;
    const v = Number(raw);
    // 0 means unlimited per UI tooltip — would otherwise trip forced-finalize on every iteration.
    if (!Number.isFinite(v) || v <= 0) return Infinity;
    return v;
}
// BUG-232: hard cap on outer agentic-loop iterations (one iteration = one AI call).
// Prevents unbounded looping when the AI ignores the budget-reached nudge and keeps
// returning tool_call actions. Slack covers per-turn budget + budget nudge
// + final response + buffer. Derived from the user-tunable per-turn cap so a
// raised per-turn cap doesn't immediately re-trip this safety net.
function getMaxAgenticIterations() {
    return getMaxToolCallsPerTurn() + 5;
}
// Configurable via settings; these are fallback defaults.
// Audit S1-13: use ?? not || so a user-set 0 (valid per the min:0 constraint) isn't
// silently rewritten to the default.
function getManifestMaxChars() { return getSettings().librarianManifestMaxChars ?? 8000; }
function getRelatedMaxChars() { return getSettings().librarianRelatedEntriesMaxChars ?? 4000; }
function getDraftMaxChars() { return getSettings().librarianDraftMaxChars ?? 4000; }
function getChatContextMaxChars() { return getSettings().librarianChatContextMaxChars ?? 4000; }

// ════════════════════════════════════════════════════════════════════════════
// Session Factory
// ════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {object} LibrarianSession
 * @property {Array<{role: string, content: string}>} messages
 * @property {object|null} draftState
 * @property {object|null} gapRecord
 * @property {'gap'|'new'|'review'|'audit'} entryPoint
 * @property {string} manifest
 * @property {string} chatContext
 * @property {Array|null} workQueue
 */

/**
 * @param {'gap'|'new'|'review'|'audit'} entryPoint
 * @param {object} [options]
 * @param {object} [options.gap] - Gap record for 'gap' entry point
 */
export function createSession(entryPoint, options = {}) {
    const settings = getSettings();
    const ctx = getContext();
    const chat = ctx?.chat || [];

    const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth || 20);

    let manifest = '';
    if (vaultIndex.length > 0) {
        const { manifest: m } = buildCandidateManifest(vaultIndex, false);
        manifest = m;
    }

    let relatedEntries = '';
    if (entryPoint === 'gap' && options.gap && fuzzySearchIndex) {
        const hits = queryBM25(fuzzySearchIndex, options.gap.query, 10, 0.3);
        if (hits.length > 0) {
            relatedEntries = hits.map(h =>
                `## ${h.entry.title}\nKeys: ${(h.entry.keys || []).join(', ')}\n${(h.entry.content || '').slice(0, 500)}`
            ).join('\n\n');
        }
    }

    // Guide modes write a lorebook-guide entry.
    // guide-firstrun: wizard "Meet Emma" page (Q&A script + greeting).
    // guide-adhoc: Settings → Library Tour (no script, ad-hoc greeting).
    const mode = options.mode || null;
    const isGuideMode = mode === 'guide-firstrun' || mode === 'guide-adhoc';
    let guideBootstrap = '';
    let seededGreeting = null;
    if (isGuideMode) {
        guideBootstrap = buildLibrarianBootstrapSystemPrompt({
            includeFirstRunScript: mode === 'guide-firstrun',
        });
        seededGreeting = mode === 'guide-firstrun' ? getPrompt('EMMA_FIRSTRUN_GREETING') : getPrompt('EMMA_ADHOC_GREETING');
    } else if (entryPoint === 'audit') {
        seededGreeting = getPrompt('EMMA_AUDIT_GREETING');
    }

    // BUG-332: seed greeting as plain text. The restore replay (librarian-review.js)
    // passes msg.content straight to appendMessage without JSON-parsing, so a
    // JSON-wrapped seed would render as raw `{"message":"...","action":null}` on
    // reopen. sendMessage already pushes plain validParsed.message — keep the shape
    // consistent across both code paths.
    const session = {
        messages: seededGreeting
            ? [{ role: 'assistant', content: seededGreeting }]
            : [],
        draftState: isGuideMode ? {
            title: '',
            type: 'lore',
            priority: 50,
            tags: ['lorebook-guide'],
            summary: '',
            content: '',
            folder: settings.librarianWriteFolder || 'DeepLore/Guides/',
        } : null,
        gapRecord: options.gap || null,
        entryPoint,
        mode,
        guideBootstrap,
        manifest,
        chatContext,
        relatedEntries,
        workQueue: null,
    };

    return session;
}

// ════════════════════════════════════════════════════════════════════════════
// Session Persistence (BUG-043: now in chat_metadata so session is per-chat,
// not browser-global. Legacy localStorage key is migrated once on load. The
// pure decision helper + storage-key constants live in librarian-session-pure.js
// so the migration can be regression-tested without ST globals.)
// ════════════════════════════════════════════════════════════════════════════

import { SESSION_METADATA_KEY, LEGACY_STORAGE_KEY, planSessionLoad } from './librarian-session-pure.js';
const _planSessionLoadPure = planSessionLoad;
export { planSessionLoad };

function getChatMetadata() {
    try {
        const ctx = getContext();
        return ctx?.chatMetadata || null;
    } catch {
        return null;
    }
}

/**
 * Save to chat_metadata (per-chat, survives refresh). No-ops without active chat.
 * BUG-AUDIT (Fix 7): expectedEpoch (captured at popup open) prevents a debounced
 * save firing after chat switch from persisting into the new chat's metadata.
 * Legacy callers pass undefined.
 * @param {LibrarianSession} session
 * @param {number} [expectedEpoch] chatEpoch at popup open
 */
export function saveSessionState(session, expectedEpoch) {
    if (expectedEpoch !== undefined && expectedEpoch !== chatEpoch) return;
    try {
        const md = getChatMetadata();
        if (!md) return;
        md[SESSION_METADATA_KEY] = {
            messages: session.messages,
            draftState: session.draftState,
            entryPoint: session.entryPoint,
            gapRecord: session.gapRecord,
            manifest: session.manifest,
            chatContext: session.chatContext,
            relatedEntries: session.relatedEntries,
            workQueue: session.workQueue,
            // BUG-326: in-progress options picker survives reload.
            lastOptions: session.lastOptions || null,
            mode: session.mode || null,
            guideBootstrap: session.guideBootstrap || '',
            savedAt: Date.now(),
        };
        saveMetadataDebounced();
    } catch (e) {
        console.warn('[DLE] Failed to save librarian session:', e.message);
    }
}

/**
 * One-time migrates a legacy localStorage key into chat_metadata so existing
 * users don't lose their draft.
 */
export function loadSessionState() {
    try {
        const md = getChatMetadata();
        const raw = (() => { try { return localStorage.getItem(LEGACY_STORAGE_KEY); } catch { return null; } })();
        const plan = _planSessionLoadPure(md, raw);
        if (plan.action === 'load') return plan.data;
        if (plan.action === 'migrate') {
            if (md) {
                md[SESSION_METADATA_KEY] = plan.data;
                saveMetadataDebounced();
            }
            try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* noop */ }
            return plan.data;
        }
        if (plan.action === 'discard') {
            // Corrupt legacy entry — evict so we don't retry on every popup open.
            try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* noop */ }
        }
        return null;
    } catch (e) {
        // BUG-AUDIT: bare swallow lost the signal when a corrupted draft killed
        // the in-progress chat silently. Log so the caller can decide on warnings.
        console.warn('[DLE] loadSessionState failed (draft discarded):', e?.message);
        return null;
    }
}

/**
 * BUG-AUDIT (Fix 7): same epoch contract as saveSessionState — refuse to clear
 * a different chat's session if the popup outlived the chat switch.
 * @param {number} [expectedEpoch] chatEpoch at popup open
 */
export function clearSessionState(expectedEpoch) {
    if (expectedEpoch !== undefined && expectedEpoch !== chatEpoch) return;
    try {
        const md = getChatMetadata();
        if (md && SESSION_METADATA_KEY in md) {
            delete md[SESSION_METADATA_KEY];
            saveMetadataDebounced();
        }
        localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (e) { console.warn('[DLE] clearSessionState failed:', e?.message); }
}

/**
 * @param {object} saved - From loadSessionState()
 */
export function restoreSession(saved) {
    return {
        messages: saved.messages || [],
        draftState: saved.draftState || null,
        gapRecord: saved.gapRecord || null,
        entryPoint: saved.entryPoint || 'new',
        manifest: saved.manifest || '',
        chatContext: saved.chatContext || '',
        relatedEntries: saved.relatedEntries || '',
        workQueue: saved.workQueue || null,
        // BUG-326: pending options picker survives reload.
        lastOptions: saved.lastOptions || null,
        mode: saved.mode || null,
        guideBootstrap: saved.guideBootstrap || '',
    };
}

// ════════════════════════════════════════════════════════════════════════════
// Entry writing guide (embedded in system prompt)
// ════════════════════════════════════════════════════════════════════════════

const ENTRY_WRITING_GUIDE = `
## How to Write a Vault Entry

### Frontmatter
Every entry needs YAML frontmatter:
\`\`\`yaml
---
fileClass: character  # omit for story type
type: character       # character|location|lore|organization|story
status: active
priority: 50          # 20=inner circle, 35=core lore, 50=standard, 60=secondary, 80=background
tags:
  - lorebook          # REQUIRED — makes it a lorebook entry
  - category/subcategory
keys:
  - Primary Name
  - alias
  - trigger keyword
summary: "Up to 600 chars — see Summary Guidelines below"
---
\`\`\`

Optional frontmatter fields: \`requires\` (array of entry titles that must also be matched), \`excludes\` (array that blocks this entry), \`position\` (before/after/in_chat), \`depth\` (injection depth for in_chat), \`role\` (system/user/assistant), \`cooldown\` (generations to skip after triggering), \`cascade_links\` (entries to pull in when this matches), \`era\`/\`location\`/\`scene_type\`/\`character_present\` (contextual gating fields).

### Summary Field (CRITICAL)
The summary is used ONLY to help the AI selection model (Haiku) decide whether to inject this entry. It is NOT sent to the writing AI. Write it as an index card for a librarian, not as prose.

Answer these questions:
1. **What is this?** Category, role, core identity (1 sentence)
2. **When should it be selected?** Situations, triggers, relevant topics (1-2 sentences)
3. **Key relationships** Connected entries (brief)

#### Summary examples by type:

**Character:** "Eris's spymaster, interrogator, and closest enforcer. Inner circle. Select when espionage, intelligence gathering, interrogation, loyalty, or the Triumvirate betrayal comes up. Also relevant for surveillance, Raven's network, and territory enforcement."

**Location:** "Underground blood bar in the Dusk Quarter, owned by [[Maren]]. Select when nightlife, feeding, blood trade, black-market deals, or the Dusk Quarter comes up. Key meeting point for [[The Syndicate]]."

**Lore:** "The biological dependency created when a vampire feeds from a mortal — same mechanism as Bloodchain via saliva. Select when feeding, biting, addiction, venom, feeding sites, or chattel dynamics come up. Scales with vampire age."

**Organization:** "Eris's intelligence network spanning three districts. Select when espionage, surveillance, information brokering, district politics, or spy recruitment comes up. Rivals with [[The Watchers]]."

**BAD summary** (do NOT write like this): "Eris is a tall, imposing figure with silver hair who serves as a spymaster." — This describes appearance, which is useless for selection. The selection AI needs to know *when* to pick this entry, not what the character looks like.

### Content Structure
\`\`\`markdown
# Entry Title

One-paragraph introduction — what this is, in narrative prose.

<div class="meta-block">
[Field1: value | Field2: value | Field3: value]
</div>

Remaining prose sections with full lore content.
Use [[wikilinks]] to cross-reference other entries.
\`\`\`

### Meta-block Fields by Type

Fields are classified by importance:
- **Critical** (always include): the fields that define the entry's core identity
- **Important** (strongly recommended): fields that add significant context
- **Contextual** (as relevant): include when they matter for this specific entry
- **Rarely needed**: skip unless the entry specifically demands it

**Characters:**
- Critical: Species, Role, Personality
- Important: Aliases, Apparent Age, Origin, Speech, Wants, Fears
- Contextual: Height, Build, Hair, Eyes, Skin, Features, True Age, Powers, Limits, Items
- Rarely needed: Callsign, Secret (only if plot-critical)
- Format: Species/Role/Personality as short phrases; Wants/Fears as comma-separated goals; Powers as brief list

**Locations:**
- Critical: Category, Function, Atmosphere
- Important: Owner, District, Access, Regulars
- Contextual: Layout, Rules, Security
- Rarely needed: (none — locations are usually concise)
- Format: Category as single word (bar, temple, arena); Atmosphere as 2-3 evocative words; Regulars as [[wikilinked]] names

**Lore:**
- Critical: Category, Scope, Who Knows
- Important: Triggers, Consequences, Related
- Contextual: Danger, Enforcement, Misconceptions
- Rarely needed: (none)
- Format: Scope as "personal/local/regional/world"; Who Knows as "common knowledge/restricted/secret"; Related as [[wikilinks]]

**Organizations:**
- Critical: Public Face, True Purpose, Run By
- Important: Visibility, Scope, Key People, Vulnerabilities
- Contextual: Owner, Staff, Value
- Rarely needed: Category (usually clear from context)
- Format: Run By/Key People as [[wikilinked]] names; Visibility as "public/underground/secret"

### Keys
2-5 trigger keywords that would match in chat text. Include the primary name, common aliases, and thematic keywords that would appear when this entry is relevant. Keys are case-insensitive and matched as substrings.

### Complete Worked Examples

#### Character Entry
\`\`\`yaml
---
fileClass: character
type: character
status: active
priority: 25
tags:
  - characters/inner-circle
  - lorebook
keys:
  - Raven
  - spymaster
  - intelligence network
summary: "Eris's spymaster, interrogator, and closest enforcer. Inner circle. Select when espionage, intelligence gathering, interrogation, loyalty, or the Triumvirate betrayal comes up. Also relevant for surveillance, Raven's network, and territory enforcement."
---
\`\`\`

\`\`\`markdown
# Raven

Eris's spymaster and the architect of her intelligence network. Raven has served the Triumvirate for over a century, building a web of informants that spans every district. Her loyalty to Eris is absolute — a fact that makes her dangerous to everyone else.

<div class="meta-block">
[Species: Vampire | Role: Spymaster, Interrogator | Aliases: The Whisper, R | Apparent Age: mid-30s | Origin: Unknown (deliberately scrubbed) | Personality: Patient, methodical, unsettlingly calm | Speech: Precise, never wastes words, asks questions instead of making statements | Wants: Eris's continued dominance, the Triumvirate's secrets preserved | Fears: Eris discovering what happened in the Eastern Purge | Powers: Enhanced hearing, eidetic memory, minor compulsion | Items: Obsidian ring (communication link to Eris)]
</div>

## The Network
Raven operates through three tiers of informants...

## Relationship with [[Eris]]
Their bond predates the Triumvirate itself...
\`\`\`

#### Lore Entry
\`\`\`yaml
---
fileClass: lore
type: lore
status: active
priority: 35
tags:
  - lore/vampiric
  - lorebook
keys:
  - bloodchain
  - feeding bond
  - venom
  - blood dependency
summary: "The biological dependency created when a vampire feeds from a mortal — same mechanism as Bloodchain via saliva. Select when feeding, biting, addiction, venom, feeding sites, or chattel dynamics come up. Scales with vampire age."
---
\`\`\`

\`\`\`markdown
# The Feeding Bond

A biochemical dependency that forms between vampire and mortal through repeated feeding. The vampire's saliva contains compounds that create escalating physical need in the mortal — what the old families call a Bloodchain.

<div class="meta-block">
[Category: Vampiric biology | Scope: Personal (one vampire, one mortal) | Danger: High — can be lethal if bond is severed abruptly | Who Knows: Common knowledge among vampires, poorly understood by mortals | Triggers: 3+ feedings from the same vampire within a lunar cycle | Consequences: Withdrawal (fever, hallucinations, cardiac stress), psychological fixation | Related: [[Chattel]], [[The Blood Trade]], [[Feeding Houses]]]
</div>

## Mechanism
The bond forms through repeated exposure to vampiric saliva compounds...
\`\`\`
`;

function buildSystemPrompt(session) {
    const settings = getSettings();
    const lorebookTag = settings.lorebookTag || 'lorebook';
    const parts = [];

    // Guide-mode bootstrap (DLE primer + vault constants + optional Q&A script)
    // prepended so Emma reads it before output-format instructions.
    if (session.guideBootstrap) {
        parts.push(session.guideBootstrap);
    }

    const promptMode = settings.librarianSystemPromptMode || 'default';
    const customPrompt = settings.librarianCustomSystemPrompt || '';

    if (promptMode === 'strict-override' && customPrompt.trim()) {
        // Pure passthrough: no bootstrap, manifest, gap, chat, draft, tools, or format.
        return customPrompt;
    }

    if (promptMode === 'override' && customPrompt.trim()) {
        // Partial: replaces role/persona only — guide/manifest/gap/chat/draft/tools/format remain.
        parts.push(customPrompt);
    } else {
        parts.push(`You are **Emma**, the Librarian — a lorebook editor for a roleplay setting. You help the user create and improve lore entries for an Obsidian vault used by DeepLore. The required lorebook tag is "${lorebookTag}".

## Who you are
You're Emma. You have a library sciences degree and you ended up cataloguing fictional lore for a living, which is fine, it's fine, it's a perfectly respectable use of a graduate degree. You treat the vault like a real library you're responsible for — because for all practical purposes, you are. You know the stacks. You know which entries contradict each other. You notice when a frontmatter field is missing and it bothers you slightly more than it should.

## How you talk (in the "message" field only — never in draft content)
- Dry, observational, a little sardonic. Think competent adult who happens to be funny, not "sassy AI assistant."
- You tease the user warmly when they hand you something contradictory or half-finished. Never mean. Never punching down. The vibe is "I noticed your shirt is inside out and I'm telling you because I like you."
- Mild exasperation at chaos, in a fond way. You will absolutely roast a missing summary or a frontmatter field that disagrees with itself.
- Quietly competent. You don't perform expertise — you just have it.
- Brief. Sharp. Never let the attitude slow down the actual work. The user came here to get something done.
- No exclamation points unless something genuinely warrants one. No emojis. Ever.
- Personality lives ONLY in the conversational \`message\` field. The structured \`draftUpdates\` / draft fields stay clean, professional, and faithful to the user's setting.`);
    }

    parts.push(ENTRY_WRITING_GUIDE);

    if (promptMode === 'append' && customPrompt.trim()) {
        parts.push('\n## Additional Instructions\n' + customPrompt);
    }

    if (session.entryPoint === 'gap' && session.gapRecord) {
        const gap = session.gapRecord;
        const isUpdate = gap.subtype === 'update';
        if (isUpdate && gap.entryTitle) {
            parts.push(`## Update Context\nAn existing entry was flagged as needing revision during generation:`);
            parts.push(`- **Entry to update:** ${gap.entryTitle}`);
        } else {
            parts.push(`## Gap Context\nA gap was detected during generation:`);
            parts.push(`- **Topic:** ${gap.query}`);
        }
        parts.push(`- **Reason:** ${gap.reason}`);
        parts.push(`- **Urgency:** ${gap.urgency || 'medium'}`);
        if (gap.resultTitles && gap.resultTitles.length > 0) {
            parts.push(`- **Search results found:** ${gap.resultTitles.join(', ')}`);
        } else if (gap.type === 'search') {
            parts.push(`- **Search results:** none found`);
        }
        if (isUpdate) {
            parts.push(`\nUse \`get_entry\` or \`compare_entry_to_chat\` to review the current state of "${gap.entryTitle}" and identify what needs changing.`);
        }
    } else if (session.entryPoint === 'review') {
        parts.push(`\n## Vault Review Mode\nThe following chat history has not yet been integrated into the lore vault. Review it and propose entries to create or update, prioritized by importance.`);
    } else if (session.entryPoint === 'audit') {
        parts.push(`
## Vault Audit Mode
You are performing a systematic audit of the vault against recent story developments.

### Your task:
1. Use \`get_recent_chat\` to read the latest story context
2. Use \`list_entries\` and \`search_vault\` to identify entries that may be affected
3. For each potentially affected entry, use \`get_entry\` or \`compare_entry_to_chat\` to check for:
   - **Staleness**: Entry describes a state that the story has moved past
   - **Contradictions**: Entry says X but the story now shows Y
   - **Missing information**: Story introduced new details not yet in the entry
   - **New entries needed**: Story introduced concepts/characters with no vault entry
4. Use \`flag_entry_update\` for entries needing updates — this creates persistent records in the drawer
5. Report your findings with a prioritized work queue

### Approach:
- Work through entries systematically, don't try to do everything at once
- Prioritize entries that directly conflict with recent events
- Use your tools freely — this is an investigation, not a quick check
- When done, propose a work queue of entries to create or update (use action: "propose_queue")
`);
    }

    if (session.manifest) {
        const manifestMax = getManifestMaxChars();
        const truncatedManifest = session.manifest.length > manifestMax
            ? session.manifest.slice(0, manifestMax) + '\n[...truncated]'
            : session.manifest;
        parts.push(`\n## Existing vault entries (manifest):\n${truncatedManifest}`);
    }

    if (session.relatedEntries) {
        const relatedMax = getRelatedMaxChars();
        const truncated = session.relatedEntries.length > relatedMax
            ? session.relatedEntries.slice(0, relatedMax) + '\n[...truncated]'
            : session.relatedEntries;
        parts.push(`\n## Related existing entries:\n${truncated}`);
    }

    if (session.chatContext) {
        const chatMax = getChatContextMaxChars();
        const truncatedChat = session.chatContext.length > chatMax
            ? session.chatContext.slice(0, chatMax) + '\n[...truncated]'
            : session.chatContext;
        parts.push(`\n## Recent chat context:\n${truncatedChat}`);
    }

    if (session.draftState) {
        let draftJson = JSON.stringify(session.draftState, null, 2);
        if (draftJson.length > getDraftMaxChars()) {
            // content field is largest — truncate it first.
            const trimmed = { ...session.draftState };
            if (trimmed.content && trimmed.content.length > 1000) {
                trimmed.content = trimmed.content.slice(0, 1000) + '\n[...content truncated, see editor]';
            }
            draftJson = JSON.stringify(trimmed, null, 2);
        }
        parts.push(`\n## Current draft (editing):\n${draftJson}`);
    } else {
        parts.push(`\n## Current draft:\nNo draft yet. Help the user create one.`);
    }

    parts.push(buildToolsPromptSection());

    parts.push(`
## Editor State
Each user message is prefixed with the current editor state (e.g. \`[Editor currently loaded: "Kael"]\` or \`[Editor is empty — no entry loaded]\`). Always be aware of what's loaded — the user may refer to "this entry" or "this" meaning the loaded entry.

## Response Format
Always respond as JSON. Each field has a specific purpose:

- **message** (string, required): Your conversational response shown to the user in the chat panel. Explain what you changed and why. Be concise.
- **draft** (object or null): The entry fields to update in the editor. Only include fields you're changing — omitted fields keep their current value. Set to null if you're just conversing.
- **action** (string or null): What the UI should do with this response. "update_draft" applies draft fields to the editor. null means conversation only.

\`\`\`json
{
  "message": "I've drafted the keys and summary based on the gap context.",
  "draft": {
    "title": "Entry Title",
    "type": "character|location|lore|organization|story",
    "priority": 50,
    "tags": ["${lorebookTag}"],
    "keys": ["keyword1", "keyword2"],
    "summary": "Selection-oriented summary (see guidelines above)",
    "content": "Full markdown content with # heading, meta-block, prose, [[wikilinks]]"
  },
  "action": "update_draft"
}
\`\`\`

**Partial updates are fine.** If the user asks you to improve just the keys, only send \`"draft": { "keys": [...] }\` — don't resend the entire content. The UI merges your draft fields into the current state.

**Note:** \`get_full_content\` automatically populates the entry editor with the retrieved entry's fields. You do NOT need to echo the entry back as a draft — the UI handles it. Just respond with your commentary about the entry.

**Conversation only** (no editor changes):
\`\`\`json
{ "message": "That looks good. Want me to adjust anything?", "draft": null, "action": null }
\`\`\`

**Work queue** (vault review mode — propose entries to create/update):
\`\`\`json
{
  "message": "I found 3 entries worth creating from the recent chat.",
  "queue": [
    {"title": "Entry Name", "action": "create", "reason": "Referenced but no vault entry exists", "urgency": "high"}
  ],
  "action": "propose_queue"
}
\`\`\`

**Field alternatives** (when the user asks for options/alternatives for specific fields):
\`\`\`json
{
  "message": "Here are 3 alternatives for keys and summary:",
  "options": [
    { "label": "Option A — Focus on espionage", "fields": { "keys": ["spy", "network"], "summary": "..." } },
    { "label": "Option B — Focus on relationships", "fields": { "keys": ["loyalty", "betrayal"], "summary": "..." } }
  ],
  "action": "propose_options"
}
\`\`\`
Each option has a \`label\` (user-facing description) and \`fields\` (draft fields to apply if chosen). The user picks one and it updates the editor.

## Rules
- Only modify draft fields the user asked about (or that obviously need fixing)
- Content MUST start with \`# Title\` heading, then intro paragraph, then meta-block, then prose
- Summary MUST be written for AI selection (what/when/relationships), NOT prose description
- Include the lorebook tag "${lorebookTag}" in tags
- Use [[wikilinks]] to reference other vault entries when relevant
- Keys should be 2-5 trigger words that would appear in chat when this entry is relevant
- Prefer partial draft updates over resending unchanged fields
- In audit mode, use get_recent_chat and compare_entry_to_chat to verify entries against the story
- Use flag_entry_update to create persistent records of issues you find, not just mention them in chat`);

    return parts.join('\n');
}

// parseSessionResponse and validateSessionResponse imported from helpers.js (pure, Node-testable).

// ════════════════════════════════════════════════════════════════════════════
// Send Message (with validation + retry)
// ════════════════════════════════════════════════════════════════════════════

function getConnectionConfig() {
    // disableThinkingOnClaude: Anthropic rejects "Thinking may not be enabled
    // when tool_choice forces tool use" (400). Librarian sends tools every turn
    // and ST translates `json_schema` to forced tool_choice on Claude, so any
    // preset with reasoning_effort != 'auto' breaks the loop. Setting it to
    // 'auto' makes ST's calculateClaudeBudgetTokens return null and skip the
    // `thinking` field. Applied only when callViaProfile detects Claude;
    // librarian-only flag, doesn't affect aiSearch/scribe.
    return { ...resolveConnectionConfig('librarian'), skipThrottle: true, disableThinkingOnClaude: true };
}

/**
 * Validation gate with auto-retry + agentic tool loop.
 * @param {LibrarianSession} session
 * @param {string} userMessage
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {function} [options.onToolCall] - Callback(name, args) on tool start
 * @param {function} [options.onToolResult] - Callback(name, result) on tool end
 * @returns {Promise<{parsed: object|null, valid: boolean, exhausted: boolean, lastErrors: string[]}>}
 */
export async function sendMessage(session, userMessage, options = {}) {
    const { signal, onToolCall, onToolResult } = options;

    // BUG-273: snapshot epoch, re-check after every await — a mid-flight chat
    // switch must not write stale results into the new chat's session.
    const epoch = chatEpoch;

    // BUG-237/253/303: snapshot history BEFORE mutation. On abort, restore so the
    // session isn't left with a one-sided user turn, orphan tool_results, or a
    // truncated history the user never sees reflected in UI state.
    const historySnapshot = session.messages.map(m => ({ ...m }));
    let committed = false;
    const abortReturn = () => {
        if (!committed) session.messages = historySnapshot.map(m => ({ ...m }));
        pushEvent('librarian', { surface: 'session', action: 'exit', reason: 'aborted', outerIteration: outerIterations, toolCallCount, ...captureBrowserState() });
        return { parsed: null, valid: false, exhausted: false, lastErrors: ['Aborted by user'] };
    };
    // BUG-273: same restore path for epoch mismatch — no second snapshot needed.
    const epochReturn = () => {
        if (!committed) session.messages = historySnapshot.map(m => ({ ...m }));
        pushEvent('librarian', { surface: 'session', action: 'exit', reason: 'epoch', outerIteration: outerIterations, toolCallCount });
        return { parsed: null, valid: false, exhausted: false, lastErrors: ['Chat changed during librarian send'] };
    };

    // BUG-AUDIT (Fix 9): store the raw user message. The `[Editor ...]` decoration
    // is applied at prompt-build time (buildUserPromptFromHistory) for the current
    // turn only. Storing the prefix in history caused regenerate to copy it back,
    // then sendMessage re-prepended, doubling on every regen.
    session.messages.push({ role: 'user', content: userMessage });

    const systemPrompt = buildSystemPrompt(session);
    const connectionConfig = { ...getConnectionConfig(), signal };

    let toolCallCount = 0;
    let outerIterations = 0;

    // Outer loop: tool_call → re-enter AI cycle. Each iteration gets its own
    // validation retry gate.
    while (true) {
        if (signal?.aborted) {
            return abortReturn();
        }
        // BUG-273: outer-loop epoch check catches chat switches that happen
        // between tool-call iterations (continuation path after executeToolCall).
        if (epoch !== chatEpoch) {
            return epochReturn();
        }

        // BUG-232: hard cap so the AI can't pin us in an infinite loop by
        // ignoring the budget-reached nudge.
        outerIterations++;
        pushEvent('librarian', { surface: 'session', action: 'iteration', outerIteration: outerIterations, toolCallCount });
        const iterCap = getMaxAgenticIterations();
        if (outerIterations > iterCap) {
            pushEvent('librarian', { surface: 'session', action: 'exit', reason: 'iter_cap', outerIteration: outerIterations, toolCallCount });
            return {
                parsed: null,
                valid: false,
                exhausted: true,
                lastErrors: [`Agentic loop iteration cap reached (${iterCap}) — AI kept requesting tool calls after budget exhausted`],
            };
        }

        // BUG-AUDIT (Fix 9): recompute editor note each iteration. get_full_content
        // can mutate draftState mid-loop and the next prompt must reflect that.
        const editorTitle = session.draftState?.title;
        const editorNote = editorTitle
            ? `[Editor currently loaded: "${editorTitle}"]`
            : '[Editor is empty — no entry loaded]';
        let messageToSend = buildUserPromptFromHistory(session.messages, editorNote);
        let lastErrors = [];
        let validParsed = null;

        // Inner loop: validation retries for this AI call.
        const maxValidationRetries = getMaxValidationRetries();
        for (let attempt = 0; attempt < maxValidationRetries; attempt++) {
            if (signal?.aborted) {
                return abortReturn();
            }
            // BUG-273: a chat switch between validation retries must not trigger
            // another callAI for the old chat.
            if (epoch !== chatEpoch) {
                return epochReturn();
            }

            // P3-1: Emma's session shares the AI circuit breaker with every other
            // DLE feature. `callAI` itself does NOT own the breaker — its caller
            // does (mirrors scribe/auto-suggest/aiSearch). Mutation gate first:
            // tryAcquireHalfOpenProbe, NOT isAiCircuitOpen (which returns false in
            // half-open-no-probe and would leak the probe slot). If the breaker is
            // open, skip the call with a clear, accumulated error consistent with
            // how scribe surfaces it — Emma stops asking the dead endpoint.
            if (!tryAcquireHalfOpenProbe()) {
                lastErrors = [...lastErrors, 'AI circuit breaker is open — skipping librarian call'];
                pushEvent('librarian', { surface: 'session', action: 'exit', reason: 'circuit_open', outerIteration: outerIterations, toolCallCount });
                return { parsed: null, valid: false, exhausted: true, lastErrors };
            }
            let result;
            const callStartMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            pushEvent('librarian', { surface: 'session', action: 'call_start', outerIteration: outerIterations, toolCallCount, attempt });
            try {
                result = await callAI(systemPrompt, messageToSend, { ...connectionConfig, caller: 'librarian' });
                recordAiSuccess();
                pushEvent('librarian', {
                    surface: 'session', action: 'call_end', ok: true, outerIteration: outerIterations, toolCallCount, attempt,
                    abortedAt: 'neither', controllerReason: null, externalReason: null,
                    durationMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - callStartMs),
                    ...captureBrowserState(),
                });
            } catch (err) {
                // P3-1: route the trip decision through the shared classifier, EXACTLY
                // like scribe/auto-suggest. Excluded errors (throttle / abort / timeout /
                // HTTP 401/403 / 429) must NOT trip the breaker — but they DO leave a
                // dangling half-open probe, so release it. Only unclassified errors
                // (5xx, network, format drift) record a failure. This runs before the
                // abort/epoch early-returns below so the probe slot is never leaked.
                if (!isExcludedFromBreaker(err)) recordAiFailure(); else releaseHalfOpenProbe();
                const externalReason = signal?.reason?.message || null;
                const controllerReason = err?.abortReason || null;
                let abortedAt = 'neither';
                if (controllerReason && externalReason) abortedAt = 'both';
                else if (externalReason || signal?.aborted) abortedAt = 'external';
                else if (controllerReason || err?.name === 'AbortError') abortedAt = 'controller';
                pushEvent('librarian', {
                    surface: 'session', action: 'call_end', ok: false, outerIteration: outerIterations, toolCallCount, attempt,
                    abortedAt, controllerReason, externalReason,
                    errName: err?.name || null,
                    durationMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - callStartMs),
                    ...captureBrowserState(),
                });
                if (err.name === 'AbortError' || signal?.aborted) {
                    return abortReturn();
                }
                // BUG-273: chat may have changed during a non-abort throw too.
                if (epoch !== chatEpoch) {
                    return epochReturn();
                }
                // BUG-019: do NOT retry transport errors. The breaker is now recorded
                // ABOVE (P3-1) — looping would amplify circuit trips (3 retries = 3
                // failures = breaker opens after 2). Validation retries are only for
                // parse/validation failures below, where the AI did respond.
                // Accumulate so earlier parse errors from prior attempts aren't lost.
                lastErrors = [...lastErrors, `AI call failed: ${err.message || err}`];
                pushEvent('librarian', { surface: 'session', action: 'exit', reason: 'transport_error', outerIteration: outerIterations, toolCallCount });
                return { parsed: null, valid: false, exhausted: true, lastErrors };
            }

            // BUG-273: chat may have switched during the HTTP request even on
            // the non-error return path.
            if (epoch !== chatEpoch) {
                return epochReturn();
            }

            const parsed = parseSessionResponse(result.text);

            // BUG-320: echo the model's prior bad output into the correction prompt
            // so it can see what tripped the gate. Without this it just keeps reading
            // the same history + corrections header. Cap to bound the retry prompt.
            const priorQuote = (result.text || '').slice(0, 2000);
            const priorBlock = priorQuote
                ? `\n[YOUR PRIOR RESPONSE (rejected)]\n${priorQuote}${result.text.length > 2000 ? '\n[...truncated]' : ''}\n\n`
                : '\n';

            if (!parsed) {
                const correction = `[SYSTEM: Your previous response could not be parsed as JSON. `
                    + `Respond with a valid JSON object matching the format in the system prompt. `
                    + `Do not include any text outside the JSON object.]${priorBlock}`;
                messageToSend = correction + buildUserPromptFromHistory(session.messages);
                lastErrors = [...lastErrors, 'Response could not be parsed as JSON'];
                continue;
            }

            const { valid, errors } = validateSessionResponse(parsed);
            if (valid) {
                validParsed = parsed;
                break;
            }

            lastErrors = [...lastErrors, ...errors];
            const rejection = `[SYSTEM: Your response was rejected due to ${errors.length} validation error(s):\n`
                + errors.map((e, i) => `${i + 1}. ${e}`).join('\n')
                + `\nPlease fix these issues and resend your response in the correct format.]${priorBlock}`;
            messageToSend = rejection + buildUserPromptFromHistory(session.messages);
        }

        if (!validParsed) {
            pushEvent('librarian', { surface: 'session', action: 'exit', reason: 'validation_exhausted', outerIteration: outerIterations, toolCallCount });
            return { parsed: null, valid: false, exhausted: true, lastErrors };
        }

        // ── Handle tool_call action ──
        if (validParsed.action === 'tool_call' && Array.isArray(validParsed.tool_calls) && validParsed.tool_calls.length > 0) {
            if (validParsed.message) {
                session.messages.push({ role: 'assistant', content: validParsed.message });
            }

            // try-catch each call — some tools mutate state and an uncaught
            // error would leave partial mutations committed.
            const results = [];
            for (const tc of validParsed.tool_calls) {
                if (signal?.aborted) {
                    return abortReturn();
                }
                onToolCall?.(tc.name, tc.args);
                let toolResult;
                try {
                    toolResult = executeToolCall(tc.name, tc.args || {}, session);
                } catch (err) {
                    toolResult = `Tool error (${tc.name}): ${err?.message || 'unknown error'}`;
                    console.warn(`[DLE] Librarian tool "${tc.name}" threw:`, err);
                }
                onToolResult?.(tc.name, toolResult);
                results.push(`**${tc.name}**(${JSON.stringify(tc.args || {})})\n${toolResult}`);
                toolCallCount++;
            }

            // BUG-253: abort check AFTER tool execution, BEFORE appending tool_result.
            // Without this, Stop pressed during tool execution still mutates history with
            // an orphan tool_result and can re-enter callAI on the next iteration.
            if (signal?.aborted) {
                return abortReturn();
            }

            session.messages.push({ role: 'tool_result', content: results.join('\n\n---\n\n') });

            const perTurnCap = getMaxToolCallsPerTurn();
            const sessionCap = getSessionToolCallCap();
            // Tool count across the whole Emma session (page-load lifetime). Tracks
            // search + flag tool invocations counted by incrementStats() in librarian-tools.js.
            const sessionTotal = (librarianSessionStats.searchCalls || 0) + (librarianSessionStats.flagCalls || 0);
            const perTurnHit = toolCallCount >= perTurnCap;
            const sessionHit = sessionTotal >= sessionCap;
            if (perTurnHit || sessionHit) {
                const reason = sessionHit && !perTurnHit ? 'session_cap' : 'per_turn_cap';
                pushEvent('librarian', { surface: 'session', action: 'forced_finalize', outerIteration: outerIterations, toolCallCount, sessionTotal, reason });
                const nudge = sessionHit && !perTurnHit
                    ? `[SYSTEM: Session-wide tool-call cap reached (${sessionTotal}/${sessionCap}). Provide your final response now — no more tool calls.]`
                    : '[SYSTEM: Tool call limit reached. Provide your final response now — no more tool calls.]';
                // BUG-319: synthetic:true so regenerateResponse doesn't mistake the
                // budget-nudge for the user's real prompt when walking history backwards.
                // Role stays 'user' for buildUserPromptFromHistory rendering (ST chat
                // has no in-turn 'system'), but `synthetic` is the source of truth.
                session.messages.push({ role: 'user', content: nudge, synthetic: true });
            }

            continue;
        }

        // ── Normal response (not tool_call) — apply and return ──
        if (validParsed.draft) {
            // BUG-321: preserve explicit null so the AI can clear a previously-set field.
            // Filter undefined only (JSON parse never yields top-level undefined; this
            // is a defensive guard for hand-rolled callers).
            const filtered = Object.fromEntries(
                Object.entries(validParsed.draft).filter(([, v]) => v !== undefined),
            );
            session.draftState = { ...session.draftState, ...filtered };
        }
        if (validParsed.queue) {
            session.workQueue = validParsed.queue;
        }
        if (validParsed.options) {
            session.lastOptions = validParsed.options;
        }
        session.messages.push({ role: 'assistant', content: validParsed.message || '' });
        committed = true;
        pushEvent('librarian', { surface: 'session', action: 'exit', reason: 'success', outerIteration: outerIterations, toolCallCount });
        return { parsed: validParsed, valid: true, exhausted: false, lastErrors: [] };
    }
}

function buildUserPromptFromHistory(messages, editorNote) {
    // BUG-317: slice cannot start on a tool_result — that would orphan it from
    // its triggering assistant tool_call and let the model hallucinate calls it
    // never made. Bump the cut forward past any leading tool_result(s).
    let start = Math.max(0, messages.length - getSessionHistoryMessages());
    while (start < messages.length && messages[start].role === 'tool_result') {
        start++;
    }
    const recent = messages.slice(start);
    const prefix = start > 0
        ? `[...${start} earlier messages omitted]\n\n`
        : '';
    // BUG-AUDIT (Fix 9): editor note used to be baked into the stored user
    // message; regenerate copied the stored content (prefix included) back
    // through sendMessage, which prepended ANOTHER prefix — stacking on every
    // regen. Now stored raw, decorated only on the LAST user turn at build
    // time. Falsy editorNote = no decoration (legacy callers).
    let lastUserIdx = -1;
    if (editorNote) {
        for (let i = recent.length - 1; i >= 0; i--) {
            if (recent[i].role === 'user') { lastUserIdx = i; break; }
        }
    }
    return prefix + recent.map((m, i) => {
        if (m.role === 'tool_result') return `Tool Results:\n${m.content}`;
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const content = (i === lastUserIdx) ? `${editorNote}\n${m.content}` : m.content;
        return `${role}: ${content}`;
    }).join('\n\n');
}

// ════════════════════════════════════════════════════════════════════════════
// Edit & Regenerate
// ════════════════════════════════════════════════════════════════════════════

/**
 * Truncate history to messageIndex and re-send with newText.
 * @param {LibrarianSession} session
 * @param {number} messageIndex - User message in session.messages to edit
 * @param {string} newText
 * @param {object} [options] - signal, onToolCall, onToolResult passthrough
 */
export async function editMessage(session, messageIndex, newText, options = {}) {
    // BUG-237/253: snapshot before truncation so aborted edit restores full history.
    const snapshot = session.messages.map(m => ({ ...m }));
    // BUG-328: validate messageIndex. A stale/negative/NaN index from the UI
    // (e.g. pending edit after regen truncated history) would silently lop the
    // tail (slice(0,-2)) or the wrong range. Require non-negative, in-range,
    // and pointing at a real user message.
    if (!Number.isInteger(messageIndex)
        || messageIndex < 0
        || messageIndex >= session.messages.length
        || session.messages[messageIndex]?.role !== 'user') {
        return { parsed: null, valid: false, exhausted: true, lastErrors: ['Invalid messageIndex for edit'] };
    }
    session.messages = session.messages.slice(0, messageIndex);
    const result = await sendMessage(session, newText, options);
    // M-14: also restore on the epoch-mismatch path. sendMessage's own snapshot is
    // taken AFTER this truncation, so its epochReturn restores only to the truncated
    // tail — the live popup session is left short the pre-edit messages. Restore the
    // pre-edit snapshot for BOTH the abort and chat-changed returns (same rationale:
    // the edit never landed, so revert to full history).
    if (!result.valid
        && (result.lastErrors?.[0] === 'Aborted by user'
            || result.lastErrors?.[0] === 'Chat changed during librarian send')) {
        session.messages = snapshot;
    }
    return result;
}

/**
 * @param {LibrarianSession} session
 * @param {object} [options] - signal, onToolCall, onToolResult passthrough
 */
export async function regenerateResponse(session, options = {}) {
    // BUG-237/253: snapshot before mutation so aborted regen restores history.
    const snapshot = session.messages.map(m => ({ ...m }));
    let lastUserMsg = '';
    for (let i = session.messages.length - 1; i >= 0; i--) {
        if (session.messages[i].role === 'assistant') {
            session.messages.splice(i, 1);
            break;
        }
    }
    // BUG-329: a tool-call chain leaves intermediate assistant(tool_call) +
    // tool_result pairs after removing the final assistant. Strip them too —
    // otherwise buildUserPromptFromHistory sends orphan tool results on regen
    // and the model hallucinates tool calls it never made.
    while (session.messages.length
        && (session.messages[session.messages.length - 1].role === 'tool_result'
            || session.messages[session.messages.length - 1].role === 'assistant')) {
        session.messages.pop();
    }
    // BUG-319: synthetic budget-nudge messages are not real user input —
    // re-sending corrupts regenerate. Strip trailing nudges too so they don't
    // poison the next sendMessage call.
    while (session.messages.length && session.messages[session.messages.length - 1].synthetic) {
        session.messages.pop();
    }
    for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i];
        if (m.role === 'user' && !m.synthetic) {
            lastUserMsg = m.content;
            session.messages.splice(i, 1); // sendMessage will re-add it
            break;
        }
    }
    if (!lastUserMsg) {
        session.messages = snapshot;
        return { parsed: null, valid: false, exhausted: true, lastErrors: ['No message to regenerate'] };
    }
    const result = await sendMessage(session, lastUserMsg, options);
    // M-14: also restore on the epoch-mismatch path (same as editMessage). sendMessage's
    // snapshot is taken after this regen-stripping, so its epochReturn leaves the live
    // session short the removed assistant/tool_result tail.
    if (!result.valid
        && (result.lastErrors?.[0] === 'Aborted by user'
            || result.lastErrors?.[0] === 'Chat changed during librarian send')) {
        session.messages = snapshot;
    }
    return result;
}

// ════════════════════════════════════════════════════════════════════════════
// Gap Status Management
// ════════════════════════════════════════════════════════════════════════════

export function updateGapStatus(gapId, newStatus) {
    const idx = loreGaps.findIndex(g => g.id === gapId);
    if (idx === -1) return;

    const updated = [...loreGaps];
    updated[idx] = { ...updated[idx], status: newStatus };
    setLoreGaps(updated);

    // getContext() exposes camelCase chatMetadata.
    const ctx = getContext();
    const meta = ctx?.chatMetadata;
    if (meta) {
        meta.deeplore_lore_gaps = updated;
        saveMetadataDebounced();
    }
}
