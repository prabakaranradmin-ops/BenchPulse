import { describe, it, expect } from 'vitest';
import { offsetPointEast } from './geo.js';
import { haversineMeters } from './locationSanityCheck.js';

describe('offsetPointEast', () => {
  // Measuring the result with haversine is the check that matters: a wrong offset here would
  // put a field-test pin in the wrong place, and that's discovered by walking to it.
  it.each([
    { lat: 0, label: 'equator' },
    { lat: 51.5074, label: 'London' },
    { lat: 13.0827, label: 'Chennai' },
    { lat: -33.8688, label: 'Sydney' },
  ])('lands $label the requested distance away', ({ lat }) => {
    const start = { lat, lng: -0.1278 };

    for (const meters of [10, 60, 300, 2000]) {
      const moved = offsetPointEast(start.lat, start.lng, meters);
      expect(haversineMeters(start, moved)).toBeCloseTo(meters, 0);
    }
  });

  it('moves west for a negative distance and stays put for zero', () => {
    const start = { lat: 51.5074, lng: -0.1278 };

    expect(offsetPointEast(start.lat, start.lng, -100).lng).toBeLessThan(start.lng);
    expect(offsetPointEast(start.lat, start.lng, 0)).toEqual(start);
  });

  it('refuses a pole, where east has no meaning', () => {
    expect(() => offsetPointEast(90, 0, 100)).toThrow(RangeError);
  });
});
