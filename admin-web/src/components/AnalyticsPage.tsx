import { useEffect, useState } from 'react';
import type { AdminApi, AnalyticsRange, FunnelStep, TrailAnalytics } from '../lib/api';
import { formatDuration, formatRate } from '../lib/format';
import { navigate, routeHref } from '../lib/router';
import { errorMessage } from './ui';

type Period = 'all' | '7' | '30' | '90';

const PERIODS: { value: Period; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'all', label: 'All time' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

function rangeFor(period: Period): AnalyticsRange {
  return period === 'all' ? {} : { from: new Date(Date.now() - Number(period) * DAY_MS) };
}

type TrailDetail = TrailAnalytics & { minCohortSize: number; funnel: FunnelStep[] };

/**
 * ST-8.3 — completion analytics. Aggregates only (SR-PRIV-03): the server withholds rates and
 * timings for small cohorts, and this screen says so rather than showing zeros.
 */
export function AnalyticsPage({ api, trailId }: { api: AdminApi; trailId: string | null }) {
  const [period, setPeriod] = useState<Period>('30');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          {trailId && (
            <a className="back-link" href={routeHref({ name: 'analytics', trailId: null })}>
              ← All trails
            </a>
          )}
          <h1>Analytics</h1>
          <p>Attempts started in the period, and how they ended.</p>
        </div>
        <div className="card segmented" role="group" aria-label="Period">
          {PERIODS.map((option) => (
            <button
              key={option.value}
              className="small toggle"
              aria-pressed={period === option.value}
              onClick={() => setPeriod(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {trailId ? (
        <TrailAnalyticsView key={trailId} api={api} trailId={trailId} period={period} />
      ) : (
        <AnalyticsList api={api} period={period} />
      )}
    </div>
  );
}

function AnalyticsList({ api, period }: { api: AdminApi; period: Period }) {
  const [data, setData] = useState<{
    period: Period;
    minCohortSize: number;
    trails: TrailAnalytics[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.analytics(rangeFor(period)).then(
      (result) => {
        if (cancelled) return;
        setData({ period, ...result });
        setError(null);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, period]);

  const current = data?.period === period ? data : null;
  const anySuppressed = current?.trails.some((trail) => trail.suppressed) ?? false;

  return (
    <>
      {error && <div className="notice error">{error}</div>}
      <div className="card">
        {!current && !error && <div className="empty">Loading analytics…</div>}
        {current?.trails.length === 0 && (
          <div className="empty">No attempts started in this period.</div>
        )}
        {current && current.trails.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Trail</th>
                <th className="num">Started</th>
                <th className="num">Completed</th>
                <th className="num">Completion</th>
                <th className="num">Median time</th>
                <th className="num">In progress</th>
                <th className="num">Expired</th>
              </tr>
            </thead>
            <tbody>
              {current.trails.map((trail) => (
                <tr
                  key={trail.trailId}
                  className="clickable"
                  onClick={() => navigate({ name: 'analytics', trailId: trail.trailId })}
                >
                  <td>
                    <strong>{trail.trailName}</strong>
                  </td>
                  <td className="num">{trail.attemptsStarted}</td>
                  <td className="num">{trail.attemptsCompleted}</td>
                  <td className="num">
                    {trail.suppressed ? <Withheld /> : formatRate(trail.completionRate)}
                  </td>
                  <td className="num">
                    {trail.suppressed ? (
                      <Withheld />
                    ) : (
                      formatDuration(trail.medianCompletionSeconds)
                    )}
                  </td>
                  <td className="num">{trail.attemptsActive}</td>
                  <td className="num">{trail.attemptsExpired}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {current && anySuppressed && <SuppressionNote minCohortSize={current.minCohortSize} />}
    </>
  );
}

function TrailAnalyticsView({
  api,
  trailId,
  period,
}: {
  api: AdminApi;
  trailId: string;
  period: Period;
}) {
  const [data, setData] = useState<{ period: Period; detail: TrailDetail } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.trailAnalytics(trailId, rangeFor(period)).then(
      (detail) => {
        if (cancelled) return;
        setData({ period, detail });
        setError(null);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, trailId, period]);

  if (error) return <div className="notice error">{error}</div>;
  if (data?.period !== period) return <div className="card empty">Loading analytics…</div>;

  const detail = data.detail;
  const stats: { label: string; value: string; withheld?: boolean }[] = [
    { label: 'Attempts started', value: String(detail.attemptsStarted) },
    { label: 'Completed', value: String(detail.attemptsCompleted) },
    {
      label: 'Completion rate',
      value: formatRate(detail.completionRate),
      withheld: detail.suppressed,
    },
    {
      label: 'Median time',
      value: formatDuration(detail.medianCompletionSeconds),
      withheld: detail.suppressed,
    },
    {
      label: 'Slowest 10% take',
      value: formatDuration(detail.p90CompletionSeconds),
      withheld: detail.suppressed,
    },
    { label: 'In progress', value: String(detail.attemptsActive) },
    { label: 'Expired', value: String(detail.attemptsExpired) },
  ];
  const widest = Math.max(1, detail.attemptsStarted, ...detail.funnel.map((step) => step.reached));

  return (
    <>
      <div className="row">
        <h2 style={{ flex: 1 }}>{detail.trailName}</h2>
        <a className="button small" href={routeHref({ name: 'trail', trailId, pinIndex: null })}>
          Open in editor
        </a>
      </div>

      <div className="stat-grid">
        {stats.map((stat) => (
          <div key={stat.label} className="card stat">
            <div className="value">{stat.withheld ? <Withheld /> : stat.value}</div>
            <div className="label">{stat.label}</div>
          </div>
        ))}
      </div>

      {detail.suppressed && <SuppressionNote minCohortSize={detail.minCohortSize} />}

      <div className="card card-body stack">
        <div className="row">
          <h3 style={{ flex: 1 }}>Where players stop</h3>
          <span className="legend">
            <span className="swatch reached" /> Reached <span className="swatch completed" />{' '}
            Completed
          </span>
        </div>
        {detail.funnel.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No pins reached in this period.
          </p>
        ) : (
          <div className="funnel">
            {detail.funnel.map((step) => (
              <div key={step.sequenceIndex} className="funnel-row">
                <span className="muted">Pin {step.sequenceIndex}</span>
                <div
                  className="funnel-track"
                  role="img"
                  aria-label={`Pin ${step.sequenceIndex}: ${step.reached} reached, ${step.completed} completed`}
                >
                  <div
                    className="funnel-reached"
                    style={{ width: `${(step.reached / widest) * 100}%` }}
                  />
                  <div
                    className="funnel-completed"
                    style={{ width: `${(step.completed / widest) * 100}%` }}
                  />
                </div>
                <span className="num">
                  {step.completed}/{step.reached}
                  {step.dropOffRate !== null && step.dropOffRate > 0 && (
                    <span className="muted"> · {formatRate(step.dropOffRate)} stop</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="muted" style={{ margin: 0 }}>
          Counts are across every published version. Pin numbers are positions in the trail, so a
          reorder between versions mixes pins at the same position.
        </p>
      </div>
    </>
  );
}

function Withheld() {
  return (
    <span
      className="muted"
      title="Withheld: too few attempts to report without identifying a player."
    >
      —
    </span>
  );
}

function SuppressionNote({ minCohortSize }: { minCohortSize: number }) {
  return (
    <div className="notice info">
      Rates and times are shown once a trail has at least {minCohortSize} attempts in the period.
      With fewer, they would describe individual players.
    </div>
  );
}
