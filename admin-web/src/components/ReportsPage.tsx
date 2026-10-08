import { useEffect, useState } from 'react';
import type { AdminApi, ReportRow, ReportStatus } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { routeHref } from '../lib/router';
import { errorMessage, useToast } from './ui';

type Filter = ReportStatus | 'all';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
];

const STATUS_LABEL: Record<ReportStatus, string> = {
  open: 'Open',
  reviewed: 'Reviewed',
  resolved: 'Resolved',
};

/**
 * ST-7.3 — players' "I can't find this pin" reports (GDR-09). The Admin's job here is to judge a
 * place, so each report leads straight to its pin on the map; the reporter is never shown.
 */
export function ReportsPage({ api }: { api: AdminApi }) {
  const notify = useToast();
  const [filter, setFilter] = useState<Filter>('open');
  const [reports, setReports] = useState<{ filter: Filter; rows: ReportRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listReports(filter === 'all' ? undefined : filter).then(
      (rows) => {
        if (cancelled) return;
        setReports({ filter, rows });
        setError(null);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, filter]);

  async function setStatus(report: ReportRow, status: ReportStatus) {
    setBusy(report.reportId);
    try {
      await api.setReportStatus(report.reportId, status);
      setReports((current) => {
        if (!current) return current;
        const rows =
          current.filter === 'all' || current.filter === status
            ? current.rows.map((row) =>
                row.reportId === report.reportId ? { ...row, status } : row,
              )
            : current.rows.filter((row) => row.reportId !== report.reportId);
        return { ...current, rows };
      });
      notify(`Report marked ${STATUS_LABEL[status].toLowerCase()}.`);
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  const rows = reports?.filter === filter ? reports.rows : null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Pin reports</h1>
          <p>
            Players who couldn't find a pin. Check the spot on the map, then fix and republish, or
            resolve.
          </p>
        </div>
        <div className="card segmented" role="group" aria-label="Filter by status">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              className="small toggle"
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="card">
        {rows === null && !error && <div className="empty">Loading reports…</div>}
        {rows?.length === 0 && (
          <div className="empty">
            {filter === 'open'
              ? 'No open reports. Players are finding every pin.'
              : 'No reports here.'}
          </div>
        )}
        {rows && rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Reported</th>
                <th>Where</th>
                <th>Player's note</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((report) => (
                <tr key={report.reportId}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                    {formatDateTime(report.createdAt)}
                  </td>
                  <td>
                    <strong>{report.trailName ?? 'Deleted trail'}</strong>
                    <div className="muted">
                      {report.sequenceIndex !== null && `Pin ${report.sequenceIndex}`}
                      {report.versionNumber !== null && ` · version ${report.versionNumber}`}
                      {!report.isCurrentVersion && report.versionNumber !== null && (
                        <span
                          className="badge"
                          style={{ marginLeft: 6 }}
                          title="The trail has been republished since this report; the new version may already fix it."
                        >
                          Older version
                        </span>
                      )}
                    </div>
                  </td>
                  <td>{report.note ? report.note : <span className="muted">No note</span>}</td>
                  <td>
                    <span
                      className={`badge ${report.status === 'open' ? 'warning' : report.status === 'resolved' ? 'accent' : ''}`}
                    >
                      {STATUS_LABEL[report.status]}
                    </span>
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      {report.trailId &&
                        report.isCurrentVersion &&
                        report.sequenceIndex !== null && (
                          <a
                            className="button small"
                            href={routeHref({
                              name: 'trail',
                              trailId: report.trailId,
                              pinIndex: report.sequenceIndex,
                            })}
                          >
                            Show on map
                          </a>
                        )}
                      {report.status === 'open' && (
                        <button
                          className="small"
                          disabled={busy === report.reportId}
                          onClick={() => void setStatus(report, 'reviewed')}
                        >
                          Mark reviewed
                        </button>
                      )}
                      {report.status !== 'resolved' ? (
                        <button
                          className="small"
                          disabled={busy === report.reportId}
                          onClick={() => void setStatus(report, 'resolved')}
                        >
                          Resolve
                        </button>
                      ) : (
                        <button
                          className="small"
                          disabled={busy === report.reportId}
                          onClick={() => void setStatus(report, 'open')}
                        >
                          Reopen
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
