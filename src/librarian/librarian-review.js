/**
 * DeepLore Enhanced — Librarian review popup.
 * Two-panel: entry editor + Emma chat. Entry points: gap, new, review, audit.
 */
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../../popup.js';
import { escapeHtml } from '../../../../../utils.js';
import { yamlEscape, classifyError } from '../../core/utils.js';
import { stripObsidianSyntax, sanitizeFilename } from '../helpers.js';
import { writeNote } from '../vault/obsidian-api.js';
import { getSettings, resolveWriteVault } from '../../settings.js';
import { getContext } from '../../../../../extensions.js';
import { accountStorage } from '../../../../../util/AccountStorage.js';
import { chatEpoch } from '../state.js';
import { buildIndex } from '../vault/vault.js';
import { tr, trf } from '../i18n/i18n.js';
import { createSession, sendMessage, editMessage, regenerateResponse, updateGapStatus, saveSessionState, loadSessionState, clearSessionState, restoreSession, pickFlavorIntro } from './librarian-session.js';
import { getSessionActivityLog, buildLibrarianActivityFeed } from './librarian-tools.js';
import { abortWith } from '../diagnostics/interceptors.js';

const emmaAvatarUrl = new URL('../../assets/companions/Emma-STChar.png', import.meta.url).href;

// ════════════════════════════════════════════════════════════════════════════
// Helpers — Unified document format
// ════════════════════════════════════════════════════════════════════════════

/**
 * BUG-AUDIT (Fix 10): system prompt tells Emma to start content with `# Title`,
 * but write/format paths already prepend `# ${draft.title}` — without this the
 * saved file gets two H1s. Only matching H1s are stripped; intentional alternate
 * H1s pass through. Case-insensitive, whitespace-tolerant.
 */
function stripLeadingMatchingH1(s, title) {
    if (!s || !title) return s;
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^\\s*#\\s+${escaped}\\s*\\n+`, 'i');
    return s.replace(re, '');
}

