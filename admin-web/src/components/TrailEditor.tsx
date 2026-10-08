import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  type AdminApi,
  type AdminConfig,
  type AdminTrailDetail,
  type AdminTrailRow,
  type ChallengeType,
  type ValidationIssue,
} from '../lib/api';
import {
  addPin,
  clearDraft,
  draftSignature,
  fromAdminPins,
  hasChanges,
  keyValidation,
  loadDraft,
  movePin,
  removePin,
  reorderPin,
  saveDraft,
  severityOf,
  toPublishPins,
  updatePin,
  type DraftPin,
  type IssueSet,
  type KeyedValidation,
} from '../lib/draft';
import { formatCoordinate, formatDateTime, parseCoordinate } from '../lib/format';
import { searchPlace } from '../lib/geocode';
import { routeHref } from '../lib/router';
import { JoinCodePanel } from './JoinCodePanel';
import { MapView, type MapMode, type PinSeverity } from './MapView';
import { Modal, errorMessage, useToast } from './ui';

/** The publish endpoint's limit. */
const MAX_PINS = 200;
/** Long enough to coalesce typing and drag-adjusting; the landcover lookup is the slow part. */
const VALIDATE_DEBOUNCE_MS = 700;

type CheckState = 'empty' | 'checking' | 'failed' | 'checked';
type FlyTarget = { lat: number; lng: number; at: number };

/**
 * GDR-05's authoring flow on one screen: place pins in order on the 3D map, set each challenge,
 * see SR-ADMIN-01/02 checks as you go, publish. Edits are a local draft until published (GDR-07
 * versions are immutable), and the draft survives navigating away within this tab.
 */
