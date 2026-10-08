import { describe, it, expect, vi } from 'vitest';
import { ApiError, createApi, type AdminPin, type KeyValueStorage } from './api';
import {
  addPin,
  clearDraft,
  draftSignature,
  draftStorageKey,
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
} from './draft';
import { formatDuration, formatRate, joinLink, parseCoordinate } from './format';
import { searchPlace } from './geocode';
import { parseRoute, routeHref } from './router';

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();
  getItem = (key: string) => this.values.get(key) ?? null;
  setItem = (key: string, value: string) => void this.values.set(key, value);
  removeItem = (key: string) => void this.values.delete(key);
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ADMIN_KEY = 'a'.repeat(64);

function apiWith(handler: (url: string, init: RequestInit) => Response) {
  const persistent = new MemoryStorage();
  const ephemeral = new MemoryStorage();
  const fetchImpl = vi.fn((url: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      handler(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, init ?? {}),
    ),
  );
  const api = createApi({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    persistent,
    ephemeral,
    now: () => 1_000_000,
  });
  return { api, persistent, ephemeral, fetchImpl };
}

function signInHandler(adminStatus = 200) {
  return (url: string): Response => {
    if (url === '/api/v1/players/token')
      return json(200, { userId: 'u1', token: 'tok-1', expiresInSeconds: 3600 });
    if (url === '/api/v1/admin/trails')
      return adminStatus === 200
        ? json(200, { trails: [] })
        : json(adminStatus, { error: 'admin_required' });
    return json(404, { error: 'route_not_found' });
  };
}

describe('admin sign-in', () => {
  it('stores the session token and never the key itself', async () => {
    const { api, persistent, ephemeral } = apiWith(signInHandler());

    await api.signIn(`  ${ADMIN_KEY}\n`, true);

    const stored = [...persistent.values.values(), ...ephemeral.values.values()].join(' ');
    expect(stored).toContain('tok-1');
    expect(stored).not.toContain(ADMIN_KEY);
    expect(api.session()).toEqual({ token: 'tok-1', expiresAt: 1_000_000 + 3_600_000 });
  });

  it('keeps the session to this tab unless asked to remember it', async () => {
    const { api, persistent, ephemeral } = apiWith(signInHandler());

    await api.signIn(ADMIN_KEY, false);

    expect(ephemeral.values.size).toBe(1);
    expect(persistent.values.size).toBe(0);
  });

  it("refuses a player's key and stores nothing", async () => {
    const { api, persistent, ephemeral } = apiWith(signInHandler(403));

    await expect(api.signIn(ADMIN_KEY, true)).rejects.toMatchObject({ code: 'admin_required' });
    expect(persistent.values.size + ephemeral.values.size).toBe(0);
  });

  it('signs out on a 401, so an expired session sends the Admin back to sign-in', async () => {
    const { api } = apiWith((url) =>
      url === '/api/v1/admin/trails/t1'
        ? json(401, { error: 'unauthorized' })
        : signInHandler()(url),
    );
    await api.signIn(ADMIN_KEY, false);
    const signedOut = vi.fn();
    api.onSignedOut(signedOut);

    await expect(api.getTrail('t1')).rejects.toBeInstanceOf(ApiError);

    expect(signedOut).toHaveBeenCalled();
    expect(api.session()).toBeNull();
  });

  it('treats an expired stored session as signed out', () => {
    const { api, persistent } = apiWith(signInHandler());
    persistent.setItem('trail-admin.session', JSON.stringify({ token: 'old', expiresAt: 999_999 }));

    expect(api.session()).toBeNull();
    expect(persistent.values.size).toBe(0);
  });

  it('reports an unreachable server in plain words', async () => {
    const api = createApi({
      fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch,
      persistent: new MemoryStorage(),
      ephemeral: new MemoryStorage(),
    });

    await expect(api.signIn(ADMIN_KEY, false)).rejects.toMatchObject({
      status: 0,
      code: 'network_unavailable',
    });
  });
});

const PUBLISHED: AdminPin[] = [
  {
    pinId: 'b',
    sequenceIndex: 2,
    lat: 13.0827,
    lng: 80.2712,
    alt: null,
    radiusM: 10,
    challengeType: 'code_entry',
    challengeConfig: { code: 'SWAN42', hint: 'Plaque' },
  },
  {
    pinId: 'a',
    sequenceIndex: 1,
    lat: 13.0827,
    lng: 80.2707,
    alt: null,
    radiusM: 12,
    challengeType: 'proximity_dwell',
    challengeConfig: { dwell_seconds: 20 },
  },
];

