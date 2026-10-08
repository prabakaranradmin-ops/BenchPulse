// Place search for the map's "Go to" box: OpenStreetMap's Nominatim, the same data as the base
// map. Its usage policy allows an interactive search like this one (one request per submit, no
// search-as-you-type) and asks browser apps to identify themselves by Referer, which the admin
// page's Referrer-Policy sends as the origin only.

export interface Place {
  lat: number;
  lng: number;
  label: string;
}

export const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

/** The best match for a free-text place name, or null if there is none. */
export async function searchPlace(
  query: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<Place | null> {
  const params = new URLSearchParams({ q: query.trim(), format: 'jsonv2', limit: '1' });
  const response = await fetchImpl(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Place search failed (${response.status}).`);
  }
  const results = (await response.json()) as unknown;
  if (!Array.isArray(results) || results.length === 0) return null;

  const first = results[0] as { lat?: unknown; lon?: unknown; display_name?: unknown };
  const lat = Number(first.lat);
  const lng = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    label: typeof first.display_name === 'string' ? first.display_name : query.trim(),
  };
}
