// Control-room "schedule an agent" sheet (#232). Opened from the clock pill in
// the control-room header. Collects day(s)-of-week + hour in the device's LOCAL
// time, converts to the UTC cron the daemon stores (freezing the offset — DST
// option A), and sends the `schedule add …` control-room command. Listing and
// managing existing schedules stays on the `schedules` chat command for now.
//
// Uses the app's modal-frame / modal-shell chrome (solid --surface-strong) so it
// matches the room-settings modal instead of rendering as a transparent card.
import { useMemo, useState, type FC } from 'react';
import {
  localToUtcCron,
  utcCronToHourToken,
  utcCronToDaysToken,
  formatLocal,
  DOW_SHORT,
} from '../lib/schedule-time';

type Props = {
  open: boolean;
  onClose: () => void;
  onSend: (command: string) => void;
};

// Display order is Mon-first; values stay 0-6 (0 = Sun) to match Date#getDay().
const CHIP_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const SchedulePanel: FC<Props> = ({ open, onClose, onSend }) => {
  const [days, setDays] = useState<number[]>([]);
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [agent, setAgent] = useState('claude');
  const [prompt, setPrompt] = useState('');

  const cron = useMemo(() => (days.length ? localToUtcCron(days, hour, minute) : null), [days, hour, minute]);
  const localPreview = days.length ? formatLocal(days, hour, minute) : null;
  const canSave = !!cron && agent.trim() !== '' && prompt.trim() !== '';

  if (!open) return null;

  const toggleDay = (d: number) =>
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));

  const submit = () => {
    if (!cron) return;
    const daysTok = utcCronToDaysToken(cron);
    const timeTok = utcCronToHourToken(cron);
    if (!daysTok || !timeTok) return;
    // The daemon parses: schedule add <days> <timeUTC> <agent> <prompt>
    onSend(`schedule add ${daysTok} ${timeTok} ${agent.trim()} ${prompt.trim()}`);
    setPrompt('');
    setDays([]);
    onClose();
  };

  return (
    <div
      className="modal-frame"
      role="dialog"
      aria-modal="true"
      aria-label="schedule an agent"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-shell flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-[28px]">
        <div className="flex shrink-0 items-center justify-between border-b border-rule px-5 py-4">
          <h2 className="text-base font-semibold text-ink">Schedule an agent</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="pill-control inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-dim"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <span className="mb-1 block text-xs font-medium text-ink-dim">Days</span>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {CHIP_ORDER.map((d) => {
              const on = days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDay(d)}
                  aria-pressed={on}
                  aria-label={DOW_SHORT[d]}
                  className={`h-9 w-11 rounded-full text-xs font-medium ${on ? 'bg-ink text-on-ink' : 'pill-control text-ink'}`}
                >
                  {DOW_SHORT[d]}
                </button>
              );
            })}
          </div>

          <span className="mb-1 block text-xs font-medium text-ink-dim">Time (your local time)</span>
          <div className="mb-4 flex items-center gap-2">
            <select
              id="sched-hour"
              aria-label="hour"
              value={hour}
              onChange={(e) => setHour(Number(e.target.value))}
              className="flex-1 rounded-lg border border-rule bg-surface px-3 py-2 text-sm text-ink"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}
                </option>
              ))}
            </select>
            <span className="text-ink-dim" aria-hidden="true">:</span>
            <select
              id="sched-minute"
              aria-label="minute"
              value={minute}
              onChange={(e) => setMinute(Number(e.target.value))}
              className="flex-1 rounded-lg border border-rule bg-surface px-3 py-2 text-sm text-ink"
            >
              {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                <option key={m} value={m}>
                  {String(m).padStart(2, '0')}
                </option>
              ))}
            </select>
          </div>

          <label className="mb-1 block text-xs font-medium text-ink-dim" htmlFor="sched-agent">
            Agent
          </label>
          <input
            id="sched-agent"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="mb-4 w-full rounded-lg border border-rule bg-surface px-3 py-2 text-sm text-ink"
          />

          <label className="mb-1 block text-xs font-medium text-ink-dim" htmlFor="sched-prompt">
            Prompt
          </label>
          <textarea
            id="sched-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="Summarize overnight GitHub notifications; end with a one-line summary."
            className="mb-3 w-full rounded-lg border border-rule bg-surface px-3 py-2 text-sm text-ink"
          />

          <div className="text-xs text-ink-dim" aria-live="polite">
            {localPreview ? (
              <>
                Fires <span className="font-medium text-ink">{localPreview}</span> your time → <code>{cron}</code> UTC
              </>
            ) : (
              'Pick at least one day.'
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-rule px-5 py-4">
          <button
            type="button"
            disabled={!canSave}
            onClick={submit}
            className={`w-full rounded-lg py-2.5 text-sm font-semibold ${canSave ? 'bg-ink text-on-ink' : 'pill-control text-ink-dim'}`}
          >
            Add schedule
          </button>
          <p className="mt-3 text-center text-[0.6875rem] text-ink-dim">
            Type <code>schedules</code> in chat to list or manage existing ones.
          </p>
        </div>
      </div>
    </div>
  );
};