describe('the draft trail', () => {
  it('loads published pins in sequence order with their challenge settings', () => {
    const draft = fromAdminPins(PUBLISHED);

    expect(draft.map((pin) => pin.key)).toEqual(['a', 'b']);
    expect(draft[0]).toMatchObject({ dwellSeconds: 20, radiusM: 12 });
    expect(draft[1]).toMatchObject({ code: 'SWAN42', hint: 'Plaque' });
  });

  it('round-trips unchanged, so an untouched trail has nothing to publish', () => {
    const draft = fromAdminPins(PUBLISHED);

    expect(hasChanges(draft, fromAdminPins(PUBLISHED))).toBe(false);
    expect(hasChanges(draft, updatePin(draft, 'a', { hint: 'By the fountain' }))).toBe(true);
  });

  it('numbers pins by position, so reordering can never leave a gap (GDR-01)', () => {
    let draft = fromAdminPins(PUBLISHED);
    draft = addPin(draft, { lat: 13.083, lng: 80.272 });

    draft = reorderPin(draft, draft[2].key, -1);
    draft = removePin(draft, 'a');

    expect(toPublishPins(draft).map((pin) => pin.sequenceIndex)).toEqual([1, 2]);
  });

  it('refuses to move the first pin earlier or the last pin later', () => {
    const draft = fromAdminPins(PUBLISHED);

    expect(reorderPin(draft, 'a', -1)).toBe(draft);
    expect(reorderPin(draft, 'b', 1)).toBe(draft);
  });

  it('sends only the settings each challenge type uses', () => {
    let draft = fromAdminPins(PUBLISHED);
    // Switching a code pin to a dwell pin must not leak the old answer into the payload.
    draft = updatePin(draft, 'b', { challengeType: 'proximity_dwell' });

    const payload = toPublishPins(draft);

    expect(payload[0].challengeConfig).toEqual({ dwell_seconds: 20 });
    expect(payload[1].challengeConfig).toEqual({ dwell_seconds: 15, hint: 'Plaque' });
  });

  it("omits a code pin's empty answer rather than sending a blank one", () => {
    const draft = updatePin(fromAdminPins(PUBLISHED), 'b', { code: '   ' });

    expect(toPublishPins(draft)[1].challengeConfig).toEqual({ hint: 'Plaque' });
  });

  it('gives a new pin its predecessor’s radius and a sensible default challenge', () => {
    const draft = addPin(fromAdminPins(PUBLISHED), { lat: 1, lng: 2 });

    expect(draft[2]).toMatchObject({
      lat: 1,
      lng: 2,
      radiusM: 10,
      challengeType: 'proximity_dwell',
      dwellSeconds: 15,
    });
  });

  it('moves a pin without touching its settings', () => {
    const draft = movePin(fromAdminPins(PUBLISHED), 'a', { lat: 5, lng: 6 });

    expect(draft[0]).toMatchObject({ lat: 5, lng: 6, dwellSeconds: 20 });
  });

  it('attaches validation issues to the pin they name, and the rest to the trail', () => {
    const draft = fromAdminPins(PUBLISHED);
    const validation = keyValidation(draft, {
      errors: [{ code: 'too_many_pins', message: 'x' }],
      warnings: [{ code: 'pin_in_water', message: 'y', sequenceIndex: 2 }],
    });

    expect(severityOf(validation, 'b')).toBe('warning');
    expect(severityOf(validation, 'a')).toBeNull();
    expect(validation.trailWide.errors.map((i) => i.code)).toEqual(['too_many_pins']);
    expect([validation.errorCount, validation.warningCount]).toEqual([1, 1]);
  });

  it('keeps an issue on its pin after a reorder, and marks the result stale', () => {
    const draft = fromAdminPins(PUBLISHED);
    const validation = keyValidation(draft, {
      errors: [{ code: 'invalid_radius', message: 'x', sequenceIndex: 1 }],
      warnings: [],
    });

    const reordered = reorderPin(draft, 'a', 1);

    expect(severityOf(validation, 'a')).toBe('error');
    expect(validation.signature).toBe(draftSignature(draft));
    expect(validation.signature).not.toBe(draftSignature(reordered));
  });

  it('treats an issue naming a pin that no longer exists as trail-wide', () => {
    const validation = keyValidation(fromAdminPins(PUBLISHED), {
      errors: [],
      warnings: [{ code: 'pins_too_close', message: 'x', sequenceIndex: 9 }],
    });

    expect(validation.trailWide.warnings).toHaveLength(1);
  });
});

