export function csvCell(s: string): string {
  // Spreadsheet programs may evaluate CSV cells as formulas even when the
  // field is correctly CSV-quoted. Prefix formula-like user content with an
  // apostrophe so exported display names stay inert when opened in a sheet.
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(s) ? `'${s}` : s;
  if (/[,"\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