/** YAML frontmatter + markdown content (Obsidian-style document). */
function formatEntryAsDocument(draft, settings) {
    if (!draft) draft = {};
    const s = settings || getSettings();
    const typeStr = draft.type || 'lore';
    const tags = draft.tags?.length ? draft.tags : [s.lorebookTag || 'lorebook'];
    const keys = draft.keys || [];
    const priority = draft.priority || 50;
    const summary = (draft.summary || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

    const fileClassLine = typeStr !== 'story' ? `fileClass: ${yamlEscape(typeStr)}\n` : '';
    const tagsYaml = tags.map(t => `  - ${yamlEscape(t)}`).join('\n');
    const keysYaml = keys.length ? keys.map(k => `  - ${yamlEscape(k)}`).join('\n') : '  - ';

    let doc = `---\n${fileClassLine}type: ${yamlEscape(typeStr)}\nstatus: active\npriority: ${priority}\ntags:\n${tagsYaml}\nkeys:\n${keysYaml}\nsummary: "${summary}"\n---`;

    if (draft.title || draft.content) {
        const cleanedContent = stripLeadingMatchingH1(draft.content || '', draft.title || 'Untitled');
        doc += `\n# ${draft.title || 'Untitled'}\n\n${cleanedContent}`;
    }
    return doc;
}

/** Inverse of formatEntryAsDocument — frontmatter + markdown → draft fields. */
function parseEntryDocument(text) {
    const draft = {};
    if (!text || !text.trim()) return draft;

    const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
    let body = text;
    if (fmMatch) {
        const yaml = fmMatch[1];
        body = text.slice(fmMatch[0].length).trim();

        const typeMatch = yaml.match(/^type:\s*(.+)$/m);
        if (typeMatch) draft.type = typeMatch[1].trim();

        const priorityMatch = yaml.match(/^priority:\s*(\d+)/m);
        if (priorityMatch) draft.priority = parseInt(priorityMatch[1], 10);

        const summaryMatch = yaml.match(/^summary:\s*"((?:[^"\\]|\\.)*)"/m);
        if (summaryMatch) {
            draft.summary = summaryMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }

        const tagsSection = yaml.match(/^tags:\n((?:\s+-\s+.+\n?)*)/m);
        if (tagsSection) {
            draft.tags = tagsSection[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
        }

        const keysSection = yaml.match(/^keys:\n((?:\s+-\s+.+\n?)*)/m);
        if (keysSection) {
            draft.keys = keysSection[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
        }
    }

    const titleMatch = body.match(/^#\s+(.+)$/m);
    if (titleMatch) {
        draft.title = titleMatch[1].trim();
        body = body.slice(body.indexOf(titleMatch[0]) + titleMatch[0].length).trim();
    }

    draft.content = body;
    return draft;
}


// ════════════════════════════════════════════════════════════════════════════
// Popup HTML
// ════════════════════════════════════════════════════════════════════════════

function buildPopupHTML(session) {
    const draft = session.draftState || {};
    const isReview = session.entryPoint === 'review';
    const isGap = session.entryPoint === 'gap';

    const isAudit = session.entryPoint === 'audit';

    let welcomeMsg = '';
    if (isGap && session.gapRecord) {
        if (session.gapRecord.subtype === 'update' && session.gapRecord.entryTitle) {
            welcomeMsg = `*shuffles papers* So "<b>${escapeHtml(session.gapRecord.entryTitle)}</b>" needs updating. ${escapeHtml(session.gapRecord.reason || '')} Let me pull it up and see what's changed.`;
        } else {
            welcomeMsg = `*shuffles papers* So your vault name-drops "<b>${escapeHtml(session.gapRecord.query)}</b>" but nobody bothered to write the entry. ${escapeHtml(session.gapRecord.reason || '')} Classic. Tell me what you want, or I'll just start drafting.`;
        }
    } else if (isReview) {
        welcomeMsg = `*leans back, flips through your vault* Alright, let's see what kind of mess we're working with. Send me a direction or I'll start pulling threads from your recent chat.`;
    } else if (isAudit) {
        // Audit normally uses session-seeded greeting; this is the fallback.
        welcomeMsg = escapeHtml(session.messages?.[0]?.content || 'Audit mode. Pulling up the vault and recent chat now.');
    } else {
        welcomeMsg = escapeHtml(pickFlavorIntro());
    }

    const initialDoc = formatEntryAsDocument(draft, getSettings());

    return `
<div class="dle-librarian-popup">
    <div class="dle-librarian-editor" role="form" aria-label="Entry editor">
        <h4 class="dle-librarian-editor-title">Entry Editor</h4>
        <textarea id="dle-lib-unified" class="text_pole dle-librarian-unified-textarea" spellcheck="false" placeholder="---${'\n'}type: lore${'\n'}priority: 50${'\n'}tags:${'\n'}  - lorebook${'\n'}keys:${'\n'}  - keyword${'\n'}summary: &quot;What this is and when to select it&quot;${'\n'}---${'\n'}# Entry Title${'\n'}${'\n'}Content goes here...">${escapeHtml(initialDoc)}</textarea>
    </div>
    <div class="dle-librarian-chat" role="region" aria-label="AI assistant">
        <div class="dle-librarian-chat-header">
            <h4 class="dle-librarian-chat-title">Emma <span class="dle-librarian-chat-subtitle">the Librarian</span></h4>
            <button type="button" class="menu_button_icon" id="dle-lib-clear-chat" title="Clear chat history" aria-label="Clear chat history">
                <i class="fa-solid fa-eraser" aria-hidden="true"></i>
            </button>
            <button type="button" class="dle-lib-activity-toggle menu_button_icon" id="dle-lib-activity-btn" title="Toggle activity log" aria-label="Toggle activity log" aria-expanded="false">
                <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>
            </button>
            <button type="button" class="menu_button_icon" id="dle-lib-chat-collapse" title="Toggle chat panel" aria-label="Toggle chat panel" aria-expanded="true">
                <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
            </button>
        </div>
        <div class="dle-lib-activity-log" id="dle-lib-activity" hidden aria-label="Tool use activity log"></div>
        <div class="dle-librarian-messages" id="dle-lib-messages" role="log" aria-live="polite">
            <div class="dle-lib-msg dle-lib-msg-ai"><img class="dle-lib-avatar" src="${emmaAvatarUrl}" alt=""><div class="dle-lib-msg-content">${welcomeMsg}</div></div>
            <div class="dle-lib-status-line" id="dle-lib-status-line" aria-live="polite" hidden></div>
        </div>
        ${(isReview || isAudit) && session.workQueue ? `<div class="dle-librarian-queue" id="dle-lib-queue"></div>` : ''}
        <div class="dle-librarian-input-row">
            <textarea id="dle-lib-chat-input" class="text_pole" rows="1" placeholder="Ask Emma anything..." aria-label="Chat message"></textarea>
            <button type="button" id="dle-lib-send" class="menu_button" aria-label="Send message">
                <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
            </button>
            <button type="button" id="dle-lib-stop" class="menu_button dle-lib-stop-btn" style="display:none" aria-label="Stop generation">
                <i class="fa-solid fa-stop" aria-hidden="true"></i>
            </button>
        </div>
    </div>
</div>`;
}

// ════════════════════════════════════════════════════════════════════════════
// Popup Lifecycle
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {'gap'|'new'|'review'|'audit'} entryPoint
 * @param {object} [options] - e.g. { gap: gapRecord }
 */
export async function openLibrarianPopup(entryPoint = 'new', options = {}) {
    // Guide modes default entryPoint to 'new' — supports openLibrarianPopup(null, { mode: ... }).
    if (entryPoint === null || entryPoint === undefined) entryPoint = 'new';
    const isGuideMode = options.mode === 'guide-firstrun' || options.mode === 'guide-adhoc';

    // BUG-AUDIT (Fix 7): capture chatEpoch at open. Debounced save/clear timers
    // and onClosing callbacks pass openEpoch back to saveSessionState/
    // clearSessionState — on chat switch, those helpers refuse to write into
    // the new chat's metadata.
    const openEpoch = chatEpoch;

    let session;
    let isRestored = false;
    const saved = loadSessionState();
    const STALE_MS = 4 * 60 * 60 * 1000;
    const isStale = saved?.savedAt && (Date.now() - saved.savedAt) > STALE_MS;
    // Guide mode never resumes — always fresh, no cross-conversation bleed.
    if (!isGuideMode && saved && saved.messages?.length > 0 && !isStale) {
        const resume = await callGenericPopup(
            'You have a previous Librarian session in progress. Resume where you left off?',
            POPUP_TYPE.CONFIRM,
            '', { okButton: 'Resume', cancelButton: 'Start Fresh' },
        );
        if (resume === POPUP_RESULT.AFFIRMATIVE) {
            session = restoreSession(saved);
            isRestored = true;
        } else {
            clearSessionState();
            session = createSession(entryPoint, options);
        }
    } else {
        if (isStale) clearSessionState();
        session = createSession(entryPoint, options);
    }

    // (v2) Don't mark gap in_progress on open — that left a stuck spinner
    // when the popup was closed without writing. Status flips to 'written'
    // only on successful confirm/write.

    const container = document.createElement('div');
    container.innerHTML = buildPopupHTML(session);

    let dirty = false;
    let sending = false;
    let _saveTimer = null;
    // Edits since last successful write — set on field edit, cleared on write.
    let dirtySinceLastWrite = false;
    let hasWrittenOnce = false;

    // BUG-236/254/255: outer scope so onClosing can abort in-flight calls (X /
    // Escape / Close) and buildSendOptions can abort the prior controller before
    // creating a new one — kills the rapid-resend race where the first call
    // becomes un-stoppable.
    let abortController = null;

    await callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        wider: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: 'Close',
        cancelButton: false,
        onOpen: (popup) => {
            if (popup?.dlg) {
                popup.dlg.classList.add('dle-librarian-review');
            }

            // Inject "Write to Vault" button + status next to Close in the popup chrome.
            // Vault picker appears only when 2+ vaults are enabled — single-vault
            // users keep the previous chrome unchanged.
            let writeBtn = null;
            let writeStatusEl = null;
            let writeVaultSelect = null;
            const _libSettings = getSettings();
            const enabledVaults = (_libSettings.vaults || []).filter(v => v.enabled);
            const showVaultPicker = enabledVaults.length >= 2;
            const defaultPickerValue = _libSettings.librarianWriteVaultId || '';
            try {
                const dlg = popup?.dlg;
                const controls = dlg?.querySelector('.popup-controls');
                const okBtn = controls?.querySelector('.popup-button-ok');
                if (controls && okBtn) {
                    const wrap = document.createElement('div');
                    wrap.className = 'dle-librarian-write-action';
                    let pickerHtml = '';
                    if (showVaultPicker) {
                        const opts = ['<option value="">(default)</option>']
                            .concat(enabledVaults.map(v => {
                                const name = String(v.name || '');
                                const selected = name === defaultPickerValue ? ' selected' : '';
                                return `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)}</option>`;
                            }))
                            .join('');
                        pickerHtml = `
                            <label for="dle-lib-write-vault" class="dle-lib-write-vault-label" title="Vault this entry will be written to">
                                <span>Write to:</span>
                                <select id="dle-lib-write-vault" class="dle-lib-write-vault-select">${opts}</select>
                            </label>
                        `;
                    }
                    wrap.innerHTML = `
                        ${pickerHtml}
                        <span id="dle-lib-write-status" class="dle-lib-write-status" aria-live="polite"></span>
                        <button type="button" id="dle-lib-write-btn" class="menu_button interactable" title="Write entry to Obsidian vault (Ctrl+S)">
                            <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i><span>Write to Vault</span>
                        </button>
                    `;
                    controls.insertBefore(wrap, okBtn);
                    writeBtn = wrap.querySelector('#dle-lib-write-btn');
                    writeStatusEl = wrap.querySelector('#dle-lib-write-status');
                    writeVaultSelect = wrap.querySelector('#dle-lib-write-vault');
                    if (writeVaultSelect) {
                        // '(default)' option -> empty -> falls back to setting/primary.
                        session.writeTargetVault = writeVaultSelect.value || '';
                        writeVaultSelect.addEventListener('change', () => {
                            session.writeTargetVault = writeVaultSelect.value || '';
                        });
                    }
                }
            } catch { /* fallback below */ }
            // Fallback if chrome injection failed — look in container.
            if (!writeBtn) writeBtn = container.querySelector('#dle-lib-write-btn');
            if (!writeStatusEl) writeStatusEl = container.querySelector('#dle-lib-write-status');
            if (writeBtn) {
                writeBtn.addEventListener('click', async () => {
                    writeBtn.disabled = true;
                    try {
                        const wrote = await writeToVault(session, { statusEl: writeStatusEl });
                        if (wrote) {
                            dirtySinceLastWrite = false;
                            hasWrittenOnce = true;
                        }
                    } finally {
                        writeBtn.disabled = false;
                    }
                });
            }

            requestAnimationFrame(() => {
                const ta = container.querySelector('#dle-lib-unified');
                if (ta) ta.focus();
            });

            // ─── Unified editor sync ───
            const unifiedTextarea = container.querySelector('#dle-lib-unified');
            const editorTitle = container.querySelector('.dle-librarian-editor-title');

            function updateDirtyIndicator() {
                if (dirty && editorTitle) {
                    editorTitle.textContent = 'Entry Editor \u2022';
                    editorTitle.classList.add('dle-librarian-dirty');
                }
                const ep = container.querySelector('.dle-librarian-editor');
                if (ep) ep.classList.toggle('dle-librarian-editor--dirty', dirty);
            }

            function syncDraftFromFields() {
                const parsed = parseEntryDocument(unifiedTextarea.value);
                session.draftState = { ...session.draftState, ...parsed };
                // The textarea IS the frontmatter — user owns it post-edit.
                session.frontmatterUserEdited = true;
                session.frontmatterOverride = unifiedTextarea.value.match(/^---\n[\s\S]*?\n---/)?.[0] || '';
                dirty = true;
                dirtySinceLastWrite = true;
                updateDirtyIndicator();
                debouncedSaveSession();
            }

            function flashField() {
                unifiedTextarea.classList.remove('dle-field-updated');
                void unifiedTextarea.offsetWidth;
                unifiedTextarea.classList.add('dle-field-updated');
            }

            function updateFieldsFromDraft() {
                const _debug = getSettings().debugMode;
                if (!session.draftState) { if (_debug) console.debug('[DLE] updateFieldsFromDraft: no draftState'); return; }
                const newDoc = formatEntryAsDocument(session.draftState, getSettings());
                if (_debug) console.debug('[DLE] updateFieldsFromDraft:', {
                    draftKeys: Object.keys(session.draftState),
                    hasTitle: !!session.draftState.title,
                    hasContent: !!session.draftState.content,
                    newDocLen: newDoc.length,
                    currentLen: unifiedTextarea.value.length,
                    willUpdate: unifiedTextarea.value !== newDoc,
                });
                if (unifiedTextarea.value !== newDoc) {
                    const pos = unifiedTextarea.selectionStart;
                    unifiedTextarea.value = newDoc;
                    unifiedTextarea.selectionStart = unifiedTextarea.selectionEnd = Math.min(pos, newDoc.length);
                    flashField();
                }
                updateDirtyIndicator();
            }

            unifiedTextarea.addEventListener('input', syncDraftFromFields);

            // ─── Chat interaction ───
            const messagesDiv = container.querySelector('#dle-lib-messages');
            const chatInput = container.querySelector('#dle-lib-chat-input');
            const sendBtn = container.querySelector('#dle-lib-send');
            const stopBtn = container.querySelector('#dle-lib-stop');

            /** edit/regenerate index mapping */
            let msgCounter = 0;

            function appendMessage(role, content) {
                if (role === 'ai' && popupEl.classList.contains('dle-librarian-chat-collapsed')) {
                    _chatUnreadCount++;
                    updateUnreadBadge();
                }
                const div = document.createElement('div');
                const msgIdx = msgCounter++;
                div.className = `dle-lib-msg dle-lib-msg-${role}`;
                div.dataset.msgIdx = msgIdx;

                if (role === 'ai') {
                    // Basic markdown — escapeHtml first so injection is safe.
                    let html = escapeHtml(content);
                    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
                    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
                    html = html.replace(/\n/g, '<br>');
                    div.innerHTML = `<img class="dle-lib-avatar" src="${emmaAvatarUrl}" alt="">`
                        + `<div class="dle-lib-msg-content">${html}</div>`
                        + `<button type="button" class="dle-lib-msg-action dle-lib-msg-regen" title="Regenerate" aria-label="Regenerate response"><i class="fa-solid fa-rotate-right"></i></button>`;
                } else {
                    div.innerHTML = `<div class="dle-lib-msg-content">${escapeHtml(content)}</div>`
                        + `<button type="button" class="dle-lib-msg-action dle-lib-msg-edit" title="Edit" aria-label="Edit message"><i class="fa-solid fa-pen"></i></button>`;
                }
                messagesDiv.appendChild(div);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            /**
             * Special-cases timeout errors (err.timedOut, set by callViaProfile)
             * with a deep-link to the timeout slider. Other errors fall through
             * to appendMessage as plain text.
             */
            function appendErrorMessage(err) {
                const isTimeout = !!(err && err.timedOut);
                if (!isTimeout) {
                    appendMessage('ai', `Error: ${classifyError(err)}`);
                    return;
                }
                if (popupEl.classList.contains('dle-librarian-chat-collapsed')) {
                    _chatUnreadCount++;
                    updateUnreadBadge();
                }
                const div = document.createElement('div');
                const msgIdx = msgCounter++;
                div.className = 'dle-lib-msg dle-lib-msg-ai';
                div.dataset.msgIdx = msgIdx;
                const body = escapeHtml(
                    'That request timed out. Likely the model + context is too big to finish in the configured window — common with large vault contexts and thinking-enabled Claude models on the forced-final-response step.'
                );
                const linkText = escapeHtml('Open Librarian timeout setting →');
                div.innerHTML = `<img class="dle-lib-avatar" src="${emmaAvatarUrl}" alt="">`
                    + `<div class="dle-lib-msg-content">${body}<br><br>`
                    + `<a href="#" class="dle-lib-timeout-link dle-notice-link" role="button">${linkText}</a>`
                    + `</div>`;
                messagesDiv.appendChild(div);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
                // Async import keeps settings-ui.js off the librarian critical path.
                div.querySelector('.dle-lib-timeout-link')?.addEventListener('click', async (e) => {
                    e.preventDefault();
                    try {
                        const m = await import('../ui/settings-ui.js');
                        m.openSettingsPopup?.({
                            tab: 'connection',
                            subtab: 'ai-connections',
                            toolKey: 'librarian',
                            target: 'dle-conn-librarian-timeout',
                        });
                    } catch (e2) { console.warn('[DLE] open settings (timeout link) failed:', e2); }
                });
            }

            // ─── Edit user message ───
            messagesDiv.addEventListener('click', async (e) => {
                const editBtn = e.target.closest('.dle-lib-msg-edit');
                if (!editBtn || sending) return;

                const msgDiv = editBtn.closest('.dle-lib-msg');
                const contentDiv = msgDiv.querySelector('.dle-lib-msg-content');
                const originalText = contentDiv.textContent;

                const textarea = document.createElement('textarea');
                textarea.className = 'text_pole dle-lib-msg-edit-area';
                textarea.value = originalText;
                textarea.rows = 3;
                contentDiv.replaceWith(textarea);
                editBtn.style.display = 'none';
                textarea.focus();

                const btnRow = document.createElement('div');
                btnRow.className = 'dle-lib-msg-edit-btns';
                btnRow.innerHTML = '<button type="button" class="menu_button_icon dle-lib-msg-edit-submit" title="Send edited message"><i class="fa-solid fa-check"></i></button>'
                    + '<button type="button" class="menu_button_icon dle-lib-msg-edit-cancel" title="Cancel edit"><i class="fa-solid fa-xmark"></i></button>';
                msgDiv.appendChild(btnRow);

                function cancelEdit() {
                    const newContent = document.createElement('div');
                    newContent.className = 'dle-lib-msg-content';
                    newContent.textContent = originalText;
                    textarea.replaceWith(newContent);
                    editBtn.style.display = '';
                    btnRow.remove();
                }

                btnRow.querySelector('.dle-lib-msg-edit-cancel').addEventListener('click', cancelEdit);
                textarea.addEventListener('keydown', (ke) => {
                    if (ke.key === 'Escape') { ke.stopPropagation(); cancelEdit(); }
                    if (ke.key === 'Enter' && ke.ctrlKey) { ke.preventDefault(); btnRow.querySelector('.dle-lib-msg-edit-submit').click(); }
                });

                btnRow.querySelector('.dle-lib-msg-edit-submit').addEventListener('click', async () => {
                    const newText = textarea.value.trim();
                    if (!newText) return;

                    // Map DOM index → session.messages index by counting user messages.
                    const allMsgs = [...messagesDiv.querySelectorAll('.dle-lib-msg')];
                    const domIdx = allMsgs.indexOf(msgDiv);
                    let sessionIdx = -1;
                    let userCount = 0;
                    for (let i = 0; i < session.messages.length; i++) {
                        if (session.messages[i].role === 'user') {
                            if (allMsgs.filter((m, mi) => mi <= domIdx && m.classList.contains('dle-lib-msg-user')).length === userCount + 1) {
                                sessionIdx = i;
                                break;
                            }
                            userCount++;
                        }
                    }

                    while (msgDiv.nextElementSibling) {
                        msgDiv.nextElementSibling.remove();
                    }

                    const newContent = document.createElement('div');
                    newContent.className = 'dle-lib-msg-content';
                    newContent.textContent = newText;
                    textarea.replaceWith(newContent);
                    editBtn.style.display = '';
                    btnRow.remove();

                    sending = true;
                    setSendingUI(true);
                    showLoading(true, 'Calling AI...');
                    const editOpts = buildSendOptions();

                    try {
                        const response = sessionIdx >= 0
                            ? await editMessage(session, sessionIdx, newText, editOpts)
                            : await sendMessage(session, newText, editOpts);
                        showLoading(false);
                        processAIResponse(response);
                    } catch (err) {
                        showLoading(false);
                        if (err.name !== 'AbortError' || err.timedOut) {
                            appendErrorMessage(err);
                        }
                    }
                    sending = false;
                    setSendingUI(false);
                });
            });

            // ─── Regenerate AI response ───
            messagesDiv.addEventListener('click', async (e) => {
                const regenBtn = e.target.closest('.dle-lib-msg-regen');
                if (!regenBtn || sending) return;

                sending = true;
                setSendingUI(true);

                const msgDiv = regenBtn.closest('.dle-lib-msg');
                msgDiv.classList.add('dle-lib-msg-stale');

                showLoading(true, 'Regenerating...');
                const regenOpts = buildSendOptions();

                try {
                    const response = await regenerateResponse(session, regenOpts);
                    showLoading(false);
                    msgDiv.remove();
                    processAIResponse(response);
                } catch (err) {
                    showLoading(false);
                    if (err.name !== 'AbortError' || err.timedOut) {
                        appendErrorMessage(err);
                    }
                }
                sending = false;
                setSendingUI(false);
            });

            // Loading state lives on the status line (setSendingUI). These remain
            // as no-ops only for call-site compatibility — the old in-chat spinner
            // duplicated the status line.
            function showLoading(_show, _stage) { /* no-op */ }
            function updateLoadingStage(_text) { /* no-op */ }

            function setSendingUI(isSending) {
                chatInput.disabled = isSending;
                sendBtn.style.display = isSending ? 'none' : '';
                stopBtn.style.display = isSending ? '' : 'none';
                const chatMessages = container.querySelector('#dle-lib-chat-messages');
                if (chatMessages) chatMessages.setAttribute('aria-busy', isSending ? 'true' : 'false');
                const statusLine = container.querySelector('#dle-lib-status-line');
                if (statusLine) {
                    if (isSending) {
                        statusLine.textContent = 'Emma is consulting the stacks';
                        statusLine.classList.add('dle-lib-status-thinking');
                        statusLine.hidden = false;
                        const cm = container.querySelector('#dle-lib-chat-messages');
                        if (cm) cm.scrollTop = cm.scrollHeight;
                    } else {
                        statusLine.classList.remove('dle-lib-status-thinking');
                        statusLine.hidden = true;
                        statusLine.textContent = '';
                    }
                }
            }

            // ─── Stop button ───
            stopBtn.addEventListener('click', () => {
                if (abortController) abortWith(abortController, 'stop_button');
                sending = false;
                setSendingUI(false);
                showLoading(false);
                appendMessage('ai', '*(Stopped by user)*');
            });

            // ─── Tool activity ───
            const TOOL_DISPLAY_NAMES = {
                search_vault: 'Searching vault',
                get_entry: 'Reading entry',
                get_full_content: 'Loading full entry',
                get_links: 'Checking links',
                get_backlinks: 'Checking backlinks',
                find_similar: 'Finding similar entries',
                list_flags: 'Checking flags',
                list_entries: 'Listing entries',
                get_recent_chat: 'Reading recent chat',
                flag_entry_update: 'Flagging for update',
                compare_entry_to_chat: 'Comparing to chat',
                get_writing_guide: 'Reading guide',
            };
            function toolDisplayName(name, args) {
                const friendly = TOOL_DISPLAY_NAMES[name] || name;
                const subject = args?.title || args?.query || '';
                return subject ? `${friendly}: ${subject}` : friendly;
            }

            /** Tool divs from the current turn — collapsed together at end of turn. */
            let turnToolDivs = [];

            function appendToolActivity(name, args) {
                const div = document.createElement('div');
                div.className = 'dle-lib-msg dle-lib-msg-tool';
                div.dataset.toolName = name;
                const label = toolDisplayName(name, args);
                div.innerHTML = `<div class="dle-lib-tool-header" role="button" tabindex="0" aria-expanded="false">`
                    + `<i class="fa-solid fa-wrench"></i> ${escapeHtml(label)}`
                    + ` <goo-spinner class="dle-lib-tool-spinner" size="22" color="currentColor" aria-hidden="true"></goo-spinner>`
                    + `</div>`
                    + `<div class="dle-lib-tool-result" hidden></div>`;
                // BUG-184: keyboard + mouse toggle.
                const _toolHdr = div.querySelector('.dle-lib-tool-header');
                const _toggleTool = () => {
                    const resultDiv = div.querySelector('.dle-lib-tool-result');
                    resultDiv.hidden = !resultDiv.hidden;
                    _toolHdr.setAttribute('aria-expanded', String(!resultDiv.hidden));
                };
                _toolHdr.addEventListener('click', _toggleTool);
                _toolHdr.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _toggleTool(); }
                });
                // Loading spinner stays at the bottom — insert tool div above it.
                const loadingEl = messagesDiv.querySelector('#dle-lib-loading');
                if (loadingEl) {
                    messagesDiv.insertBefore(div, loadingEl);
                } else {
                    messagesDiv.appendChild(div);
                }
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
                turnToolDivs.push(div);
                return div;
            }

            function completeToolActivity(toolDiv, result) {
                const spinner = toolDiv.querySelector('.dle-lib-tool-spinner');
                if (spinner) spinner.remove();
                const resultDiv = toolDiv.querySelector('.dle-lib-tool-result');
                if (resultDiv) {
                    resultDiv.textContent = result.length > 500 ? result.slice(0, 497) + '...' : result;
                }
            }

            function collapseToolActivity() {
                if (turnToolDivs.length === 0) return;
                const counts = {};
                for (const div of turnToolDivs) {
                    const name = TOOL_DISPLAY_NAMES[div.dataset.toolName] || div.dataset.toolName || 'tool';
                    counts[name] = (counts[name] || 0) + 1;
                }
                const summary = Object.entries(counts).map(([n, c]) => c > 1 ? `${n} x${c}` : n).join(', ');

                const wrap = document.createElement('div');
                wrap.className = 'dle-lib-msg dle-lib-msg-tool dle-lib-tool-collapsed';
                wrap.innerHTML = `<div class="dle-lib-tool-header" role="button" tabindex="0" aria-expanded="false">`
                    + `<i class="fa-solid fa-wrench"></i> ${escapeHtml(summary)}`
                    + ` <i class="fa-solid fa-chevron-down dle-lib-tool-expand-icon"></i>`
                    + `</div>`
                    + `<div class="dle-lib-tool-expanded" hidden></div>`;

                const expandArea = wrap.querySelector('.dle-lib-tool-expanded');
                for (const div of turnToolDivs) {
                    div.remove();
                    expandArea.appendChild(div);
                }

                // BUG-184: keyboard + mouse toggle.
                const _collHdr = wrap.querySelector('.dle-lib-tool-header');
                const _toggleCollapsed = () => {
                    const expanded = expandArea.hidden;
                    expandArea.hidden = !expanded;
                    _collHdr.setAttribute('aria-expanded', String(expanded));
                    const icon = wrap.querySelector('.dle-lib-tool-expand-icon');
                    if (icon) icon.className = expanded
                        ? 'fa-solid fa-chevron-up dle-lib-tool-expand-icon'
                        : 'fa-solid fa-chevron-down dle-lib-tool-expand-icon';
                };
                _collHdr.addEventListener('click', _toggleCollapsed);
                _collHdr.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _toggleCollapsed(); }
                });

                const lastAiMsg = messagesDiv.querySelector('.dle-lib-msg-ai:last-of-type');
                if (lastAiMsg) {
                    messagesDiv.insertBefore(wrap, lastAiMsg);
                } else {
                    messagesDiv.appendChild(wrap);
                }

                turnToolDivs = [];
            }

            function buildSendOptions() {
                // BUG-254/255: abort any prior in-flight controller before replacing.
                // Otherwise the prior call's listener still references the stale
                // controller and the user can't stop it.
                if (abortController) { try { abortWith(abortController, 'controller_replace'); } catch { /* noop */ } }
                abortController = new AbortController();
                turnToolDivs = [];
                let currentToolDiv = null;
                return {
                    signal: abortController.signal,
                    onToolCall: (name, args) => {
                        currentToolDiv = appendToolActivity(name, args);
                        updateLoadingStage(`Running ${name}...`);
                    },
                    onToolResult: (name, result) => {
                        if (currentToolDiv) completeToolActivity(currentToolDiv, result);
                        currentToolDiv = null;
                        // get_full_content writes session.draftState directly —
                        // sync the editor immediately so the user sees it.
                        if (name === 'get_full_content') {
                            updateFieldsFromDraft();
                            dirty = true;
                            dirtySinceLastWrite = true;
                        }
                    },
                };
            }

            /** Shared handler for draft/queue/options/exhaust responses. */
            function processAIResponse(response) {
                collapseToolActivity();
                if (getSettings().debugMode) console.debug('[DLE] processAIResponse:', { valid: response.valid, hasParsed: !!response.parsed, hasDraft: !!response.parsed?.draft, draftType: typeof response.parsed?.draft, exhausted: response.exhausted });

                if (response.valid && response.parsed) {
                    appendMessage('ai', response.parsed.message || '(no message)');
                    if (response.parsed.draft) {
                        if (getSettings().debugMode) console.debug('[DLE] processAIResponse: draft update received, fields:', Object.keys(response.parsed.draft));
                        updateFieldsFromDraft();
                        dirty = true;
                    }
                    if (response.parsed.queue) {
                        renderWorkQueue(container, session, response.parsed.queue);
                    }
                    if (response.parsed.options) {
                        renderOptionsCards(response.parsed.options);
                    }
                } else if (response.exhausted) {
                    const retryNote = response.lastErrors.length > 0
                        ? ` Last errors: ${response.lastErrors.join('; ')}.`
                        : '';
                    appendMessage('ai',
                        `Could not produce a valid response after 3 attempts.${retryNote} `
                        + `Try rephrasing your request, or edit the fields manually.`
                    );
                }
                debouncedSaveSession();
            }

            function renderOptionsCards(options) {
                messagesDiv.querySelectorAll('.dle-lib-options').forEach(el => el.remove());

                const wrap = document.createElement('div');
                wrap.className = 'dle-lib-options';

                for (let i = 0; i < options.length; i++) {
                    const opt = options[i];
                    const card = document.createElement('div');
                    card.className = 'dle-lib-option-card';

                    let fieldsHtml = '';
                    for (const [key, val] of Object.entries(opt.fields || {})) {
                        const display = Array.isArray(val) ? val.join(', ') : String(val);
                        const truncated = display.length > 120 ? display.slice(0, 117) + '...' : display;
                        fieldsHtml += `<div class="dle-lib-option-field"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(truncated)}</div>`;
                    }

                    card.innerHTML = `<div class="dle-lib-option-label">${escapeHtml(opt.label || `Option ${i + 1}`)}</div>`
                        + `<div class="dle-lib-option-fields">${fieldsHtml}</div>`
                        + `<button type="button" class="menu_button dle-lib-option-apply" data-option-idx="${i}">Apply This</button>`;
                    wrap.appendChild(card);
                }

                const dismissBtn = document.createElement('button');
                dismissBtn.className = 'menu_button dle-lib-option-dismiss';
                dismissBtn.textContent = 'Dismiss';
                dismissBtn.addEventListener('click', () => {
                    if (abortController) abortWith(abortController, 'dismiss_options');
                    sending = false;
                    setSendingUI(false);
                    showLoading(false);
                    wrap.remove();
                    appendMessage('ai', '*(Options dismissed)*');
                });
                wrap.appendChild(dismissBtn);

                messagesDiv.appendChild(wrap);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;

                wrap.addEventListener('click', (e) => {
                    const applyBtn = e.target.closest('.dle-lib-option-apply');
                    if (!applyBtn) return;
                    const idx = parseInt(applyBtn.dataset.optionIdx, 10);
                    const chosen = options[idx];
                    if (!chosen?.fields) return;

                    // BUG-AUDIT (Fix 11): preserve explicit null. Prior filter `!= null`
                    // dropped both null and undefined, silently ignoring options that
                    // proposed `cooldown: null` (clear the cooldown). Main draft merge
                    // already preserves null — align with that contract.
                    session.draftState = { ...session.draftState, ...chosen.fields };
                    dirty = true;
                    updateFieldsFromDraft();

                    wrap.remove();
                    appendMessage('ai', `Applied: ${chosen.label || `Option ${idx + 1}`}`);
                });
            }

            async function handleSend() {
                const text = chatInput.value.trim();
                if (sending) return;
                if (!text) {
                    chatInput.classList.remove('dle-shake');
                    void chatInput.offsetWidth;
                    chatInput.classList.add('dle-shake');
                    return;
                }
                // /options 3 <fields> → propose_options request.
                let finalText = text;
                const optionsMatch = text.match(/^\/options?\s+(\d+)\s+(.+)/i);
                if (optionsMatch) {
                    const count = optionsMatch[1];
                    const fields = optionsMatch[2].trim();
                    finalText = `Propose ${count} alternative options for ${fields}. Use the propose_options response format.`;
                }

                sending = true;
                setSendingUI(true);
                chatInput.value = '';
                chatInput.style.height = 'auto';
                appendMessage('user', text);
                showLoading(true, 'Preparing...');
                const opts = buildSendOptions();
                // BUG-240/243: capture this send's controller. If the user stops
                // and starts a new request before the old promise resolves, the
                // late handler must NOT clobber the new request's sending/UI state.
                const myController = abortController;
                const isStillMine = () => abortController === myController;

                try {
                    updateLoadingStage('Calling AI...');
                    const response = await sendMessage(session, finalText, opts);
                    if (!isStillMine()) { showLoading(false); return; }
                    if (!sending) {
                        showLoading(false);
                        return;
                    }
                    updateLoadingStage('Validating response...');
                    showLoading(false);
                    processAIResponse(response);
                } catch (err) {
                    if (!isStillMine()) return;
                    showLoading(false);
                    if (err.name !== 'AbortError' || err.timedOut) {
                        appendErrorMessage(err);
                    }
                }
                if (!isStillMine()) return;
                sending = false;
                setSendingUI(false);
                chatInput.focus();
            }

            sendBtn.addEventListener('click', handleSend);
            function autoResizeChatInput() {
                chatInput.style.height = 'auto';
                chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
            }
            chatInput.addEventListener('input', autoResizeChatInput);
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                }
                if (e.key === 'Enter' && e.ctrlKey) {
                    e.preventDefault();
                    handleSend();
                }
                // Escape blurs the input, doesn't close the popup.
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    chatInput.blur();
                }
            });
            // Ctrl+S → Write to Vault (inline, doesn't close popup).
            // Button lives in popup chrome (not container) — use document scope.
            container.addEventListener('keydown', (e) => {
                if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    const btn = document.querySelector('.dle-librarian-review #dle-lib-write-btn')
                        || container.querySelector('#dle-lib-write-btn');
                    if (btn && !btn.disabled) btn.click();
                }
            });

            // ─── Clear chat ───
            const clearChatBtn = container.querySelector('#dle-lib-clear-chat');
            clearChatBtn.addEventListener('click', () => {
                if (abortController) abortWith(abortController, 'clear_chat');
                sending = false;
                setSendingUI(false);
                showLoading(false);

                // Clears messages but keeps draft state.
                session.messages = [];
                msgCounter = 0;

                messagesDiv.innerHTML = '';
                const welcomeDiv = document.createElement('div');
                welcomeDiv.className = 'dle-lib-msg dle-lib-msg-ai';
                welcomeDiv.innerHTML = `<img class="dle-lib-avatar" src="${emmaAvatarUrl}" alt=""><div class="dle-lib-msg-content"><em>*dusts off the desk*</em> Clean slate. What are we working on?</div>`;
                messagesDiv.appendChild(welcomeDiv);

                messagesDiv.querySelectorAll('.dle-lib-options').forEach(el => el.remove());

                debouncedSaveSession();
                chatInput.focus();
            });

            // ─── Activity log toggle ───
            const activityBtn = container.querySelector('#dle-lib-activity-btn');
            const activityPanel = container.querySelector('#dle-lib-activity');

            function renderActivityLog() {
                // v2 combined feed: session tool calls + persistent search gaps.
                const feed = buildLibrarianActivityFeed();
                if (feed.length === 0) {
                    activityPanel.innerHTML = '<div class="dle-lib-activity-empty">No tool activity recorded yet.</div>';
                    return;
                }
                const session = getSessionActivityLog();
                const searches = session.filter(e => e.type === 'search').length;
                const flags = session.filter(e => e.type === 'flag').length;
                const totalTokens = session.reduce((sum, e) => sum + (e.tokens || 0), 0);
                let html = `<div class="dle-lib-activity-summary">${searches} search${searches !== 1 ? 'es' : ''}, ${flags} flag${flags !== 1 ? 's' : ''}, ~${totalTokens} tokens this session</div>`;

                for (const item of feed) {
                    const icon = item.kind === 'tool-search'
                        ? '<i class="fa-solid fa-magnifying-glass" aria-hidden="true" title="Search"></i>'
                        : item.kind === 'tool-flag'
                            ? '<i class="fa-solid fa-flag" aria-hidden="true" title="Flag"></i>'
                            : item.kind === 'gap-search'
                                ? '<i class="fa-solid fa-magnifying-glass" aria-hidden="true" title="Search (no results)"></i>'
                                : '<i class="fa-solid fa-flag" aria-hidden="true" title="Flag"></i>';
                    const meta = item.kind === 'gap-search'
                        ? 'no results'
                        : item.type === 'search'
                            ? `${item.resultCount} result${item.resultCount !== 1 ? 's' : ''}`
                            : (item.urgency || '');
                    const tokens = item.tokens ? `~${item.tokens}tok` : '';
                    html += `<div class="dle-lib-activity-row">`;
                    html += `<span class="dle-lib-activity-icon">${icon}</span>`;
                    html += `<span class="dle-lib-activity-query">${escapeHtml(item.query || '')}</span>`;
                    html += `<span class="dle-lib-activity-result">${escapeHtml(meta)}</span>`;
                    html += `<span class="dle-lib-activity-tokens">${tokens}</span>`;
                    html += `</div>`;
                }
                activityPanel.innerHTML = html;
            }

            activityBtn.addEventListener('click', () => {
                const expanded = activityPanel.hidden;
                activityPanel.hidden = !expanded;
                activityBtn.setAttribute('aria-expanded', String(expanded));
                if (expanded) renderActivityLog();
            });

            // ─── Chat panel collapse toggle ───
            const collapseBtn = container.querySelector('#dle-lib-chat-collapse');
            const popupEl = container.querySelector('.dle-librarian-popup');

            let _chatUnreadCount = 0;
            function updateUnreadBadge() {
                let badge = collapseBtn.querySelector('.dle-chat-unread');
                if (_chatUnreadCount > 0) {
                    if (!badge) {
                        badge = document.createElement('span');
                        badge.className = 'dle-chat-unread';
                        collapseBtn.appendChild(badge);
                    }
                    badge.textContent = _chatUnreadCount;
                } else if (badge) {
                    badge.remove();
                }
            }

            function setChatCollapsed(collapsed) {
                popupEl.classList.toggle('dle-librarian-chat-collapsed', collapsed);
                collapseBtn.setAttribute('aria-expanded', String(!collapsed));
                const icon = collapseBtn.querySelector('i');
                if (icon) icon.className = collapsed
                    ? 'fa-solid fa-chevron-left'
                    : 'fa-solid fa-chevron-right';
                if (!collapsed) { _chatUnreadCount = 0; updateUnreadBadge(); }
                // BUG-042: accountStorage for cross-browser sync.
                try { accountStorage.setItem('dle-librarian-panel-state', collapsed ? 'collapsed' : 'both'); } catch {}
            }

            // BUG-042: migrate legacy localStorage on first read.
            try {
                let state = accountStorage.getItem('dle-librarian-panel-state');
                if (!state) {
                    const legacy = localStorage.getItem('dle-librarian-panel-state');
                    if (legacy) {
                        accountStorage.setItem('dle-librarian-panel-state', legacy);
                        localStorage.removeItem('dle-librarian-panel-state');
                        state = legacy;
                    }
                }
                if (state === 'collapsed') setChatCollapsed(true);
            } catch {}

            collapseBtn.addEventListener('click', () => {
                const isCollapsed = popupEl.classList.contains('dle-librarian-chat-collapsed');
                setChatCollapsed(!isCollapsed);
            });

            // ─── Session persistence ───
            function debouncedSaveSession() {
                clearTimeout(_saveTimer);
                _saveTimer = setTimeout(() => saveSessionState(session, openEpoch), 500);
            }

            // ─── Restore session from saved state ───
            if (isRestored) {
                for (const msg of session.messages) {
                    if (msg.role === 'tool_result') {
                        // Replay tool_result rows as collapsed tool nodes.
                        const div = document.createElement('div');
                        div.className = 'dle-lib-msg dle-lib-msg-tool';
                        div.innerHTML = `<div class="dle-lib-tool-header" role="button" tabindex="0" aria-expanded="false">`
                            + `<i class="fa-solid fa-wrench"></i> Tool Results`
                            + `</div>`
                            + `<div class="dle-lib-tool-result" hidden></div>`;
                        const resultDiv = div.querySelector('.dle-lib-tool-result');
                        resultDiv.textContent = msg.content.length > 500 ? msg.content.slice(0, 497) + '...' : msg.content;
                        // BUG-184: keyboard + mouse.
                        const _hdr = div.querySelector('.dle-lib-tool-header');
                        const _tog = () => {
                            resultDiv.hidden = !resultDiv.hidden;
                            _hdr.setAttribute('aria-expanded', String(!resultDiv.hidden));
                        };
                        _hdr.addEventListener('click', _tog);
                        _hdr.addEventListener('keydown', (e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _tog(); }
                        });
                        messagesDiv.appendChild(div);
                    } else {
                        appendMessage(msg.role === 'user' ? 'user' : 'ai', msg.content);
                    }
                }
                if (session.draftState) {
                    dirty = true;
                    updateFieldsFromDraft();
                    updateDirtyIndicator();
                }
                if (session.workQueue?.length) {
                    renderWorkQueue(container, session, session.workQueue);
                }
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            // Auto-send initial prompt for gap entry (unless restoring).
            if (!isRestored && entryPoint === 'gap' && session.gapRecord && getSettings().librarianAutoSendOnGap !== false) {
                const isUpdate = session.gapRecord.subtype === 'update' && session.gapRecord.entryTitle;
                session._autoSendTimer = setTimeout(() => {
                    chatInput.value = isUpdate
                        ? `Review and update the entry for "${session.gapRecord.entryTitle}". Context: ${session.gapRecord.reason || session.gapRecord.query}`
                        : `Draft an entry for "${session.gapRecord.query}".`;
                    handleSend();
                }, 300);
            }
            // Audit mode kicks off the systematic review automatically.
            if (!isRestored && entryPoint === 'audit') {
                session._autoSendTimer = setTimeout(() => {
                    chatInput.value = 'Begin the audit. Pull the recent chat, cross-reference with vault entries, and flag anything stale or contradicted.';
                    handleSend();
                }, 300);
            }
        },
        onClosing: async () => {
            // BUG-236: dismiss must abort the in-flight call. Without this, the
            // call keeps burning tokens until the provider returns and any
            // history mutation becomes a ghost write against a closed session.
            if (abortController) { try { abortWith(abortController, 'popup_closing'); } catch { /* noop */ } }
            if (session._autoSendTimer) clearTimeout(session._autoSendTimer);
            clearTimeout(_saveTimer);
            // Only prompt when there are edits never written. Successful writes
            // clear dirtySinceLastWrite so a freshly-written session closes silently.
            const hasContent = session.draftState?.title || session.draftState?.summary || session.draftState?.content || (session.draftState?.keys?.length > 0);
            if (dirtySinceLastWrite && hasContent) {
                const confirmResult = await callGenericPopup(
                    hasWrittenOnce
                        ? 'You have changes since your last write. Discard them, or keep the session for later?'
                        : 'You have unsaved changes. Discard draft, or keep session for later?',
                    POPUP_TYPE.CONFIRM,
                    '', { okButton: 'Discard', cancelButton: 'Keep for Later' },
                );
                if (confirmResult === POPUP_RESULT.AFFIRMATIVE) {
                    clearSessionState(openEpoch);
                    return true;
                }
                saveSessionState(session, openEpoch);
                return true;
            }
            clearSessionState(openEpoch);
            return true;
        },
    });
    // Writing happens via the in-popup "Write to Vault" button, which opens a
    // nested confirm dialog and leaves this popup open after completion. The
    // popup itself only has a Close button.
}

