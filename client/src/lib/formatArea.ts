/**
 * Format area (in m²) for display, using m² for small areas and km² for large ones.
 * Threshold: < 0.05 km² (50,000 m²) → show in m² (avoids displaying "0.0 km²")
 */
export function formatArea(sqMeters: number): string {
  const abs = Math.abs(sqMeters);
  const km2 = abs / 1_000_000;
  const sign = sqMeters < 0 ? '-' : '';
  if (km2 >= 0.05) return `${sign}${km2.toFixed(2)} km²`;
  return `${sign}${Math.round(abs)} m²`;
}

/**
 * Format area for display when the value is already in km².
 * Threshold: < 0.05 km² → convert back to m² and show in m²
 */
export function formatAreaFromKm2(km2: number): string {
  const abs = Math.abs(km2);
  const sign = km2 < 0 ? '-' : '';
  if (abs >= 0.05) return `${sign}${abs.toFixed(2)} km²`;
  return `${sign}${Math.round(abs * 1_000_000)} m²`;
}

/**
 * Format area with split value and unit for components that need them separate.
 * Returns { value: string, unit: string }
 */
export function formatAreaParts(sqMeters: number): { value: string; unit: string } {
  const abs = Math.abs(sqMeters);
  const km2 = abs / 1_000_000;
  const sign = sqMeters < 0 ? '-' : '';
  // Show in m² if displaying in km² would round to "0,0"
  if (km2 >= 0.05) {
    return {
      value: `${sign}${km2.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`,
      unit: 'km²',
    };
  }
  return {
    value: `${sign}${Math.round(abs).toLocaleString('es-ES')}`,
    unit: 'm²',
  };
}
