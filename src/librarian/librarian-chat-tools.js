/**
 * DeepLore Enhanced — Librarian Chat Tools.
 * Local-execution only — NOT registered with ST's ToolManager. Read-only except
 * `flag_entry_update`, which writes a gap record to loreGaps/chat_metadata.
 */
import { vaultIndex, fuzzySearchIndex, loreGaps, chatEpoch, notifyLoreGapsChanged } from '../state.js';
import { queryBM25 } from '../vault/bm25.js';
import { getContext } from '../../../../../extensions.js';
import { persistGaps, gapId } from './librarian-tools.js';
import { getSettings } from '../../settings.js';
import { comparePriority } from '../helpers.js';

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

const TOOL_RESULT_MAX_CHARS = 2000;
const CHAT_RESULT_MAX_CHARS = 4000;
const COMPARE_RESULT_MAX_CHARS = 6000;

// ════════════════════════════════════════════════════════════════════════════
// Tool Definitions
// ════════════════════════════════════════════════════════════════════════════

const LIBRARIAN_TOOLS = [
    {
        name: 'search_vault',
        description: 'BM25 fuzzy search across the vault. Returns titles, keys, and content snippets.',
        parameters: {
            query: { type: 'string', required: true, description: 'Search query text' },
            top_k: { type: 'number', required: false, description: 'Max results (default 10, max 20)' },
        },
    },
    {
        name: 'get_entry',
        description: 'Get metadata and a TRUNCATED preview of a vault entry (frontmatter + ~2000 chars). For YOUR internal use only — checking tags, comparing entries, planning edits, drafting. The preview is often incomplete. NEVER show truncated content to the user; use get_full_content when the user asks to see, read, or review an entry.',
        parameters: {
            title: { type: 'string', required: true, description: 'Entry title (case-insensitive)' },
            vault_source: { type: 'string', required: false, description: 'Optional vault source name when multiple vaults contain entries with the same title (see search_vault results).' },
        },
    },
    {
        name: 'get_links',
        description: 'Get all outgoing [[wikilinks]] from an entry — what this entry references.',
        parameters: {
            title: { type: 'string', required: true, description: 'Entry title' },
        },
    },
    {
        name: 'get_backlinks',
        description: 'Find all entries that link TO a given title — what references this entry.',
        parameters: {
            title: { type: 'string', required: true, description: 'Target title to find backlinks for' },
        },
    },
    {
        name: 'get_full_content',
        description: 'Get the COMPLETE untruncated content of a vault entry AND automatically load it into the entry editor. REQUIRED whenever the user wants to see, read, review, or inspect an entry — "show me", "pull up", "what does it say", "let me see", etc. The editor populates automatically; you do NOT need to echo the content back as a draft.',
        parameters: {
            title: { type: 'string', required: true, description: 'Entry title (case-insensitive)' },
            vault_source: { type: 'string', required: false, description: 'Optional vault source name when multiple vaults contain entries with the same title (see search_vault results).' },
        },
    },
    {
        name: 'find_similar',
        description: 'Find vault entries similar to a given title or topic — useful for spotting duplicates or near-duplicates before creating a new entry. Returns higher top_k than search_vault and flags likely duplicates.',
        parameters: {
            query: { type: 'string', required: true, description: 'Title, topic, or concept to find similar entries for' },
            threshold: { type: 'number', required: false, description: 'Min BM25 score to consider similar (default 0.5)' },
        },
    },
    {
        name: 'list_flags',
        description: 'List the lore-gap queue — entries flagged by the librarian during generation as missing or incomplete. Read-only.',
        parameters: {
            status: { type: 'string', required: false, description: 'Filter by status: open, in_progress, resolved, dismissed (default: all)' },
        },
    },
    {
        name: 'list_entries',
        description: 'List vault entries filtered by type and/or tag. Returns titles, types, and priorities.',
        parameters: {
            type: { type: 'string', required: false, description: 'Filter by type: character, location, lore, organization, story' },
            tag: { type: 'string', required: false, description: 'Filter by tag (substring match)' },
        },
    },
    {
        name: 'get_recent_chat',
        description: 'Retrieve the last N messages from the active RP chat. Essential for comparing lore entries against what is actually happening in the story.',
        parameters: {
            count: { type: 'number', required: false, description: 'Number of recent messages to retrieve (default 10, max 50)' },
        },
    },
    {
        name: 'flag_entry_update',
        description: 'Flag an existing vault entry as needing an update. Creates a persistent record in the drawer that the user can act on. Use when you spot staleness, contradictions, or missing information in an entry.',
        parameters: {
            title: { type: 'string', required: true, description: 'Title of the vault entry that needs updating' },
            reason: { type: 'string', required: true, description: 'Why this entry needs updating' },
            fields: { type: 'string', required: false, description: 'Comma-separated list of specific fields that need attention (e.g. "summary, content, keys")' },
            vault_source: { type: 'string', required: false, description: 'Optional vault source name when multiple vaults contain entries with the same title (see search_vault results).' },
        },
    },
    {
        name: 'compare_entry_to_chat',
        description: 'Pull a vault entry and recent chat messages side by side for staleness/contradiction analysis. Returns both entry content (truncated) and recent chat context. For YOUR internal analysis — checking if an entry needs updating. If the user wants to see the entry itself, use get_full_content instead.',
        parameters: {
            title: { type: 'string', required: true, description: 'Entry title to compare against recent chat' },
            chat_count: { type: 'number', required: false, description: 'Number of recent chat messages to include (default 15)' },
            vault_source: { type: 'string', required: false, description: 'Optional vault source name when multiple vaults contain entries with the same title (see search_vault results).' },
        },
    },
];

