/**
 * Sanitize Discord message content into a clean thread name.
 *
 * Strips mentions and custom emoji, collapses whitespace, truncates to 80
 * chars with "...", and falls back to a timestamp if nothing remains.
 */
export function sanitizeName(content: string): string {
  let name = content
    .replace(/<@!?\d+>/g, "")
    .replace(/<#\d+>/g, "")
    .replace(/<@&\d+>/g, "")
    .replace(/<a?:\w+:\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) {
    return `Session ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  }

  if (name.length > 80) {
    name = `${name.slice(0, 77)}...`;
  }

  return name;
}