// ════════════════════════════════════════════════════════════════════════════
// Write to Vault
// ════════════════════════════════════════════════════════════════════════════

async function writeToVault(session, opts = {}) {
    const statusEl = opts.statusEl || null;
    const setStatus = (text, kind) => {
        if (!statusEl) return;
        statusEl.textContent = text || '';
        statusEl.classList.remove('dle-lib-write-status--ok', 'dle-lib-write-status--err');
        if (kind === 'ok') statusEl.classList.add('dle-lib-write-status--ok');
        if (kind === 'err') statusEl.classList.add('dle-lib-write-status--err');
    };
    const settings = getSettings();
    const draft = session.draftState;
    if (!draft || !draft.title) {
        toastr.warning(tr('dle_lib_toast_no_draft'), 'DeepLore Enhanced');
        setStatus('Needs a title.', 'err');
        return false;
    }

    // No keys → can't match in chat (unless constant). Confirm with the user.
    if (!draft.keys?.length) {
        const proceed = await callGenericPopup(
            'This entry has no trigger keys, so it won\'t match in chat unless it\'s a constant. Write anyway?',
            POPUP_TYPE.CONFIRM,
            '', { okButton: 'Write Anyway', cancelButton: 'Go Back' },
        );
        if (proceed !== POPUP_RESULT.AFFIRMATIVE) return false;
    }

    // Per-write destination: explicit picker (session.writeTargetVault) wins,
    // else the configured librarianWriteVaultId, else primary. resolveWriteVault
    // falls through cleanly when a configured name no longer exists.
    const vault = resolveWriteVault('librarian', settings, session?.writeTargetVault);
    const safeTitle = sanitizeFilename(draft.title);
    const folder = settings.librarianWriteFolder || settings.autoSuggestFolder || '';
    const filename = folder ? `${folder}/${safeTitle}.md` : `${safeTitle}.md`;

    const tags = draft.tags?.length ? draft.tags : [settings.lorebookTag || 'lorebook'];
    const typeStr = draft.type || 'lore';
    // BUG-AUDIT (Fix 10): strip the model's leading `# ${title}` — the write
    // line below unconditionally prepends one, so without this the disk file
    // gets two H1s.
    const safeContent = stripLeadingMatchingH1(stripObsidianSyntax(draft.content || ''), draft.title);
    let frontmatterBlock;
    if (session.frontmatterUserEdited && typeof session.frontmatterOverride === 'string' && session.frontmatterOverride.trim()) {
        // User-edited frontmatter takes precedence — they own it now.
        frontmatterBlock = session.frontmatterOverride.trim();
    } else {
        const keysYaml = (draft.keys || []).map(k => `  - ${yamlEscape(k)}`).join('\n');
        const tagsYaml = tags.map(t => `  - ${yamlEscape(t)}`).join('\n');
        const fileClassLine = typeStr !== 'story' ? `fileClass: ${yamlEscape(typeStr)}\n` : '';
        frontmatterBlock = `---\n${fileClassLine}type: ${yamlEscape(typeStr)}\nstatus: active\npriority: ${draft.priority || 50}\ntags:\n${tagsYaml}\nkeys:\n${keysYaml}\nsummary: "${(draft.summary || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"\n---`;
    }
    const fileContent = `${frontmatterBlock}\n# ${draft.title}\n\n${safeContent}`;

    // Confirm preview — nested dialog stacked over the Librarian popup.
    const lineCount = fileContent.split('\n').length;
    const byteCount = new Blob([fileContent]).size;
    const tagsPreview = tags.join(', ');
    const previewHtml = document.createElement('div');
    previewHtml.innerHTML = `<h3 style="margin:0 0 8px 0;">Write entry to vault?</h3>`
        + `<div style="margin-bottom:6px"><strong>File:</strong> <code>${escapeHtml(filename)}</code></div>`
        + `<div style="margin-bottom:6px;font-size:11px;opacity:0.85;">`
        + `<strong>Title:</strong> ${escapeHtml(draft.title)} &nbsp; `
        + `<strong>Type:</strong> ${escapeHtml(typeStr)} &nbsp; `
        + `<strong>Priority:</strong> ${draft.priority || 50} &nbsp; `
        + `<strong>Keys:</strong> ${(draft.keys || []).length} &nbsp; `
        + `<strong>Tags:</strong> ${escapeHtml(tagsPreview)} &nbsp; `
        + `<strong>${lineCount} lines / ${byteCount} bytes</strong>`
        + `</div>`
        + `<pre style="max-height:360px;overflow-y:auto;font-size:11px;padding:8px;background:var(--SmartThemeBlurTintColor);border-radius:4px;white-space:pre-wrap;word-break:break-word">${escapeHtml(fileContent)}</pre>`;
    const confirmWrite = await callGenericPopup(previewHtml, POPUP_TYPE.CONFIRM, '', {
        wider: true,
        allowVerticalScrolling: true,
        okButton: 'Write',
        cancelButton: 'Cancel',
    });
    if (confirmWrite !== POPUP_RESULT.AFFIRMATIVE) {
        setStatus('Write cancelled.', null);
        return false;
    }

    try {
        const data = await writeNote(vault.host, vault.port, vault.apiKey, filename, fileContent, !!vault.https);
        if (data.ok) {
            toastr.success(trf('dle_lib_toast_written', draft.title, filename), 'DeepLore Enhanced');
            setStatus(`Written to ${filename}`, 'ok');

            if (session.gapRecord?.id) {
                updateGapStatus(session.gapRecord.id, 'written');
            }

            const s = getSettings();
            if (!s.analyticsData._librarian) {
                s.analyticsData._librarian = {
                    totalGapSearches: 0, totalGapFlags: 0,
                    totalEntriesWritten: 0, totalEntriesUpdated: 0,
                    topUnmetQueries: [],
                };
            }
            s.analyticsData._librarian.totalEntriesWritten =
                (s.analyticsData._librarian.totalEntriesWritten || 0) + 1;
            const stCtx = getContext();
            if (stCtx?.saveSettingsDebounced) stCtx.saveSettingsDebounced();

            // BUG-AUDIT: toastr on rebuild failure — otherwise the newly-written
            // entry stays un-indexed and invisible to retrieval until the next
            // manual refresh.
            buildIndex(true).catch(err => {
                console.warn('[DLE] Post-write index rebuild failed:', err?.message);
                try {
                    toastr.warning(
                        trf('dle_lib_toast_reindex_failed', err?.message || 'unknown error'),
                        'DeepLore Enhanced',
                        { timeOut: 10000 },
                    );
                } catch { /* toastr unavailable */ }
            });
            return true;
        } else {
            console.warn('[DLE] Librarian write failed:', data && data.error);
            toastr.error(tr('dle_lib_toast_write_failed'), 'DeepLore Enhanced');
            setStatus('Write failed.', 'err');
            return false;
        }
    } catch (err) {
        toastr.error(classifyError(err), 'DeepLore Enhanced');
        setStatus('Write failed.', 'err');
        return false;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Work Queue (Vault Review)
// ════════════════════════════════════════════════════════════════════════════

function renderWorkQueue(container, session, queue) {
    let queueDiv = container.querySelector('#dle-lib-queue');
    if (!queueDiv) {
        queueDiv = document.createElement('div');
        queueDiv.id = 'dle-lib-queue';
        queueDiv.className = 'dle-librarian-queue';
        const chatDiv = container.querySelector('.dle-librarian-chat');
        const inputRow = container.querySelector('.dle-librarian-input-row');
        chatDiv.insertBefore(queueDiv, inputRow);
    }

    const MAX_QUEUE_ITEMS = 5;
    const capped = queue.slice(0, MAX_QUEUE_ITEMS);
    let html = '<div class="dle-lib-queue-header">Suggestions — click to draft</div>';
    for (let i = 0; i < capped.length; i++) {
        const item = queue[i];
        const urgencyClass = item.urgency === 'high' ? 'dle-lib-queue-urgent' : '';
        html += `<div class="dle-lib-queue-item ${urgencyClass}" data-queue-idx="${i}">
            <span class="dle-lib-queue-action">${item.action === 'create' ? '+' : '~'}</span>
            <span class="dle-lib-queue-title">${escapeHtml(item.title)}</span>
            <span class="dle-lib-queue-reason">${escapeHtml(item.reason)}</span>
        </div>`;
    }
    queueDiv.innerHTML = html;

    queueDiv.querySelectorAll('.dle-lib-queue-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = Number(el.dataset.queueIdx);
            const item = queue[idx];
            if (item) {
                const chatInput = container.querySelector('#dle-lib-chat-input');
                if (chatInput) {
                    chatInput.value = `Draft an entry for "${item.title}" (${item.action}). Reason: ${item.reason}`;
                    container.querySelector('#dle-lib-send')?.click();
                }
            }
        });
    });
}