// ════════════════════════════════════════════════════════════════════════════
// Tool Executor
// ════════════════════════════════════════════════════════════════════════════

/**
 * Find an entry by title (case-insensitive). vaultSource disambiguates duplicate
 * titles across multiple vaults (BUG-400).
 * @param {string} title
 * @param {string|null} [vaultSource]
 */
export function findEntry(title, vaultSource = null) {
    if (!title) return null;
    const lower = title.toLowerCase();
    const matches = vaultIndex.filter(e => e.title.toLowerCase() === lower);
    if (matches.length === 0) return null;
    if (vaultSource) return matches.find(e => e.vaultSource === vaultSource) || null;
    return matches[0];
}

function truncate(text, max = TOOL_RESULT_MAX_CHARS) {
    if (!text || text.length <= max) return text || '';
    const cut = text.lastIndexOf(' ', max);
    return text.slice(0, cut > 0 ? cut : max) + '...';
}

export function executeToolCall(name, args = {}, session = null) {
    const t0 = performance.now();
    let result;
    try {
        switch (name) {
            case 'search_vault': result = toolSearchVault(args); break;
            case 'get_entry': result = toolGetEntry(args); break;
            case 'get_full_content': result = toolGetFullContent(args, session); break;
            case 'find_similar': result = toolFindSimilar(args); break;
            case 'list_flags': result = toolListFlags(args); break;
            case 'get_links': result = toolGetLinks(args); break;
            case 'get_backlinks': result = toolGetBacklinks(args); break;
            case 'list_entries': result = toolListEntries(args); break;
            case 'get_recent_chat': result = toolGetRecentChat(args); break;
            case 'flag_entry_update': result = toolFlagEntryUpdate(args); break;
            case 'compare_entry_to_chat': result = toolCompareEntryToChat(args); break;
            case 'get_writing_guide': result = toolGetWritingGuide(args); break;
            // BUG-325: get_writing_guide is dynamic (built in buildToolsPromptSection),
            // so the unknown-tool error must list it conditionally too.
            default: {
                const staticTools = LIBRARIAN_TOOLS.map(t => t.name);
                const dynamicTools = getGuideEntries().length > 0 ? ['get_writing_guide'] : [];
                result = `Unknown tool: "${name}". Available tools: ${[...staticTools, ...dynamicTools].join(', ')}`;
            }
        }
    } catch (err) {
        console.warn('[DLE] Emma tool "%s" threw: %s', name, err?.message || err);
        throw err;
    }
    const debug = getSettings().debugMode;
    if (debug) console.debug('[DLE] Emma tool: %s — %d chars, %dms', name, (result || '').length, Math.round(performance.now() - t0));
    return result;
}

// ── Individual tool implementations ──────────────────────────────────────

