import React from 'react';
import { createPortal } from 'react-dom';

export interface CatalogItem {
  id: string;
  name: string;
  unitPrice?: number;
  description?: string;
  unit?: string;
  // Base-product barcode/SKU — matched exactly (not substring) against the typed/scanned
  // query, so a barcode scanner (which types the code then presses Enter) resolves
  // directly to this item regardless of what its name is.
  barcode?: string | null;
  sku?: string | null;
  // Set only on a synthetic row representing one of this product's packaging/alternate
  // units (see ProductUnitConversion) — callers build one extra CatalogItem per active
  // packaging unit, each carrying that packaging level's OWN barcode/sku/price so it
  // resolves to itself when scanned, not silently falls through to the base product.
  // null/undefined on the base-unit row itself.
  unitOfMeasureId?: string | null;
  conversionFactor?: number;
}

interface ItemCatalogSearchProps {
  value: string;
  items: CatalogItem[];
  onChangeText: (value: string) => void;
  onSelectItem: (item: CatalogItem) => void;
  placeholder?: string;
  currencySymbol: string;
  required?: boolean;
  className?: string;
  noMatchesLabel: string;
}

// Replaces the native `<input list="..."><datalist>` pattern used across Quotation/
// Invoice/Expense line items. Native datalist popups are rendered entirely by the
// browser's own UI shell — outside the DOM, immune to any CSS on the page — and
// Chromium has a long-standing rendering bug where a datalist popup's position/size is
// computed off the initial full option list and only corrects itself once the filtered
// list changes size. That's the "click → misaligned, then type → aligns" bug this
// component exists to eliminate, in both LTR and RTL.
//
// This renders its own dropdown instead - which means it's a normal DOM element,
// subject to normal CSS overflow/clipping from its ancestors. The line-item tables it
// lives in wrap their rows in `overflow-x-auto overflow-y-visible` (for horizontal
// scroll on narrow screens) - per the CSS spec, when one axis is set to something other
// than `visible`, a `visible` value on the *other* axis is silently treated as `auto`,
// so that wrapper actually clips both axes, not just X. A plain `position: absolute`
// dropdown would get clipped to nothing by it. Rendered through a portal into
// `document.body` instead, with its position measured fresh (via getBoundingClientRect)
// every time it opens and on scroll/resize while open - escapes that ancestor entirely
// and never goes stale, unlike the native bug this replaces.
export default function ItemCatalogSearch({
  value, items, onChangeText, onSelectItem, placeholder, currencySymbol, required, className, noMatchesLabel,
}: ItemCatalogSearchProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const [coords, setCoords] = React.useState({ top: 0, left: 0, width: 0 });
  const inputRef = React.useRef<HTMLInputElement>(null);

  const trimmed = value.trim();
  const query = trimmed.toLowerCase();
  // A barcode/SKU is matched exactly, never as a substring — a scanner types the full
  // code and hits Enter, so an exact hit (base product OR one of its packaging units,
  // each a separate row — see CatalogItem's comment) takes priority over name search
  // entirely, resolving straight to that one item instead of a filtered list.
  const codeHits = trimmed
    ? items.filter(it => it.barcode === trimmed || (it.sku && it.sku.toLowerCase() === query))
    : [];
  const filtered = codeHits.length > 0
    ? codeHits
    : (query ? items.filter(it => it.name.toLowerCase().includes(query)) : items);

  const measure = React.useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setCoords({ top: rect.bottom, left: rect.left, width: rect.width });
  }, []);

  const open = () => {
    measure();
    setHighlightedIndex(0);
    setIsOpen(true);
  };

  React.useLayoutEffect(() => {
    if (!isOpen) return;
    measure();
    // Capture phase so this also catches scrolling on an ancestor (the table's own
    // horizontal/vertical scroll container), not just window-level scroll.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [isOpen, measure]);

  const handleSelect = (item: CatalogItem) => {
    onChangeText(item.name);
    onSelectItem(item);
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (filtered[highlightedIndex]) {
        e.preventDefault();
        handleSelect(filtered[highlightedIndex]);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        required={required}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChangeText(e.target.value);
          setHighlightedIndex(0);
          measure();
          setIsOpen(true);
        }}
        onFocus={open}
        onBlur={() => setIsOpen(false)}
        onKeyDown={handleKeyDown}
        autoComplete="off"
        className={className}
      />
      {isOpen && createPortal(
        <div
          style={{ position: 'fixed', top: coords.top, left: coords.left, width: coords.width }}
          className="z-50 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-y-auto"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400">{noMatchesLabel}</div>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                type="button"
                // Prevents the input's blur (and this dropdown closing) from firing
                // before the click is registered — the standard, timeout-free way to
                // make a custom combobox's options reliably clickable.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleSelect(item)}
                className={`w-full text-start px-3 py-2 text-xs border-b border-slate-50 last:border-b-0 transition-colors ${
                  i === highlightedIndex ? 'bg-indigo-50' : 'hover:bg-slate-50'
                }`}
              >
                <span className="font-bold text-slate-800 block">{item.name}</span>
                <span className="text-slate-400 text-[11px]">
                  {Number(item.unitPrice || 0).toFixed(2)} {currencySymbol}
                  {item.description ? ` — ${item.description}` : ''}
                </span>
              </button>
            ))
          )}
        </div>,
        document.body
      )}
    </>
  );
}
