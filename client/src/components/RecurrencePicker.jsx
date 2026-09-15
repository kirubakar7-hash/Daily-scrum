import { Check } from 'lucide-react';
import { Input, Select } from './ui';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // index+1 = ISO weekday (1=Mon..7=Sun)
const UNIT_OPTIONS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];

export const DEFAULT_RULE = { interval: 1, unit: 'day', weekdays: [], end: { type: 'never' } };

/** A Teams/Outlook-style recurrence builder: "repeat every N days/weeks/months", specific weekdays for
 *  a weekly cadence, and an end condition (never / on a date / after N occurrences). Fully controlled. */
export default function RecurrencePicker({ value, onChange }) {
  const rule = value || DEFAULT_RULE;
  const end = rule.end || { type: 'never' };

  function update(patch) {
    onChange({ ...rule, ...patch });
  }

  function toggleWeekday(day) {
    const set = new Set(rule.weekdays || []);
    if (set.has(day)) set.delete(day); else set.add(day);
    update({ weekdays: [...set].sort((a, b) => a - b) });
  }

  function updateEnd(patch) {
    update({ end: { ...end, ...patch } });
  }

  const unitPlural = rule.interval === 1 ? '' : 's';

  return (
    <div className="space-y-3 bg-grey-50 rounded-xl p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-grey-700 shrink-0">Repeat every</span>
        <input
          type="number"
          min={1}
          max={365}
          value={rule.interval}
          onChange={(e) => update({ interval: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })}
          className="w-16 rounded-xl border border-grey-300 px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500"
        />
        <Select value={rule.unit} onChange={(e) => update({ unit: e.target.value, weekdays: e.target.value === 'week' ? rule.weekdays : [] })} className="w-32">
          {UNIT_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}{unitPlural}</option>)}
        </Select>
      </div>

      {rule.unit === 'week' && (
        <div>
          <span className="block text-xs font-medium text-grey-500 mb-1.5">On these days</span>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAY_LABELS.map((label, i) => {
              const day = i + 1;
              const selected = (rule.weekdays || []).includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleWeekday(day)}
                  className={`inline-flex items-center gap-1 text-xs font-medium rounded-full px-2.5 py-1.5 border transition-all ${
                    selected ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-grey-600 border-grey-200 hover:border-brand-300 hover:text-brand-700'
                  }`}
                >
                  {selected && <Check className="w-3 h-3" />}
                  {label}
                </button>
              );
            })}
          </div>
          {(rule.weekdays || []).length === 0 && (
            <p className="text-xs text-grey-400 mt-1.5">No days picked — repeats on the same weekday as the due date.</p>
          )}
        </div>
      )}

      <div>
        <span className="block text-xs font-medium text-grey-500 mb-1.5">Ends</span>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-grey-700 cursor-pointer">
            <input type="radio" name="rp-end" checked={end.type === 'never'} onChange={() => updateEnd({ type: 'never' })} className="accent-[#16469D]" />
            Never
          </label>
          <label className="flex items-center gap-2 text-sm text-grey-700 cursor-pointer flex-wrap">
            <input type="radio" name="rp-end" checked={end.type === 'on_date'} onChange={() => updateEnd({ type: 'on_date' })} className="accent-[#16469D]" />
            On date
            {end.type === 'on_date' && (
              <Input type="date" value={end.date || ''} onChange={(e) => updateEnd({ type: 'on_date', date: e.target.value })} className="w-auto" />
            )}
          </label>
          <label className="flex items-center gap-2 text-sm text-grey-700 cursor-pointer flex-wrap">
            <input type="radio" name="rp-end" checked={end.type === 'after_count'} onChange={() => updateEnd({ type: 'after_count', count: end.count || 10 })} className="accent-[#16469D]" />
            After
            {end.type === 'after_count' && (
              <input
                type="number"
                min={1}
                max={999}
                value={end.count || 10}
                onChange={(e) => updateEnd({ type: 'after_count', count: Math.max(1, Math.min(999, Number(e.target.value) || 1)) })}
                className="w-16 rounded-xl border border-grey-300 px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500"
              />
            )}
            occurrences
          </label>
        </div>
      </div>
    </div>
  );
}
