export function formatRelativeTime(value: string): string {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return "";
  const minutes = Math.max(0, Math.floor(diff / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

export function formatDuration(durationMs?: number): string {
  if (durationMs === undefined || durationMs < 1_000)
    return durationMs ? `${durationMs}ms` : "";
  if (durationMs < 60_000) return `${Math.round(durationMs / 100) / 10}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
  return `${Math.round((bytes / 1_048_576) * 10) / 10} MB`;
}

export function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "about:blank";
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed))
    return `http://${trimmed}`;
  if (/\s/.test(trimmed) || !trimmed.includes(".")) {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  }
  return `https://${trimmed}`;
}