function toolSearchVault(args) {
    const query = args.query?.trim();
    if (!query) return 'Error: query is required.';
    if (!fuzzySearchIndex) return 'Error: vault index not built yet.';

    const topK = Math.min(Math.max(Number(args.top_k) || 10, 1), 20);
    const hits = queryBM25(fuzzySearchIndex, query, topK, 0.3);

    if (hits.length === 0) return `No results found for "${query}".`;

    const lines = hits.map((h, i) => {
        const e = h.entry;
        const snippet = truncate(e.summary || e.content || '', 200);
        // BUG-400: surface vaultSource so the model can pass vault_source on
        // later tool calls to disambiguate duplicate titles across vaults.
        const vaultLine = e.vaultSource ? `\n   vaultSource: ${e.vaultSource}` : '';
        return `${i + 1}. **${e.title}** (${e.type || '?'}, p${e.priority || 50}, score ${h.score.toFixed(2)})${vaultLine}\n   Keys: ${(e.keys || []).join(', ')}\n   ${snippet}`;
    });
    return truncate(lines.join('\n\n'), TOOL_RESULT_MAX_CHARS);
}

function toolGetEntry(args) {
    const title = args.title?.trim();
    if (!title) return 'Error: title is required.';

    const entry = findEntry(title, args.vault_source?.trim() || null);
    if (!entry) {
        if (fuzzySearchIndex) {
            const hits = queryBM25(fuzzySearchIndex, title, 5, 0.3);
            if (hits.length > 0) {
                return `Entry "${title}" not found. Did you mean: ${hits.map(h => h.title).join(', ')}?`;
            }
        }
        return `Entry "${title}" not found.`;
    }

    const meta = [
        `**Title:** ${entry.title}`,
        `**Type:** ${entry.type || 'unknown'}`,
        `**Priority:** ${entry.priority || 50}`,
        `**Tags:** ${(entry.tags || []).join(', ')}`,
        `**Keys:** ${(entry.keys || []).join(', ')}`,
        entry.summary ? `**Summary:** ${entry.summary}` : null,
        `**Links out:** ${(entry.resolvedLinks || []).join(', ') || 'none'}`,
    ].filter(Boolean).join('\n');

    const raw = entry.content || '(no content)';
    const maxLen = Math.max(TOOL_RESULT_MAX_CHARS - meta.length - 100, 200);
    const content = truncate(raw, maxLen);
    const wasTruncated = raw.length > maxLen;
    const footer = wasTruncated ? '\n\n[Content truncated — use get_full_content to see the complete entry]' : '';
    return `${meta}\n\n---\n${content}${footer}`;
}

// Higher than standard 2000 but capped so a 50KB entry can't blow the budget.
const FULL_CONTENT_MAX_CHARS = 16000;

function toolGetFullContent(args, session = null) {
    const title = args.title?.trim();
    if (!title) return 'Error: title is required.';
    const entry = findEntry(title, args.vault_source?.trim() || null);
    if (!entry) return `Entry "${title}" not found.`;

    // Populate editor draft directly — saves an AI round-trip.
    if (session) {
        session.draftState = {
            ...session.draftState,
            title: entry.title,
            type: entry.type || 'lore',
            priority: entry.priority || 50,
            tags: entry.tags?.length ? [...entry.tags] : [],
            keys: entry.keys?.length ? [...entry.keys] : [],
            summary: entry.summary || '',
            content: entry.content || '',
        };
    }

    const content = entry.content || '(no content)';
    if (content.length <= FULL_CONTENT_MAX_CHARS) {
        return `**${entry.title}** (full content, ${content.length} chars):\n\n${content}`;
    }
    return `**${entry.title}** (full content, ${content.length} chars — capped at ${FULL_CONTENT_MAX_CHARS}):\n\n`
        + content.slice(0, FULL_CONTENT_MAX_CHARS)
        + `\n\n[...${content.length - FULL_CONTENT_MAX_CHARS} more chars not shown — entry is unusually large]`;
}