export function TrailEditor({
  api,
  trailId,
  focusPin,
  config,
}: {
  api: AdminApi;
  trailId: string;
  /** 1-based pin to select on arrival, e.g. from a report's "show on map". */
  focusPin: number | null;
  config: AdminConfig;
}) {
  const notify = useToast();
  const [detail, setDetail] = useState<AdminTrailDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [published, setPublished] = useState<DraftPin[]>([]);
  const [pins, setPins] = useState<DraftPin[]>([]);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mode, setMode] = useState<MapMode>('select');
  const [fitRequest, setFitRequest] = useState(0);
  const [flyTo, setFlyTo] = useState<FlyTarget | null>(null);
  const [gotoText, setGotoText] = useState('');
  const [searching, setSearching] = useState(false);
  const [validation, setValidation] = useState<KeyedValidation | null>(null);
  const [checkFailure, setCheckFailure] = useState<{ signature: string; message: string } | null>(
    null,
  );
  const [retryCount, setRetryCount] = useState(0);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [focusApplied, setFocusApplied] = useState<number | null>(null);
  const checkSequence = useRef(0);
  const loaded = detail !== null;

  useEffect(() => {
    let cancelled = false;
    api.getTrail(trailId).then(
      (trail) => {
        if (cancelled) return;
        const publishedPins = fromAdminPins(trail.pins);
        const stored = loadDraft(sessionStorage, trailId, trail.currentVersionId);
        const restore = stored !== null && hasChanges(publishedPins, stored);
        setDetail(trail);
        setPublished(publishedPins);
        setPins(restore ? stored : publishedPins);
        setRestoredDraft(restore);
        setLoadError(null);
      },
      (err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, trailId, reloadCount]);

  const dirty = useMemo(() => loaded && hasChanges(published, pins), [loaded, published, pins]);
  const signature = useMemo(() => draftSignature(pins), [pins]);

  // Keep the draft in this tab's storage so a reload or a trip to the Reports page loses nothing.
  useEffect(() => {
    if (!detail) return;
    if (dirty) saveDraft(sessionStorage, trailId, detail.currentVersionId, pins);
    else clearDraft(sessionStorage, trailId);
  }, [detail, dirty, pins, trailId]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // SR-ADMIN-01/02 as the Admin works, not just at publish. Only the newest request may land.
  useEffect(() => {
    if (!loaded || pins.length === 0) return;
    const sequence = ++checkSequence.current;
    const timer = window.setTimeout(() => {
      api.validate(toPublishPins(pins)).then(
        (result) => {
          if (sequence === checkSequence.current) setValidation(keyValidation(pins, result));
        },
        (err: unknown) => {
          if (sequence === checkSequence.current) {
            setCheckFailure({ signature: draftSignature(pins), message: errorMessage(err) });
          }
        },
      );
    }, VALIDATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [api, loaded, pins, retryCount]);

  useEffect(() => {
    if (mode === 'select') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMode('select');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  // A deep link to a pin selects it once the trail is loaded (and again if the link changes).
  if (loaded && focusPin !== focusApplied) {
    setFocusApplied(focusPin);
    const pin = focusPin === null ? undefined : pins[focusPin - 1];
    if (pin) {
      setSelectedKey(pin.key);
      setFlyTo((previous) => ({ lat: pin.lat, lng: pin.lng, at: (previous?.at ?? 0) + 1 }));
    }
  }

  const severities = useMemo(
    () =>
      new Map<string, PinSeverity>(pins.map((pin) => [pin.key, severityOf(validation, pin.key)])),
    [pins, validation],
  );

  if (loadError) {
    return (
      <div className="page">
        <div className="notice error">{loadError}</div>
        <a href={routeHref({ name: 'trails' })}>← Back to all trails</a>
      </div>
    );
  }
  if (!detail) {
    return <div className="empty">Loading trail…</div>;
  }

  const checkState: CheckState =
    pins.length === 0
      ? 'empty'
      : validation?.signature === signature
        ? 'checked'
        : checkFailure?.signature === signature
          ? 'failed'
          : 'checking';
  const checked = checkState === 'checked' ? validation : null;
  const canPublish = dirty && checked !== null && checked.errorCount === 0 && !publishing;
  const selectedIndex = pins.findIndex((pin) => pin.key === selectedKey);
  const selected = selectedIndex >= 0 ? pins[selectedIndex] : null;
  const versions = [...detail.versions].sort((a, b) => b.versionNumber - a.versionNumber);
  const liveVersion = versions.find((version) => version.isCurrent) ?? null;
  const nextVersionNumber = (versions[0]?.versionNumber ?? 0) + 1;

  function fly(point: { lat: number; lng: number }) {
    setFlyTo((previous) => ({ lat: point.lat, lng: point.lng, at: (previous?.at ?? 0) + 1 }));
  }

  function selectPin(key: string, flyToPin: boolean) {
    setSelectedKey(key);
    const pin = pins.find((candidate) => candidate.key === key);
    if (pin && flyToPin) fly(pin);
  }

  function handleMapClick(point: { lat: number; lng: number }) {
    if (mode === 'add') {
      if (pins.length >= MAX_PINS) {
        notify(`A trail can have at most ${MAX_PINS} pins.`, 'error');
        return;
      }
      const next = addPin(pins, point);
      setPins(next);
      setSelectedKey(next[next.length - 1].key);
    } else if (mode === 'move') {
      if (selectedKey) setPins(movePin(pins, selectedKey, point));
      setMode('select');
    }
  }

  function removeSelected() {
    if (!selectedKey) return;
    setPins(removePin(pins, selectedKey));
    setSelectedKey(null);
    setMode('select');
  }

  async function goTo(event: FormEvent) {
    event.preventDefault();
    const text = gotoText.trim();
    if (!text) return;
    const point = parseCoordinate(text);
    if (point) {
      fly(point);
      return;
    }
    setSearching(true);
    try {
      const place = await searchPlace(text);
      if (place) {
        fly(place);
        notify(place.label);
      } else {
        notify(`No place called “${text}” found. Try adding the city, or enter lat, lng.`, 'error');
      }
    } catch {
      notify(
        "Place search isn't available right now. Enter lat, lng instead, like 13.0827, 80.2707.",
        'error',
      );
    } finally {
      setSearching(false);
    }
  }

  function discard() {
    setPins(published);
    setSelectedKey(null);
    setRestoredDraft(false);
    setMode('select');
    setConfirmDiscard(false);
    clearDraft(sessionStorage, trailId);
  }

  async function publish() {
    setPublishing(true);
    try {
      const result = await api.publish(trailId, toPublishPins(pins));
      clearDraft(sessionStorage, trailId);
      notify(
        `Version ${result.versionNumber} is live. Players mid-trail finish the version they started.`,
      );
      setSelectedKey(null);
      setRestoredDraft(false);
      setReloadCount((count) => count + 1);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_trail') {
        const errors = (err.body as { errors?: ValidationIssue[] } | undefined)?.errors ?? [];
        setValidation(keyValidation(pins, { errors, warnings: [] }));
      }
      notify(errorMessage(err), 'error');
    } finally {
      setPublishing(false);
      setConfirmPublish(false);
    }
  }

  const hint =
    mode === 'add'
      ? `Click the map to place pin ${pins.length + 1}. Press Esc when you're done.`
      : mode === 'move'
        ? `Click the map where pin ${selectedIndex + 1} should go. Esc cancels.`
        : pins.length === 0
          ? 'Choose “Add pins”, then click the map where pin 1 goes.'
          : 'Click a pin to edit it.';

  return (
    <div className="editor">
      <div className="map-pane">
        <MapView
          pins={pins}
          selectedKey={selectedKey}
          severities={severities}
          mode={mode}
          ionToken={config.cesiumIonToken}
          fitRequest={fitRequest}
          flyTo={flyTo}
          onMapClick={handleMapClick}
          onSelectPin={(key) => selectPin(key, false)}
        />
        <div className="map-toolbar">
          <div className="card" role="group" aria-label="Map mode">
            <button
              className="small toggle"
              aria-pressed={mode === 'select'}
              onClick={() => setMode('select')}
            >
              Select
            </button>
            <button
              className="small toggle"
              aria-pressed={mode === 'add'}
              onClick={() => setMode('add')}
            >
              Add pins
            </button>
            <button
              className="small toggle"
              aria-pressed={mode === 'move'}
              disabled={!selected}
              onClick={() => setMode('move')}
            >
              Move pin
            </button>
          </div>
          <form className="card" onSubmit={(event) => void goTo(event)}>
            <input
              aria-label="Go to a place or coordinates"
              placeholder="Go to a place, or lat, lng"
              value={gotoText}
              onChange={(event) => setGotoText(event.target.value)}
            />
            <button className="small" type="submit" disabled={searching || !gotoText.trim()}>
              {searching ? 'Finding…' : 'Go'}
            </button>
          </form>
          <div className="card">
            <button
              className="small"
              disabled={pins.length === 0}
              onClick={() => setFitRequest((count) => count + 1)}
            >
              Fit trail
            </button>
          </div>
        </div>
        <div className="map-hint">{hint}</div>
      </div>

      <aside className="side-panel" aria-label="Trail details">
        <section className="panel-section">
          <a className="back-link" href={routeHref({ name: 'trails' })}>
            ← All trails
          </a>
          <div className="row">
            <h2 style={{ flex: 1, minWidth: 0 }}>{detail.name}</h2>
            {liveVersion ? (
              <span className="badge accent">Version {liveVersion.versionNumber} live</span>
            ) : (
              <span className="badge">Not published</span>
            )}
          </div>
          <TrailSettings
            key={`${detail.name}|${detail.expiryDays}`}
            api={api}
            detail={detail}
            onSaved={(row) => setDetail({ ...detail, name: row.name, expiryDays: row.expiryDays })}
          />
        </section>

        {restoredDraft && dirty && (
          <section className="panel-section">
            <div className="notice info">
              Restored the unpublished changes you made earlier in this tab.
            </div>
          </section>
        )}

        <section className="panel-section">
          <JoinCodePanel
            api={api}
            trailId={trailId}
            joinCode={detail.joinCode}
            published={liveVersion !== null}
            onRotated={(joinCode) => setDetail({ ...detail, joinCode })}
          />
        </section>

        <section className="panel-section">
          <div className="row">
            <h3>Pins, in order</h3>
            <span className="spacer" />
            <span className="muted">{pins.length}</span>
          </div>
          {pins.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No pins yet. Choose <strong>Add pins</strong> and click the map where players should
              start.
            </p>
          ) : (
            <ol className="pin-list">
              {pins.map((pin, index) => {
                const severity = severities.get(pin.key) ?? null;
                return (
                  <li key={pin.key}>
                    <button
                      className={`pin-item ${pin.key === selectedKey ? 'selected' : ''}`}
                      aria-current={pin.key === selectedKey}
                      onClick={() => selectPin(pin.key, true)}
                    >
                      <span className={`pin-number ${severity ?? ''}`}>{index + 1}</span>
                      <span className="pin-label">
                        {challengeSummary(pin)}
                        <small>
                          {formatCoordinate(pin.lat, pin.lng)} · {pin.radiusM} m
                        </small>
                      </span>
                      {severity && (
                        <span className={`badge ${severity}`}>
                          {severity === 'error' ? 'Error' : 'Check'}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {selected && (
          <section className="panel-section">
            <PinEditor
              key={selected.key}
              pin={selected}
              index={selectedIndex}
              count={pins.length}
              issues={validation?.byKey.get(selected.key) ?? null}
              moving={mode === 'move'}
              onChange={(changes) => setPins(updatePin(pins, selected.key, changes))}
              onReorder={(direction) => setPins(reorderPin(pins, selected.key, direction))}
              onMove={() => setMode(mode === 'move' ? 'select' : 'move')}
              onRemove={removeSelected}
            />
          </section>
        )}

        {validation && (validation.errorCount > 0 || validation.warningCount > 0) && (
          <section className="panel-section">
            <h3>Checks</h3>
            <IssueList
              issues={validation.trailWide}
              byKey={validation.byKey}
              pins={pins}
              onSelect={(key) => selectPin(key, true)}
            />
          </section>
        )}

        <section className="panel-section">
          <h3>Published versions</h3>
          {versions.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nothing published yet. Players can't join until the first version is published.
            </p>
          ) : (
            <ul className="version-list">
              {versions.map((version) => (
                <li key={version.trailVersionId}>
                  <span>
                    <strong>Version {version.versionNumber}</strong>{' '}
                    {version.isCurrent && <span className="badge accent">Live</span>}
                  </span>
                  <span className="muted">
                    {version.pinCount} pins · {formatDateTime(version.publishedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer className="panel-footer">
          <CheckStatus
            state={checkState}
            dirty={dirty}
            validation={checked}
            failure={checkFailure?.message ?? null}
            liveVersion={liveVersion?.versionNumber ?? null}
            onRetry={() => setRetryCount((count) => count + 1)}
          />
          <div className="row">
            {dirty && <button onClick={() => setConfirmDiscard(true)}>Discard changes</button>}
            <span className="spacer" />
            <button
              className="primary"
              disabled={!canPublish}
              onClick={() => setConfirmPublish(true)}
            >
              Publish version {nextVersionNumber}
            </button>
          </div>
        </footer>
      </aside>

      {confirmPublish && checked && (
        <Modal
          title={`Publish version ${nextVersionNumber}?`}
          onClose={() => setConfirmPublish(false)}
        >
          <p style={{ margin: 0 }}>
            {pins.length} {pins.length === 1 ? 'pin' : 'pins'}. New attempts start on this version
            straight away; players already on the trail finish the version they started.
          </p>
          {checked.warningCount > 0 && (
            <div className="notice warning">
              <div>
                <strong>
                  {checked.warningCount} {checked.warningCount === 1 ? 'warning' : 'warnings'} — you
                  can still publish.
                </strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {allIssues(checked, 'warnings').map((issue, index) => (
                    <li key={index}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {!liveVersion && (
            <p className="muted" style={{ margin: 0 }}>
              Once published, players join with code{' '}
              <strong className="code-chip">{detail.joinCode}</strong>.
            </p>
          )}
          <div className="modal-actions">
            <button onClick={() => setConfirmPublish(false)}>Keep editing</button>
            <button className="primary" disabled={publishing} onClick={() => void publish()}>
              {publishing ? 'Publishing…' : `Publish version ${nextVersionNumber}`}
            </button>
          </div>
        </Modal>
      )}

      {confirmDiscard && (
        <Modal title="Discard unpublished changes?" onClose={() => setConfirmDiscard(false)}>
          <p style={{ margin: 0 }}>
            {liveVersion
              ? `The pins go back to version ${liveVersion.versionNumber}, as players see them now.`
              : 'Every pin you have placed is removed.'}
          </p>
          <div className="modal-actions">
            <button onClick={() => setConfirmDiscard(false)}>Keep changes</button>
            <button className="primary" onClick={discard}>
              Discard changes
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function challengeSummary(pin: DraftPin): string {
  switch (pin.challengeType) {
    case 'proximity_dwell':
      return `Stay ${pin.dwellSeconds}s`;
    case 'code_entry':
      return pin.code.trim() ? 'Enter a code' : 'Enter a code (not set)';
    case 'photo_confirmation':
      return 'Photo (not available)';
  }
}

function allIssues(validation: KeyedValidation, kind: keyof IssueSet): ValidationIssue[] {
  return [
    ...validation.trailWide[kind],
    ...[...validation.byKey.values()].flatMap((set) => set[kind]),
  ];
}

function TrailSettings({
  api,
  detail,
  onSaved,
}: {
  api: AdminApi;
  detail: AdminTrailDetail;
  onSaved: (row: AdminTrailRow) => void;
}) {
  const notify = useToast();
  const [name, setName] = useState(detail.name);
  const [expiry, setExpiry] = useState(detail.expiryDays === null ? '' : String(detail.expiryDays));
  const [saving, setSaving] = useState(false);

  const expiryDays = expiry.trim() === '' ? null : Number(expiry);
  const expiryValid = expiryDays === null || (Number.isInteger(expiryDays) && expiryDays >= 1);
  const changed = name.trim() !== detail.name || expiryDays !== detail.expiryDays;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!changed || !expiryValid || !name.trim()) return;
    setSaving(true);
    try {
      const changes: { name?: string; expiryDays?: number | null } = {};
      if (name.trim() !== detail.name) changes.name = name.trim();
      if (expiryDays !== detail.expiryDays) changes.expiryDays = expiryDays;
      onSaved(await api.updateTrail(detail.trailId, changes));
      notify('Trail settings saved.');
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="settings">
      <summary>Trail settings</summary>
      <form className="stack" onSubmit={save}>
        <label className="field">
          Name
          <input
            value={name}
            maxLength={200}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          Days to finish
          <input
            type="number"
            min={1}
            step={1}
            placeholder="No time limit"
            value={expiry}
            aria-invalid={!expiryValid}
            onChange={(event) => setExpiry(event.target.value)}
          />
          <small>
            Counted from when each player starts; leave empty for no limit. A change applies to
            players already on the trail too. An expired attempt can be started again.
          </small>
        </label>
        <div className="row">
          <span className="spacer" />
          <button
            type="button"
            className="small"
            disabled={!changed}
            onClick={() => {
              setName(detail.name);
              setExpiry(detail.expiryDays === null ? '' : String(detail.expiryDays));
            }}
          >
            Reset
          </button>
          <button
            type="submit"
            className="small primary"
            disabled={!changed || !expiryValid || !name.trim() || saving}
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </details>
  );
}

function PinEditor({
  pin,
  index,
  count,
  issues,
  moving,
  onChange,
  onReorder,
  onMove,
  onRemove,
}: {
  pin: DraftPin;
  index: number;
  count: number;
  issues: IssueSet | null;
  moving: boolean;
  onChange: (changes: Partial<Omit<DraftPin, 'key'>>) => void;
  onReorder: (direction: -1 | 1) => void;
  onMove: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="stack">
      <div className="row">
        <h3 style={{ flex: 1 }}>Pin {index + 1}</h3>
        <button
          className="small"
          disabled={index === 0}
          onClick={() => onReorder(-1)}
          title="Move earlier in the trail"
        >
          ↑ Earlier
        </button>
        <button
          className="small"
          disabled={index === count - 1}
          onClick={() => onReorder(1)}
          title="Move later in the trail"
        >
          ↓ Later
        </button>
      </div>

      {issues && (issues.errors.length > 0 || issues.warnings.length > 0) && (
        <ul className="issue-list">
          {issues.errors.map((issue, i) => (
            <li key={`e${i}`} className="notice error">
              {issue.message}
            </li>
          ))}
          {issues.warnings.map((issue, i) => (
            <li key={`w${i}`} className="notice warning">
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <label className="field">
        Challenge
        <select
          value={pin.challengeType}
          onChange={(event) => onChange({ challengeType: event.target.value as ChallengeType })}
        >
          <option value="proximity_dwell">Stay nearby for a while</option>
          <option value="code_entry">Enter a code found on site</option>
          <option value="photo_confirmation" disabled>
            Take a photo — not available yet
          </option>
        </select>
      </label>

      <div className="field-row">
        <NumberField
          label="Radius (m)"
          value={pin.radiusM}
          min={1}
          max={500}
          integer={false}
          help="How close counts as arrived."
          onChange={(radiusM) => onChange({ radiusM })}
        />
        {pin.challengeType === 'proximity_dwell' && (
          <NumberField
            label="Stay for (s)"
            value={pin.dwellSeconds}
            min={1}
            max={3600}
            integer
            help="Time inside the radius."
            onChange={(dwellSeconds) => onChange({ dwellSeconds })}
          />
        )}
      </div>

      {pin.challengeType === 'code_entry' && (
        <label className="field">
          Code
          <input
            value={pin.code}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. SWAN42"
            onChange={(event) => onChange({ code: event.target.value })}
          />
          <small>
            Checked on the server only; players never receive it. Case, spaces and dashes don't
            matter.
          </small>
        </label>
      )}

      <label className="field">
        Hint (optional)
        <textarea
          rows={2}
          maxLength={280}
          value={pin.hint}
          placeholder="Shown to the player at this pin"
          onChange={(event) => onChange({ hint: event.target.value })}
        />
      </label>

      <div className="row">
        <span className="muted mono" style={{ flex: 1 }}>
          {formatCoordinate(pin.lat, pin.lng)}
        </span>
        <button className="small toggle" aria-pressed={moving} onClick={onMove}>
          {moving ? 'Cancel move' : 'Move on map'}
        </button>
        <button className="small danger" onClick={onRemove}>
          Delete
        </button>
      </div>
    </div>
  );
}

/** A number input that lets the Admin clear and retype without the value snapping back. */
function NumberField({
  label,
  value,
  min,
  max,
  integer,
  help,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  integer: boolean;
  help: string;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const parsed = Number(text);
  const valid =
    text.trim() !== '' &&
    Number.isFinite(parsed) &&
    parsed >= min &&
    parsed <= max &&
    (!integer || Number.isInteger(parsed));

  return (
    <label className="field">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={integer ? 1 : 'any'}
        value={text}
        aria-invalid={!valid}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const number = Number(next);
          if (next.trim() !== '' && Number.isFinite(number) && number >= min && number <= max) {
            if (!integer || Number.isInteger(number)) onChange(number);
          }
        }}
      />
      <small>
        {valid ? help : `Between ${min} and ${max}${integer ? ', whole numbers' : ''}.`}
      </small>
    </label>
  );
}

function IssueList({
  issues,
  byKey,
  pins,
  onSelect,
}: {
  issues: IssueSet;
  byKey: Map<string, IssueSet>;
  pins: DraftPin[];
  onSelect: (key: string) => void;
}) {
  const perPin = pins.flatMap((pin, index) => {
    const set = byKey.get(pin.key);
    if (!set) return [];
    return [
      ...set.errors.map((issue) => ({ issue, kind: 'error' as const, pin, index })),
      ...set.warnings.map((issue) => ({ issue, kind: 'warning' as const, pin, index })),
    ];
  });
  const rows = [
    ...issues.errors.map((issue) => ({ issue, kind: 'error' as const, pin: null, index: -1 })),
    ...issues.warnings.map((issue) => ({ issue, kind: 'warning' as const, pin: null, index: -1 })),
    ...perPin,
  ].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'error' ? -1 : 1));

  return (
    <ul className="issue-list">
      {rows.map(({ issue, kind, pin, index }, i) => (
        <li key={i} className={`notice ${kind}`}>
          <span style={{ flex: 1 }}>{issue.message}</span>
          {pin && (
            <button className="small" onClick={() => onSelect(pin.key)}>
              Pin {index + 1}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function CheckStatus({
  state,
  dirty,
  validation,
  failure,
  liveVersion,
  onRetry,
}: {
  state: CheckState;
  dirty: boolean;
  validation: KeyedValidation | null;
  failure: string | null;
  liveVersion: number | null;
  onRetry: () => void;
}) {
  if (state === 'empty') {
    return <span className="muted">Add at least one pin to publish.</span>;
  }
  if (!dirty) {
    return (
      <span className="muted">
        No unpublished changes. Version {liveVersion} is what players see.
      </span>
    );
  }
  if (state === 'checking') {
    return <span className="muted">Checking pin placement…</span>;
  }
  if (state === 'failed') {
    return (
      <div className="notice error">
        <span style={{ flex: 1 }}>Couldn't check the trail: {failure}</span>
        <button className="small" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (validation && validation.errorCount > 0) {
    return (
      <div className="notice error">
        Fix {validation.errorCount} {validation.errorCount === 1 ? 'problem' : 'problems'} before
        publishing.
      </div>
    );
  }
  if (validation && validation.warningCount > 0) {
    return (
      <div className="notice warning">
        Ready to publish. Review {validation.warningCount}{' '}
        {validation.warningCount === 1 ? 'warning' : 'warnings'} first.
      </div>
    );
  }
  return <div className="notice info">Ready to publish. No problems found.</div>;
}
