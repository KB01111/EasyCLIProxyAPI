import { memo } from 'react';
import { useI18n } from '../../i18n';
import { splitDuration, unixToMs } from '../../services/codexAccounts';
import { useNowTick } from './useNowTick';

/** Compact localized duration such as "2d 3h", "1h 20m" or "<1m". */
export function useDurationText() {
  const { t } = useI18n();
  return (ms: number): string => {
    const parts = splitDuration(ms);
    if (!parts) return '';
    if (parts.days > 0) return t('codexAccounts.duration.dh', { d: parts.days, h: parts.hours });
    if (parts.hours > 0) return t('codexAccounts.duration.hm', { h: parts.hours, m: parts.minutes });
    if (parts.minutes > 0) return t('codexAccounts.duration.m', { m: parts.minutes });
    return t('codexAccounts.duration.lessThanMinute');
  };
}

/** Leaf component: only this element re-renders on the shared tick. */
export const ResetCountdown = memo(function ResetCountdown({ resetAtSec }: { resetAtSec: number | null }) {
  const { t, locale } = useI18n();
  const now = useNowTick();
  const durationText = useDurationText();
  const resetMs = unixToMs(resetAtSec);
  if (resetMs === null) return <span className="cxa-muted">{t('codexAccounts.reset.unknown')}</span>;
  const remaining = resetMs - now;
  const absolute = new Intl.DateTimeFormat(locale, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(resetMs);
  return (
    <span className="cxa-reset" title={absolute}>
      {remaining <= 0 ? t('codexAccounts.reset.passed') : t('codexAccounts.reset.in', { time: durationText(remaining) })}
    </span>
  );
});

/** "5m ago" style age; flags quota older than `staleAfterMs`. */
export const AgeLabel = memo(function AgeLabel({ atMs, staleAfterMs }: { atMs: number | null; staleAfterMs?: number }) {
  const { t } = useI18n();
  const now = useNowTick();
  const durationText = useDurationText();
  if (atMs === null) return <span className="cxa-muted">—</span>;
  const age = Math.max(0, now - atMs);
  const stale = staleAfterMs !== undefined && age > staleAfterMs;
  return (
    <span className={stale ? 'cxa-age stale' : 'cxa-age'} data-stale={stale ? 'true' : undefined}>
      {age < 60_000 ? t('codexAccounts.age.justNow') : t('codexAccounts.age.ago', { time: durationText(age) })}
      {stale ? <span className="cxa-chip warn">{t('codexAccounts.quota.stale')}</span> : null}
    </span>
  );
});
