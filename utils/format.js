/**
 * Converts a millisecond duration into a human-readable string.
 * e.g. 3661000 → "1h 1m 1s"
 */
function formatDuration(ms) {
  if (!ms || ms <= 0) return "N/A";

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds && !days) parts.push(`${seconds}s`); // skip seconds for long durations

  return parts.join(" ") || "N/A";
}

module.exports = { formatDuration };
