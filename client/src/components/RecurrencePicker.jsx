import { useId, useState } from 'react';
import { Check } from 'lucide-react';
import { Input, Select } from './ui';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // index+1 = ISO weekday (1=Mon..7=Sun)
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb 29 allowed — it falls on the 28th in non-leap years
const UNIT_OPTIONS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
const BUSINESS_DAYS = [1, 2, 3, 4, 5];

const PRESETS = [
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['business', 'Business Week (Mon–Fri)'],
  ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'],
  ['half', 'Half-Yearly'],
  ['yearly', 'Yearly'],
  ['custom', 'Custom…'],
];
const MONTH_CYCLE = { monthly: 1, quarterly: 3, half: 6 };

export const DEFAULT_RULE = { interval: 1, unit: 'day', weekdays: [], end: { type: 'never' } };

const ordinal = (n) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${s}`;
};

/** Which named frequency a stored rule is. The server's rule (recurrence.js) is the only place dates are
 *  worked out — this just recognises the shape so the right fields show. */
function presetOf(rule) {
  const interval = rule.interval || 1;
  const days = [...(rule.weekdays || [])].sort((a, b) => a - b).join(',');
  if (rule.unit === 'day' && interval === 1) return 'daily';
  if (rule.unit === 'week' && interval === 1 && days === BUSINESS_DAYS.join(',')) return 'business';
  if (rule.unit === 'week' && interval === 1 && (rule.weekdays || []).length === 1) return 'weekly';
  if (rule.unit === 'month' && (rule.day_of_month || rule.last_day)) {
    if (rule.month) return interval === 12 ? 'yearly' : 'custom';
    return { 1: 'monthly', 3: 'quarterly', 6: 'half' }[interval] || 'custom';
  }
  return 'custom';
}

/** A fresh rule for a newly picked frequency. Day and month default to the start date's, so "Monthly"
 *  picked for a task starting on the 15th means the 15th unless changed. */
function ruleForPreset(preset, rule, startDate) {
  const end = rule.end || { type: 'never' };
  const [, startMonth, startDay] = (startDate || '').split('-').map(Number);
  const day = startDay || 1;
  if (preset === 'daily') return { interval: 1, unit: 'day', weekdays: [], end };
  if (preset === 'weekly') return { interval: 1, unit: 'week', weekdays: [1], end };
  if (preset === 'business') return { interval: 1, unit: 'week', weekdays: BUSINESS_DAYS, end };
  if (MONTH_CYCLE[preset]) return { interval: MONTH_CYCLE[preset], unit: 'month', day_of_month: day, end };
  if (preset === 'yearly') {
    const month = startMonth || 1;
    return { interval: 12, unit: 'month', month, day_of_month: Math.min(day, MONTH_MAX_DAYS[month - 1]), end };
  }
  return { ...rule, end }; // custom: keep whatever is there and show the full controls
}

/** "On day" for the monthly-style frequencies: a specific day, or the last day of the month. */
function DaySelect({ rule, maxDay, onChange }) {
  return (
    <Select
      value={rule.last_day ? 'last' : String(rule.day_of_month || 1)}
      onChange={(e) => onChange(e.target.value === 'last' ? { last_day: true, day_of_month: undefined } : { day_of_month: Number(e.target.value), last_day: undefined })}
      className="w-40"
    >
      {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{ordinal(d)}</option>)}
      <option value="last">Last day of the month</option>
    </Select>
  );
}

/** A Teams/Outlook-style recurrence builder: pick a frequency (Daily … Yearly), then only the fields that
 *  frequency needs, plus an end condition. "Custom…" keeps the free-form "every N days/weeks/months"
 *  controls. Fully controlled — `startDate` only seeds sensible defaults for the day and month. */
export default function RecurrencePicker({ value, onChange, startDate }) {
  const rule = value || DEFAULT_RULE;
  const end = rule.end || { type: 'never' };
  // Custom is remembered once picked — otherwise a custom rule that happens to match a named one (every 1
  // day) would snap straight back to it before the user could change anything.
  const [customMode, setCustomMode] = useState(() => presetOf(rule) === 'custom');
  const preset = customMode ? 'custom' : presetOf(rule);
  const endGroup = useId(); // unique radio-group name, in case two pickers are ever on screen at once

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
  const monthIndex = (rule.month || 1) - 1;
  const shortMonthHint = !rule.last_day && rule.day_of_month >= 29 && (
    preset === 'yearly'
      ? (rule.month === 2 && rule.day_of_month === 29 ? 'In years without a 29 February it falls on 28 February.' : null)
      : `Months without a ${ordinal(rule.day_of_month)} use their last day instead (e.g. 30 April, 28 February).`
  );

  return (
    <div className="space-y-3 bg-grey-50 rounded-xl p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-grey-700 shrink-0">Repeats</span>
        <Select value={preset} onChange={(e) => {
          const next = e.target.value;
          setCustomMode(next === 'custom');
          if (next !== 'custom') onChange(ruleForPreset(next, rule, startDate));
        }} className="w-56">
          {PRESETS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </Select>
      </div>

      {preset === 'weekly' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-grey-600 shrink-0">Every</span>
          <Select value={String(rule.weekdays[0])} onChange={(e) => update({ weekdays: [Number(e.target.value)] })} className="w-40">
            {WEEKDAY_NAMES.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
          </Select>
        </div>
      )}

      {preset === 'business' && (
        <p className="text-xs text-grey-500">Every Monday to Friday — never on a Saturday or Sunday.</p>
      )}

      {MONTH_CYCLE[preset] && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-grey-600 shrink-0">On the</span>
          <DaySelect rule={rule} maxDay={31} onChange={update} />
          {preset !== 'monthly' && (
            <span className="text-xs text-grey-500">
              every {MONTH_CYCLE[preset]} months, starting from the first one on or after the start date
            </span>
          )}
        </div>
      )}

      {preset === 'yearly' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-grey-600 shrink-0">Every year on</span>
          <Select
            value={String(rule.month || 1)}
            onChange={(e) => {
              const month = Number(e.target.value);
              update({ month, ...(rule.day_of_month ? { day_of_month: Math.min(rule.day_of_month, MONTH_MAX_DAYS[month - 1]) } : {}) });
            }}
            className="w-40"
          >
            {MONTH_NAMES.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
          </Select>
          <DaySelect rule={rule} maxDay={MONTH_MAX_DAYS[monthIndex]} onChange={update} />
        </div>
      )}

      {shortMonthHint && <p className="text-xs text-grey-400">{shortMonthHint}</p>}

      {preset === 'custom' && (
        <>
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
            <Select
              value={rule.unit}
              // A day of month / month only make sense for a monthly rule — drop them when the unit changes.
              onChange={(e) => update({ unit: e.target.value, weekdays: e.target.value === 'week' ? rule.weekdays : [], day_of_month: undefined, last_day: undefined, month: undefined })}
              className="w-32"
            >
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
        </>
      )}

      <div>
        <span className="block text-xs font-medium text-grey-500 mb-1.5">Ends</span>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-grey-700 cursor-pointer">
            <input type="radio" name={endGroup} checked={end.type === 'never'} onChange={() => updateEnd({ type: 'never' })} className="accent-[#16469D]" />
            Never
          </label>
          <label className="flex items-center gap-2 text-sm text-grey-700 cursor-pointer flex-wrap">
            <input type="radio" name={endGroup} checked={end.type === 'on_date'} onChange={() => updateEnd({ type: 'on_date' })} className="accent-[#16469D]" />
            On date
            {end.type === 'on_date' && (
              <Input type="date" value={end.date || ''} onChange={(e) => updateEnd({ type: 'on_date', date: e.target.value })} className="w-auto" />
            )}
          </label>
          <label className="flex items-center gap-2 text-sm text-grey-700 cursor-pointer flex-wrap">
            <input type="radio" name={endGroup} checked={end.type === 'after_count'} onChange={() => updateEnd({ type: 'after_count', count: end.count || 10 })} className="accent-[#16469D]" />
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
