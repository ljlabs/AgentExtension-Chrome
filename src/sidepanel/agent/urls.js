export function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, "")}${ensureLeadingSlash(path)}`;
}

export function ensureLeadingSlash(path) {
  const value = String(path || "");
  return value.startsWith("/") ? value : `/${value}`;
}
