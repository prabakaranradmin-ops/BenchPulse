// The trail the Admin is editing, before it is published. Pure functions over an array, so every
// edit is testable and undo-able, and the map and side panel always render the same state.
//
// Order in the array *is* the sequence (GDR-01): pin 1 is index 0. Sequence indexes are assigned
// at publish time, so reordering can never leave a gap or a duplicate.

import type { AdminPin, ChallengeType, PublishPin, ValidationIssue, ValidationResult } from './api';

export interface DraftPin {
  /** Stable identity while editing; published pins get server ids on publish. */
  key: string;
  lat: number;
  lng: number;
  alt: number | null;
  radiusM: number;
  challengeType: ChallengeType;
  /** proximity_dwell: how long the player must stay inside the radius. */
  dwellSeconds: number;
  /** code_entry: the answer, checked server-side only (ST-6.2) — never sent to players. */
  code: string;
  /** Shown to the player for any challenge type (CR-05). */
  hint: string;
}

export const DEFAULT_RADIUS_M = 10;
export const DEFAULT_DWELL_SECONDS = 15;

let keyCounter = 0;
function newKey(): string {
  keyCounter += 1;
  return `pin-${Date.now().toString(36)}-${keyCounter}`;
}

/** The trail's current published pins, as an editable draft. */
export function fromAdminPins(pins: AdminPin[]): DraftPin[] {
  return [...pins]
    .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
    .map((pin) => ({
      key: pin.pinId,
      lat: pin.lat,
      lng: pin.lng,
      alt: pin.alt,
      radiusM: pin.radiusM,
      challengeType: pin.challengeType,
      dwellSeconds: numberOr(pin.challengeConfig.dwell_seconds, DEFAULT_DWELL_SECONDS),
      code: stringOr(pin.challengeConfig.code, ''),
      hint: stringOr(pin.challengeConfig.hint, ''),
    }));
}

/** What the server's publish and validate endpoints take. Only the fields each type uses are sent. */
export function toPublishPins(pins: DraftPin[]): PublishPin[] {
  return pins.map((pin, index) => {
    const challengeConfig: Record<string, unknown> = {};
    if (pin.challengeType === 'proximity_dwell') {
      challengeConfig.dwell_seconds = pin.dwellSeconds;
    }
    if (pin.challengeType === 'code_entry' && pin.code.trim()) {
      challengeConfig.code = pin.code.trim();
    }
    if (pin.hint.trim()) {
      challengeConfig.hint = pin.hint.trim();
    }
    return {
      sequenceIndex: index + 1,
      lat: round7(pin.lat),
      lng: round7(pin.lng),
      alt: pin.alt,
      radiusM: pin.radiusM,
      challengeType: pin.challengeType,
      challengeConfig,
    };
  });
}

export function addPin(pins: DraftPin[], at: { lat: number; lng: number }): DraftPin[] {
  const previous = pins[pins.length - 1];
  return [
    ...pins,
    {
      key: newKey(),
      lat: at.lat,
      lng: at.lng,
      alt: null,
      // A new pin inherits its predecessor's radius: trails tend to be authored consistently.
      radiusM: previous?.radiusM ?? DEFAULT_RADIUS_M,
      challengeType: 'proximity_dwell',
      dwellSeconds: DEFAULT_DWELL_SECONDS,
      code: '',
      hint: '',
    },
  ];
}

export function updatePin(
  pins: DraftPin[],
  key: string,
  changes: Partial<Omit<DraftPin, 'key'>>,
): DraftPin[] {
  return pins.map((pin) => (pin.key === key ? { ...pin, ...changes } : pin));
}

export function movePin(
  pins: DraftPin[],
  key: string,
  to: { lat: number; lng: number },
): DraftPin[] {
  return updatePin(pins, key, { lat: to.lat, lng: to.lng });
}

export function removePin(pins: DraftPin[], key: string): DraftPin[] {
  return pins.filter((pin) => pin.key !== key);
}

/** Moves a pin one place earlier (-1) or later (+1) in the sequence. */
export function reorderPin(pins: DraftPin[], key: string, direction: -1 | 1): DraftPin[] {
  const index = pins.findIndex((pin) => pin.key === key);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= pins.length) {
    return pins;
  }
  const next = [...pins];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Whether the draft differs from what is published — i.e. whether there is anything to publish. */
