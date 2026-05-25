const SECONDS_IN_MINUTE = 60;
const SECONDS_IN_HOUR = 3600;

export const formatTimePrecision = (seconds: number | string): string => {
  const safeSec = Number(seconds) || 0;
  if (isNaN(safeSec) || safeSec < 0) return '00:00.00';
  const m = Math.floor(safeSec / SECONDS_IN_MINUTE).toString().padStart(2, '0');
  const s = (safeSec % SECONDS_IN_MINUTE).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
};

export const formatDurationStandard = (seconds: number | string): string => {
  const safeSec = Number(seconds) || 0;
  if (isNaN(safeSec) || safeSec < 0) return '00:00:00';
  const h = Math.floor(safeSec / SECONDS_IN_HOUR);
  const m = Math.floor((safeSec % SECONDS_IN_HOUR) / SECONDS_IN_MINUTE);
  const s = Math.floor(safeSec % SECONDS_IN_MINUTE);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};