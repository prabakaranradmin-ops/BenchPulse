import { useEffect, useState, type FormEvent } from 'react';
import type { AdminApi, AdminTrailRow } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { navigate } from '../lib/router';
import { errorMessage, useToast } from './ui';

export function TrailsPage({ api }: { api: AdminApi }) {
  const notify = useToast();
  const [trails, setTrails] = useState<AdminTrailRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listTrails().then(
      (rows) => {
        if (cancelled) return;
        setTrails(rows);
        setError(null);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      const trail = await api.createTrail(name.trim());
      notify(`Created “${trail.name}”. Place its pins on the map, then publish.`);
      navigate({ name: 'trail', trailId: trail.trailId, pinIndex: null });
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Trails</h1>
          <p>Every trail, newest first. Players join one with its code, link or QR.</p>
        </div>
        <form className="row" onSubmit={create}>
          <input
            aria-label="New trail name"
            placeholder="New trail name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            style={{ width: 240 }}
            maxLength={200}
          />
          <button className="primary" type="submit" disabled={creating || !name.trim()}>
            New trail
          </button>
        </form>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="card">
        {trails === null && !error && <div className="empty">Loading trails…</div>}
        {trails?.length === 0 && (
          <div className="empty">
            No trails yet. Name your first one above to start placing pins.
          </div>
        )}
        {trails && trails.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Trail</th>
                <th>Join code</th>
                <th>Status</th>
                <th className="num">Pins</th>
                <th className="num">Open reports</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {trails.map((trail) => (
                <tr
                  key={trail.trailId}
                  className="clickable"
                  onClick={() =>
                    navigate({ name: 'trail', trailId: trail.trailId, pinIndex: null })
                  }
                >
                  <td>
                    <strong>{trail.name}</strong>
                  </td>
                  <td>
                    <span className="code-chip">{trail.joinCode}</span>
                  </td>
                  <td>
                    {trail.versionNumber === null ? (
                      <span className="badge">Draft — not published</span>
                    ) : (
                      <span className="badge accent">Version {trail.versionNumber}</span>
                    )}
                    {trail.expiryDays !== null && (
                      <span className="badge" style={{ marginLeft: 6 }}>
                        {trail.expiryDays}-day window
                      </span>
                    )}
                  </td>
                  <td className="num">{trail.pinCount}</td>
                  <td className="num">
                    {trail.openReports > 0 ? (
                      <span className="badge warning">{trail.openReports}</span>
                    ) : (
                      '0'
                    )}
                  </td>
                  <td className="muted">{formatDateTime(trail.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
