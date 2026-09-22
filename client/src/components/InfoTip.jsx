import { useState } from 'react';

export const GLOSSARY = {
  commitment: {
    title: 'What is a commitment?',
    body: 'Something you plan to complete today or by an agreed deadline.',
  },
  carryForward: {
    title: 'What is carry-forward?',
    body: "Work from an earlier commitment that wasn't finished. The original record stays exactly as it was — a new entry is created with a fresh target date so nothing gets lost or overwritten.",
  },
  supportRequest: {
    title: 'What happens when I request support?',
    body: "Your task is flagged Support Required right away, and a request lands in every Leader's inbox for review. Nothing else about the task changes until a Leader approves or rejects it — approving moves it back to In Progress.",
  },
  recurring: {
    title: 'Recurring vs. Ad-hoc',
    body: 'Recurring = work you do regularly (daily, weekly…). Ad-hoc = a one-time or unexpected task.',
  },
  dependency: {
    title: 'What does "who are you waiting for" mean?',
    body: 'The person or team whose action you need before you can move forward.',
  },
  priority: {
    title: 'What is priority?',
    body: 'How urgent this is relative to your other work — High, Medium, or Low.',
  },
  recoveryAction: {
    title: 'What is a recovery action?',
    body: "What you plan to do to get this back on track, now that it's late.",
  },
  leaderScore: {
    title: "What's a Leader Score?",
    body: "Your leader's judgment call on things numbers can't fully capture — ownership, communication, follow-through. It's kept separate from the objective completion percentages, which are calculated automatically.",
  },
};

/** Small inline "ⓘ" that reveals a plain-language explanation. Never blocks the flow — purely additive. */
export default function InfoTip({ term, children }) {
  const [open, setOpen] = useState(false);
  const entry = term ? GLOSSARY[term] : null;
  const title = entry?.title;
  const body = children || entry?.body;
  if (!body) return null;

  return (
    <span className="relative inline-block align-middle ml-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        aria-label={title || 'More information'}
        className="w-4 h-4 inline-flex items-center justify-center rounded-full bg-grey-200 text-grey-600 text-[10px] font-bold transition-colors hover:bg-brand-100 hover:text-brand-700"
      >
        i
      </button>
      {open && (
        // span (not div) so this stays valid nested inside <p>/<h2>/<label> wrappers, which only permit phrasing content
        <span className="block absolute z-20 left-0 top-6 w-64 bg-grey-900 text-white text-xs rounded-xl p-3 shadow-lg animate-scale-in">
          {title && <span className="block font-semibold mb-1">{title}</span>}
          <span className="block text-grey-300 leading-snug">{body}</span>
        </span>
      )}
    </span>
  );
}
