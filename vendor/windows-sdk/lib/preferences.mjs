export function cleanPreferences(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid viewer settings.');
  const string = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f]/.test(value);
  const camera = value => {
    if (value === null) return null;
    if (!value || !string(value.deviceId, 256) || !value.deviceId || !Number.isInteger(value.channel) || value.channel < 1 || value.channel > 1024 || !['hd', 'sd'].includes(value.quality)) throw new Error('Invalid saved camera.');
    return { deviceId: value.deviceId, channel: value.channel, quality: value.quality, qualityMode: ['auto', 'hd', 'sd'].includes(value.qualityMode) ? value.qualityMode : 'auto', fit: ['fit', 'fill', 'original'].includes(value.fit) ? value.fit : 'fit' };
  };
  const grid = [1, 4, 9, 16].includes(input.grid) ? input.grid : 4;
  const volume = Number.isFinite(input.volume) ? Math.max(0, Math.min(1, input.volume)) : 0.7;
  if (!Array.isArray(input.favourites || []) || (input.favourites?.length || 0) > 256 || !Array.isArray(input.layouts || []) || (input.layouts?.length || 0) > 12) throw new Error('Too many saved viewer settings.');
  const favourites = [...new Set(input.favourites || [])];
  if (favourites.some(value => !string(value, 300))) throw new Error('Invalid favourite camera.');
  const groups = Object.fromEntries(Object.entries(input.groups || {}).map(([key, value]) => {
    if (!string(key, 300) || !string(value, 50)) throw new Error('Invalid camera group.');
    return [key, value];
  }));
  if (Object.keys(groups).length > 256) throw new Error('Too many camera groups.');
  const layouts = (input.layouts || []).map(layout => {
    if (!layout || !string(layout.name, 50) || !layout.name.trim() || ![1, 4, 9, 16].includes(layout.grid) || !Array.isArray(layout.cameras) || layout.cameras.length !== layout.grid) throw new Error('Invalid saved layout.');
    return { name: layout.name.trim(), grid: layout.grid, cameras: layout.cameras.map(camera) };
  });
  return { grid, volume, favourites, groups, layouts, groupFit: ['fit', 'fill', 'original'].includes(input.groupFit) ? input.groupFit : 'fit' };
}
