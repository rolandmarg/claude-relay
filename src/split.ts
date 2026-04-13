const LIMIT = 1900;

export function splitMessage(text: string): string[] {
  if (text.length <= LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= LIMIT) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline before the limit
    const slice = remaining.slice(0, LIMIT);
    const lastNewline = slice.lastIndexOf("\n");

    if (lastNewline > 0) {
      chunks.push(remaining.slice(0, lastNewline + 1));
      remaining = remaining.slice(lastNewline + 1);
    } else {
      // No newline found — force split at limit
      chunks.push(slice);
      remaining = remaining.slice(LIMIT);
    }
  }

  return chunks;
}
