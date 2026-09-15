import { useState } from 'react';
import { Collapse } from './ui';

/** A dismissible-by-toggle "How does this work?" strip. Purely explanatory — never gates functionality. */
export default function HelpBanner({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs font-semibold text-brand-600 hover:text-brand-800 transition-colors flex items-center gap-1.5 press-scale"
      >
        <span className="w-4 h-4 inline-flex items-center justify-center rounded-full bg-brand-100 text-brand-600 text-[10px] font-bold">i</span>
        How does this work?
        <svg className={`w-3 h-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      <Collapse open={open}>
        <div className="mt-2 bg-brand-50 border border-brand-100 text-brand-900 text-sm rounded-xl px-4 py-3 leading-relaxed">
          {children}
        </div>
      </Collapse>
    </div>
  );
}