function toolFindSimilar(args) {
    const query = args.query?.trim();
    if (!query) return 'Error: query is required.';
    if (!fuzzySearchIndex) return 'Error: vault index not built yet.';

    const threshold = Math.max(Number(args.threshold) || 0.5, 0.1);
    const hits = queryBM25(fuzzySearchIndex, query, 15, threshold);

    if (hits.length === 0) {
        return `No similar entries found for "${query}" (threshold ${threshold.toFixed(2)}). This topic looks safe to create as a new entry.`;
    }

    // Duplicate flag: title substring match or score > 2.0.
    const lowerQuery = query.toLowerCase();
    const lines = hits.map((h, i) => {
        const e = h.entry;
        const titleMatch = e.title.toLowerCase().includes(lowerQuery)
            || lowerQuery.includes(e.title.toLowerCase());
        const flag = (titleMatch || h.score > 2.0) ? ' **[LIKELY DUPLICATE]**' : '';
        const snippet = truncate(e.summary || e.content || '', 160);
        return `${i + 1}. **${e.title}** (${e.type || '?'}, p${e.priority || 50}, score ${h.score.toFixed(2)})${flag}\n   Keys: ${(e.keys || []).join(', ')}\n   ${snippet}`;
    });
    const header = `Found ${hits.length} potentially similar entries. Review before creating a new one:`;
    return truncate(`${header}\n\n${lines.join('\n\n')}`, TOOL_RESULT_MAX_CHARS);
}

function toolListFlags(args) {
    const statusFilter = args.status?.trim()?.toLowerCase();
    if (!loreGaps || loreGaps.length === 0) {
        return 'The lore-gap queue is empty. No flagged gaps.';
    }
    let gaps = loreGaps;
    if (statusFilter) {
        gaps = gaps.filter(g => (g.status || 'open').toLowerCase() === statusFilter);
        if (gaps.length === 0) return `No gaps with status "${statusFilter}".`;
    }
    const lines = gaps.slice(0, 30).map((g, i) => {
        const status = g.status || 'open';
        const urgency = g.urgency || 'medium';
        return `${i + 1}. [${status}/${urgency}] **${g.query || '(no query)'}**\n   ${g.reason || '(no reason)'}`;
    });
    const header = `${gaps.length} flagged gap${gaps.length === 1 ? '' : 's'}${gaps.length > 30 ? ' (showing first 30)' : ''}:`;
    return truncate(`${header}\n${lines.join('\n')}`, TOOL_RESULT_MAX_CHARS);
}

function toolGetLinks(args) {
    const title = args.title?.trim();
    if (!title) return 'Error: title is required.';

    const entry = findEntry(title);
    if (!entry) return `Entry "${title}" not found.`;

    const links = entry.resolvedLinks || [];
    if (links.length === 0) return `"${entry.title}" has no outgoing links.`;

    const lines = links.map(linkTitle => {
        const target = findEntry(linkTitle);
        return target
            ? `- [[${linkTitle}]] (${target.type || '?'}, p${target.priority || 50})`
            : `- [[${linkTitle}]] (not in vault)`;
    });
    return `**${entry.title}** links to ${links.length} entries:\n${lines.join('\n')}`;
}

function toolGetBacklinks(args) {
    const title = args.title?.trim();
    if (!title) return 'Error: title is required.';

    const lower = title.toLowerCase();
    const backlinks = vaultIndex.filter(e =>
        (e.resolvedLinks || []).some(l => l.toLowerCase() === lower)
    );

    if (backlinks.length === 0) return `No entries link to "${title}".`;

    const lines = backlinks
        .sort((a, b) => comparePriority(a, b, getSettings().priorityReversed))
        .map(e => `- **${e.title}** (${e.type || '?'}, p${e.priority || 50})`);
    return truncate(`${backlinks.length} entries link to "${title}":\n${lines.join('\n')}`, TOOL_RESULT_MAX_CHARS);
}

