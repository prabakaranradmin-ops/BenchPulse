// Display formatting, kept in one place so every screen says things the same way.

/** "1h 12m", "8m 30s", "45s". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** 0.4567 → "45.7%". */
export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "ABCD-EFGH" → "https://host/join/ABCDEFGH": what a QR code or shared link points at. */
export function joinLink(origin: string, joinCode: string): string {
  return `${origin.replace(/\/$/, '')}/join/${joinCode.replace(/-/g, '')}`;
}

export function formatCoordinate(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

/** Parses "13.0827, 80.2707" (or with a space only) into a point, or null. */
export function parseCoordinate(text: string): { lat: number; lng: number } | null {
  const match = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
