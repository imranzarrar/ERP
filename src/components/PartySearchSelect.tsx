import React from 'react';
import { createPortal } from 'react-dom';

export interface SearchableParty {
  id: string;
  name: string;
  code?: string | null;
  vatNumber?: string | null;
  isSystem?: boolean;
}

interface PartySearchSelectProps {
  items: SearchableParty[];
  valueId: string;
  onSelect: (id: string) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
  noMatchesLabel?: string;
  systemLabel?: string;
}

// Searchable replacement for the plain name-only `<select>` used everywhere a
// customer/vendor is picked (Invoice/Quotation create forms, the quotation→invoice
// convert modal, POS). Matches on name, the auto-generated customer/vendor code, or VAT
// number — a long customer list is otherwise only navigable by the browser's own
// type-by-first-letter behavior. Modeled directly on ItemCatalogSearch.tsx's
// portal-rendered-dropdown pattern (see that file's comment for why it exists instead of
// a native `<input list>`/`<datalist>`); this component is a controlled-by-id sibling of
// it rather than a merge, since a party has no barcode-scan/exact-match use case.
export default function PartySearchSelect({
  items, valueId, onSelect, placeholder, required, className, noMatchesLabel, systemLabel,
}: PartySearchSelectProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const [coords, setCoords] = React.useState({ top: 0, left: 0, width: 0 });
  const inputRef = React.useRef<HTMLInputElement>(null);

  const selected = items.find(it => it.id === valueId);

  // Mirrors the selected item's name into the text box whenever the selection changes
  // from outside (a form reset, editing a different document) — but never while the
  // dropdown is open and the user is actively typing a new search.
  React.useEffect(() => {
    if (!isOpen) setQuery(selected ? selected.name : '');
  }, [selected, isOpen]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter(it =>
        it.name.toLowerCase().includes(q) ||
        (it.code && it.code.toLowerCase().includes(q)) ||
        (it.vatNumber && it.vatNumber.toLowerCase().includes(q))
      )
    : items;

  const measure = React.useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setCoords({ top: rect.bottom, left: rect.left, width: rect.width });
  }, []);

  const open = () => {
    setQuery('');
    measure();
    setHighlightedIndex(0);
    setIsOpen(true);
  };

  React.useLayoutEffect(() => {
    if (!isOpen) return;
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [isOpen, measure]);

  const handleSelect = (item: SearchableParty) => {
    onSelect(item.id);
    setQuery(item.name);
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
      // Always swallow Enter while this combobox is open — even with no match, so it
      // never falls through to the browser's native "submit the form" behavior. A
      // customer/vendor must come from an actual selection, never from whatever text
      // happens to be sitting in the box when the user hits Enter.
      e.preventDefault();
      if (filtered[highlightedIndex]) {
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
        value={isOpen ? query : (selected ? selected.name : '')}
        onChange={(e) => {
          setQuery(e.target.value);
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
            <div className="px-3 py-2 text-xs text-slate-400">{noMatchesLabel || 'No matches'}</div>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleSelect(item)}
                className={`w-full text-start px-3 py-2 text-xs border-b border-slate-50 last:border-b-0 transition-colors ${
                  i === highlightedIndex ? 'bg-indigo-50' : 'hover:bg-slate-50'
                }`}
              >
                <span className="font-bold text-slate-800 block">
                  {item.name} {item.isSystem && systemLabel ? <span className="font-normal text-slate-400">({systemLabel})</span> : ''}
                </span>
                {(item.code || item.vatNumber) && (
                  <span className="text-slate-400 text-[11px] font-mono">
                    {[item.code, item.vatNumber].filter(Boolean).join(' • ')}
                  </span>
                )}
              </button>
            ))
          )}
        </div>,
        document.body
      )}
    </>
  );
}
