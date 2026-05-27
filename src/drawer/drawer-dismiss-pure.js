/**
 * Pure helper for the drawer's outside-click dismiss handler.
 *
 * No imports from ST / jQuery. Test/integration imports this without DOM.
 *
 * Background (gotchas.md #56): ST's `callGenericPopup` renders <dialog class="popup">
 * to document.body — NOT inside `#deeplore-panel`. The naive "click outside panel
 * dismisses drawer" check therefore fires on every click inside a popup spawned
 * from the drawer (rule-builder, vault-scan, optimize-keys, the "Why not?" diag
 * popup, callGenericPopup confirms, etc.), closing the drawer behind the popup.
 *
 * This helper centralizes the bail conditions so both the live handler and the
 * regression test exercise the same logic.
 *
 * @param {Element|null} target - Click event target (or null).
 * @param {Element|null} panel - The drawer panel element (`#deeplore-panel`).
 * @param {Document} [doc] - DOM document for `dialog[open]` lookup. Defaults to globalThis.document.
 * @returns {boolean} true → drawer should NOT dismiss (bail), false → safe to dismiss.
 */
export function shouldBailDrawerDismiss(target, panel, doc = (typeof document !== 'undefined' ? document : null)) {
    if (!target) return true;                           // defensive: no target → don't dismiss
    if (!target.closest) return true;                   // not a real element (text node, etc.)
    if (panel && panel.contains && panel.contains(target)) return true;    // inside the panel itself
    // Drawer toggle / icon — those have their own handlers; outside-click must not interfere.
    if (target.closest('.drawer-toggle, #deeploreDrawerIcon')) return true;
    // ST popup chrome:
    //   - callGenericPopup produces <dialog class="popup"> appended to <body>.
    //     Subclasses include .popup--input, .popup--confirm, .wide_dialogue_popup, etc.,
    //     but the base `.popup` class is invariant — match on that.
    //   - `dialog[open]` covers any open native dialog (DLE's own modals, ST's
    //     character-import dialog, future popups that skip the .popup class).
    //   - `.toast` / `.toast-container` covers toastr notifications (some are
    //     click-to-dismiss, others have action buttons — either way a click on
    //     a toast must NOT close the drawer behind it).
    //   - `.ui-dialog` is the legacy jQuery-UI dialog class still used by a few
    //     ST surfaces (kept for forward-compat; cheap to include).
    if (target.closest('dialog.popup, .popup, .toast, .toast-container, dialog[open], .ui-dialog')) return true;
    // Defense in depth: if any dialog is open anywhere on the page and contains
    // the click target, bail. Catches cases where a popup root lacks .popup
    // (custom dialogs from third-party extensions, polyfilled <dialog>).
    if (doc && doc.querySelector) {
        const openDialog = doc.querySelector('dialog[open]');
        if (openDialog && openDialog.contains && openDialog.contains(target)) return true;
    }
    return false;
}