describe('unpublished edits in storage', () => {
  it('restores a draft made against the current version', () => {
    const storage = new MemoryStorage();
    const draft = updatePin(fromAdminPins(PUBLISHED), 'a', { hint: 'By the fountain' });

    saveDraft(storage, 't1', 'v3', draft);

    expect(loadDraft(storage, 't1', 'v3')).toEqual(draft);
    expect(loadDraft(storage, 't2', 'v3')).toBeNull();
  });

  it('drops a draft once someone has published a newer version underneath it', () => {
    const storage = new MemoryStorage();
    saveDraft(storage, 't1', 'v3', fromAdminPins(PUBLISHED));

    expect(loadDraft(storage, 't1', 'v4')).toBeNull();
  });

  it('ignores a corrupt or tampered entry rather than loading it', () => {
    const storage = new MemoryStorage();
    storage.setItem(draftStorageKey('t1'), '{not json');
    expect(loadDraft(storage, 't1', null)).toBeNull();

    storage.setItem(
      draftStorageKey('t1'),
      JSON.stringify({ basedOnVersionId: null, pins: [{ key: 'x', lat: 'north' }] }),
    );
    expect(loadDraft(storage, 't1', null)).toBeNull();
  });

  it('forgets the draft once cleared (after a publish or a discard)', () => {
    const storage = new MemoryStorage();
    saveDraft(storage, 't1', null, fromAdminPins(PUBLISHED));

    clearDraft(storage, 't1');

    expect(loadDraft(storage, 't1', null)).toBeNull();
  });
});

describe('formatting', () => {
  it('formats durations and rates the way every screen shows them', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(510)).toBe('8m 30s');
    expect(formatDuration(4320)).toBe('1h 12m');
    expect(formatDuration(null)).toBe('—');
    expect(formatRate(0.4567)).toBe('45.7%');
    expect(formatRate(0.5)).toBe('50%');
    expect(formatRate(null)).toBe('—');
  });

  it('builds the link a QR code points at, from the page origin', () => {
    expect(joinLink('https://trails.example.com/', 'ABCD-EFGH')).toBe(
      'https://trails.example.com/join/ABCDEFGH',
    );
  });

  it('parses a pasted coordinate pair and rejects nonsense', () => {
    expect(parseCoordinate('13.0827, 80.2707')).toEqual({ lat: 13.0827, lng: 80.2707 });
    expect(parseCoordinate('-33.86 151.21')).toEqual({ lat: -33.86, lng: 151.21 });
    expect(parseCoordinate('95, 10')).toBeNull();
    expect(parseCoordinate('Chennai')).toBeNull();
  });
});

describe('place search', () => {
  const respond = (body: unknown, status = 200) =>
    vi.fn((url: RequestInfo | URL) => {
      lastUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      return Promise.resolve(json(status, body));
    }) as unknown as typeof fetch;
  let lastUrl = '';

  it('returns the best match as a point with its name', async () => {
    const place = await searchPlace(
      '  Marina Beach ',
      respond([{ lat: '13.0500', lon: '80.2824', display_name: 'Marina Beach, Chennai' }]),
    );

    expect(place).toEqual({ lat: 13.05, lng: 80.2824, label: 'Marina Beach, Chennai' });
    expect(lastUrl).toContain('q=Marina+Beach&');
    expect(lastUrl).toContain('limit=1');
  });

  it('returns null when nothing matches or the match has no usable position', async () => {
    expect(await searchPlace('Atlantis', respond([]))).toBeNull();
    expect(await searchPlace('Nowhere', respond([{ lat: 'north', lon: '1' }]))).toBeNull();
  });

  it('fails loudly on an error response, so the box can suggest coordinates instead', async () => {
    await expect(searchPlace('Chennai', respond({ error: 'busy' }, 429))).rejects.toThrow('429');
  });
});

describe('routing', () => {
  it('round-trips every route through the URL hash', () => {
    for (const route of [
      { name: 'trails' as const },
      { name: 'trail' as const, trailId: 'abc-123', pinIndex: null },
      { name: 'trail' as const, trailId: 'abc-123', pinIndex: 3 },
      { name: 'reports' as const },
      { name: 'analytics' as const, trailId: null },
      { name: 'analytics' as const, trailId: 'abc-123' },
    ]) {
      expect(parseRoute(routeHref(route))).toEqual(route);
    }
  });

  it('falls back to the trail list for anything unknown', () => {
    expect(parseRoute('')).toEqual({ name: 'trails' });
    expect(parseRoute('#/nonsense')).toEqual({ name: 'trails' });
  });
});