function toolListEntries(args) {
    const typeFilter = args.type?.trim()?.toLowerCase();
    const tagFilter = args.tag?.trim()?.toLowerCase();

    if (!typeFilter && !tagFilter) return 'Error: at least one of type or tag is required.';

    let entries = vaultIndex;
    if (typeFilter) entries = entries.filter(e => (e.type || '').toLowerCase() === typeFilter);
    if (tagFilter) entries = entries.filter(e => (e.tags || []).some(t => t.toLowerCase().includes(tagFilter)));

    if (entries.length === 0) {
        const filter = [typeFilter && `type="${typeFilter}"`, tagFilter && `tag="${tagFilter}"`].filter(Boolean).join(', ');
        return `No entries match ${filter}.`;
    }

    const capped = entries
        .sort((a, b) => comparePriority(a, b, getSettings().priorityReversed))
        .slice(0, 50);

    const lines = capped.map(e => `- **${e.title}** (p${e.priority || 50}) — ${(e.keys || []).slice(0, 3).join(', ')}`);
    const header = `${entries.length} entries${entries.length > 50 ? ' (showing first 50)' : ''}:`;
    return truncate(`${header}\n${lines.join('\n')}`, TOOL_RESULT_MAX_CHARS);
}

// ── Chat-context and mutation tools ──────────────────────────────────────

function toolGetRecentChat(args) {
    const count = Math.min(Math.max(Number(args.count) || 10, 1), 50);
    const ctx = getContext();
    const chat = ctx?.chat;
    if (!chat || chat.length === 0) return 'No active chat found.';

    const recent = chat.slice(-count).filter(m =>
        m && typeof m.mes === 'string' && m.mes.trim().length > 0 && !m.is_system
    );
    if (recent.length === 0) return 'No scannable messages in recent chat.';

    const lines = recent.map(m => {
        const speaker = m.name || 'Unknown';
        const role = m.is_user ? '(user)' : '(character)';
        return `**${speaker}** ${role}:\n${m.mes}`;
    });
    return truncate(lines.join('\n\n'), CHAT_RESULT_MAX_CHARS);
}

function toolFlagEntryUpdate(args) {
    const title = args.title?.trim();
    const reason = args.reason?.trim();
    if (!title) return 'Error: title is required.';
    if (!reason) return 'Error: reason is required.';

    const entry = findEntry(title, args.vault_source?.trim() || null);
    if (!entry) return `Error: Entry "${title}" not found in vault.`;

    const fields = args.fields?.trim() || null;
    const fullReason = fields ? `${reason} (fields: ${fields})` : reason;

    const epoch = chatEpoch;

    // Late-read loreGaps to minimize race window.
    // BUG-400: vaultSource disambiguates multi-vault same-title entries;
    // legacy gaps without it still render (drawer tolerates undefined).
    const newGap = {
        id: gapId(),
        type: 'flag',
        subtype: 'update',
        entryTitle: entry.title, // canonical from vault
        vaultSource: entry.vaultSource || undefined,
        query: entry.title,
        reason: fullReason,
        timestamp: Date.now(),
        // Audit S5-2: include createdAt so the gap-eviction sort (which falls back to
        // `createdAt || 0`) doesn't land every Emma flag at index 0 and drop it first.
        createdAt: Date.now(),
        generation: 0, // Emma session, not pipeline generation
        status: 'pending',
        frequency: 1,
        urgency: 'medium',
        hadResults: false,
        resultTitles: null,
        source: 'emma-session',
    };

    if (epoch !== chatEpoch) {
        return `Error: chat changed during tool execution — flag not persisted.`;
    }

    const updatedGaps = [...loreGaps, newGap];
    const ok = persistGaps(updatedGaps);
    if (!ok) {
        console.warn('[DLE] Emma flag: "%s" — persist failed (no chat metadata)', title);
        return `Error: could not persist flag (no active chat metadata).`;
    }
    notifyLoreGapsChanged();

    console.log('[DLE] Emma flag: "%s" — %s — persist=%s', title, 'medium', ok);
    return `Flagged "${entry.title}" for update: ${fullReason}`;
}

function toolCompareEntryToChat(args) {
    const title = args.title?.trim();
    if (!title) return 'Error: title is required.';

    const vaultSource = args.vault_source?.trim() || null;
    const entry = findEntry(title, vaultSource);
    if (!entry) return `Entry "${title}" not found.`;

    const chatCount = Math.min(Math.max(Number(args.chat_count) || 15, 1), 50);
    const chatText = toolGetRecentChat({ count: chatCount });
    const entryText = toolGetEntry({ title: entry.title, vault_source: entry.vaultSource });

    return truncate(
        `## Entry: ${entry.title}\n${entryText}\n\n---\n\n## Recent Chat (last ${chatCount} messages)\n${chatText}`,
        COMPARE_RESULT_MAX_CHARS
    );
}

