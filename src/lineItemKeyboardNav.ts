import React from 'react';

// Shared fast-entry keyboard flow for a line-item grid (Invoice/Quotation creation) —
// attach as onKeyDown on the <tbody> (or whatever element directly wraps the item rows).
// Deliberately DOM-traversal based (queries the container's own focusable elements)
// rather than per-field refs, so it works unchanged regardless of which field components
// a row uses (a plain <input>, a <select>, or a component like ItemCatalogSearch that
// manages its own internal ref) — nothing here needs to know that shape.
//
// - Enter (no modifiers) in any field: like Tab, moves to the next focusable field in DOM
//   order. Enter on the LAST field of the LAST row instead adds a new row (via onAddRow)
//   and focuses its first field once React has re-rendered it — the core "keep typing,
//   never reach for the mouse" flow this exists for.
// - Alt+Backspace in any field: removes that field's own row (via onRemoveRow), mirroring
//   the row's mouse-only trash-icon button. Alt+Backspace specifically (not plain
//   Backspace/Delete, and not Ctrl+Backspace, which deletes the previous word in a text
//   field) so it can never fire from someone just editing a value.
export function handleLineItemGridKeyDown(
  e: React.KeyboardEvent<HTMLElement>,
  opts: { onAddRow: () => void; onRemoveRow: (rowIndex: number) => void; rowSelector?: string }
): void {
  const container = e.currentTarget;
  const rowSelector = opts.rowSelector || 'tr';
  const focusableSelector = 'input:not(:disabled), select:not(:disabled), textarea:not(:disabled)';

  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON') return;
    e.preventDefault();
    const focusables: HTMLElement[] = Array.from(container.querySelectorAll(focusableSelector));
    const idx = focusables.indexOf(target);
    if (idx === -1) return;
    if (idx < focusables.length - 1) {
      const next: HTMLElement = focusables[idx + 1];
      next.focus();
      if (next instanceof HTMLInputElement) next.select();
      return;
    }
    const priorCount = focusables.length;
    opts.onAddRow();
    // The new row doesn't exist in the DOM yet on this tick — wait for React's render.
    requestAnimationFrame(() => {
      const updated: HTMLElement[] = Array.from(container.querySelectorAll(focusableSelector));
      updated[priorCount]?.focus();
    });
    return;
  }

  if (e.key === 'Backspace' && e.altKey) {
    const target = e.target as HTMLElement;
    const row = target.closest(rowSelector);
    if (!row) return;
    const rows = Array.from(container.querySelectorAll(rowSelector));
    const rowIdx = rows.indexOf(row);
    if (rowIdx === -1) return;
    e.preventDefault();
    opts.onRemoveRow(rowIdx);
  }
}

// Attach as onKeyDown on the <form> itself — Ctrl/Cmd+S saves instead of triggering the
// browser's own "Save Page As" dialog. Uses requestSubmit() rather than calling the
// submit handler directly so the form's own validation (required fields, etc.) still runs
// exactly as it would for a real click on the submit button.
export function handleFormSaveShortcut(e: React.KeyboardEvent<HTMLFormElement>): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    e.currentTarget.requestSubmit();
  }
}