export function hasChanges(published: DraftPin[], draft: DraftPin[]): boolean {
  return JSON.stringify(toPublishPins(published)) !== JSON.stringify(toPublishPins(draft));
}

/** Identifies a draft's publish payload, so a validation result can tell whether it is stale. */
export function draftSignature(pins: DraftPin[]): string {
  return JSON.stringify(toPublishPins(pins));
}

export interface IssueSet {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface KeyedValidation {
  /** The draft this result describes (see draftSignature). */
  signature: string;
  errorCount: number;
  warningCount: number;
  /** Per-pin issues, by pin key rather than position, so they stay on the right pin when the
   * Admin reorders before the next check comes back. */
  byKey: Map<string, IssueSet>;
  trailWide: IssueSet;
}

/** Attaches the server's issues (which name pins by sequence index) to the pins they were about. */
export function keyValidation(pins: DraftPin[], result: ValidationResult): KeyedValidation {
  const byKey = new Map<string, IssueSet>();
  const trailWide: IssueSet = { errors: [], warnings: [] };

  const file = (issue: ValidationIssue, kind: keyof IssueSet) => {
    const pin = issue.sequenceIndex === undefined ? undefined : pins[issue.sequenceIndex - 1];
    if (!pin) {
      trailWide[kind].push(issue);
      return;
    }
    const set = byKey.get(pin.key) ?? { errors: [], warnings: [] };
    set[kind].push(issue);
    byKey.set(pin.key, set);
  };
  result.errors.forEach((issue) => file(issue, 'errors'));
  result.warnings.forEach((issue) => file(issue, 'warnings'));

  return {
    signature: draftSignature(pins),
    errorCount: result.errors.length,
    warningCount: result.warnings.length,
    byKey,
    trailWide,
  };
}

export function severityOf(
  validation: KeyedValidation | null,
  key: string,
): 'error' | 'warning' | null {
  const set = validation?.byKey.get(key);
  if (set?.errors.length) return 'error';
  if (set?.warnings.length) return 'warning';
  return null;
}

// ---------- Unpublished edits survive navigation and reloads (this tab only) ----------

interface StoredDraft {
  /** The version the edits started from; a draft of an older version is not restored. */
  basedOnVersionId: string | null;
  pins: DraftPin[];
}

const CHALLENGE_TYPES: readonly ChallengeType[] = [
  'proximity_dwell',
  'code_entry',
  'photo_confirmation',
];

export function draftStorageKey(trailId: string): string {
  return `trail-admin.draft.${trailId}`;
}

export function saveDraft(
  storage: Pick<Storage, 'setItem'>,
  trailId: string,
  basedOnVersionId: string | null,
  pins: DraftPin[],
): void {
  const stored: StoredDraft = { basedOnVersionId, pins };
  try {
    storage.setItem(draftStorageKey(trailId), JSON.stringify(stored));
  } catch {
    // Storage full or disabled: the draft simply won't survive a reload.
  }
}

export function clearDraft(storage: Pick<Storage, 'removeItem'>, trailId: string): void {
  try {
    storage.removeItem(draftStorageKey(trailId));
  } catch {
    // Nothing to clear.
  }
}

/** The stored draft for this trail, if it was made against the version that is current now. */
export function loadDraft(
  storage: Pick<Storage, 'getItem'>,
  trailId: string,
  currentVersionId: string | null,
): DraftPin[] | null {
  let raw: string | null;
  try {
    raw = storage.getItem(draftStorageKey(trailId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredDraft>;
    if (stored.basedOnVersionId !== currentVersionId || !Array.isArray(stored.pins)) return null;
    return stored.pins.every(isDraftPin) ? stored.pins : null;
  } catch {
    return null;
  }
}

function isDraftPin(value: unknown): value is DraftPin {
  const pin = value as Partial<DraftPin> | null;
  return (
    typeof pin === 'object' &&
    pin !== null &&
    typeof pin.key === 'string' &&
    Number.isFinite(pin.lat) &&
    Number.isFinite(pin.lng) &&
    (pin.alt === null || Number.isFinite(pin.alt)) &&
    Number.isFinite(pin.radiusM) &&
    CHALLENGE_TYPES.includes(pin.challengeType as ChallengeType) &&
    Number.isFinite(pin.dwellSeconds) &&
    typeof pin.code === 'string' &&
    typeof pin.hint === 'string'
  );
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** ~1cm. More digits only add noise to the payload and the diff. */
function round7(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}