// ── Writing-guide tool (dynamic, runtime-built) ──────────────────────────

/** Stable enum id for the guide name parameter. */
function kebabCase(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function getGuideEntries() {
    return vaultIndex.filter(e => e.guide);
}

function findGuideByName(kebabName) {
    if (!kebabName) return null;
    const target = String(kebabName).toLowerCase();
    return getGuideEntries().find(e => kebabCase(e.title) === target) || null;
}

function toolGetWritingGuide(args) {
    const name = args?.name?.trim();
    if (!name) return 'Error: name is required.';
    const entry = findGuideByName(name);
    if (!entry) {
        const avail = getGuideEntries().map(e => kebabCase(e.title)).join(', ');
        return `Guide "${name}" not found. Available: ${avail || '(none)'}`;
    }
    const content = entry.content || '(no content)';
    if (content.length <= FULL_CONTENT_MAX_CHARS) {
        return `**${entry.title}** (writing guide, ${content.length} chars):\n\n${content}`;
    }
    return `**${entry.title}** (writing guide, ${content.length} chars — capped at ${FULL_CONTENT_MAX_CHARS}):\n\n`
        + content.slice(0, FULL_CONTENT_MAX_CHARS)
        + `\n\n[...${content.length - FULL_CONTENT_MAX_CHARS} more chars not shown]`;
}

// ════════════════════════════════════════════════════════════════════════════
// System Prompt Section
// ════════════════════════════════════════════════════════════════════════════

export function buildToolsPromptSection() {
    const toolDocs = LIBRARIAN_TOOLS.map(t => {
        const params = Object.entries(t.parameters)
            .map(([k, v]) => `${k}${v.required ? '' : '?'}: ${v.description}`)
            .join(', ');
        return `- **${t.name}**(${params}): ${t.description}`;
    }).join('\n');

    // Rebuilt every turn so the enum reflects current vault contents.
    const guides = getGuideEntries();
    let guideToolDoc = '';
    if (guides.length > 0) {
        const guideList = guides.map(g => {
            const kebab = kebabCase(g.title);
            const blurb = (g.summary || g.content || '').replace(/\s+/g, ' ').trim().slice(0, 80);
            return `\`${kebab}\` — ${blurb}`;
        }).join('; ');
        guideToolDoc = `\n- **get_writing_guide**(name: enum): Fetch a meta/style/reference guide written for the Librarian (you). These are NOT shown to the writing AI — they are your private notes. Available guides: ${guideList}.`;
    }

    return `
## Available Tools
You can query the vault during our conversation using tools. To use tools, respond with:
\`\`\`json
{
  "message": "Let me look that up...",
  "tool_calls": [{"name": "tool_name", "args": {"param": "value"}}],
  "action": "tool_call"
}
\`\`\`

You will receive tool results, then respond with your final answer. Max 10 tool calls per turn.
You may call multiple tools in a single response.

### Tools:
${toolDocs}${guideToolDoc}

### Rules:
- Most tools are **read-only**. The exception is **flag_entry_update**, which creates a persistent flag record visible in the drawer.
- You cannot write to the vault directly. The user is the only one who clicks "Write to Vault."
- Use tools when the manifest lacks detail or you need to see an entry's full content.
- After receiving tool results, respond with your final answer (action: "update_draft", "propose_options", or null).
- Don't use tools for entries already visible in the manifest summary.

### Usage hints:
- **find_similar** before creating a new entry — if there's already something close, you should know.
- **get_entry** returns truncated previews for YOUR internal analysis — never display its output to the user as if it were the full entry. **get_full_content** is REQUIRED when the user asks to see, read, or review an entry.
- **list_flags** when the user asks "what's broken" or "what needs work" or you want to know what gaps the librarian has been collecting.
- **get_recent_chat** to see what's actually happening in the story — essential for audit/review workflows.
- **flag_entry_update** when you find an entry that's stale or contradicted — creates a visible record the user can act on.
- **compare_entry_to_chat** for a side-by-side view of an entry vs. the story — faster than calling both tools separately.
`;
}
