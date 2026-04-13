const LIMIT = 1900;

/**
 * Find a safe split point that avoids breaking code fences or inline code.
 * Returns the index to split at (exclusive for the first chunk).
 */
function findSplitPoint(text: string, maxLen: number): number {
  if (text.length <= maxLen) return text.length;

  const slice = text.slice(0, maxLen);

  // Check if we're inside a code fence at the split point
  const fenceInfo = getOpenFence(slice);

  if (fenceInfo) {
    // We're inside a code fence — try to split at a newline within the fence
    const lastNewline = slice.lastIndexOf("\n");
    if (lastNewline > fenceInfo.startOffset) {
      return lastNewline + 1;
    }
    // No good newline — force split at limit
    return maxLen;
  }

  // Not inside a code fence — find a newline
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 0) {
    // Check we're not splitting inside inline code (odd backtick count)
    const beforeSplit = text.slice(0, lastNewline + 1);
    const backtickCount = countChar(beforeSplit, "`") - countFenceBackticks(beforeSplit);
    if (backtickCount % 2 === 0) {
      return lastNewline + 1;
    }
    // Odd backticks — try an earlier newline
    const earlierNewline = slice.lastIndexOf("\n", lastNewline - 1);
    if (earlierNewline > 0) {
      return earlierNewline + 1;
    }
  }

  return maxLen;
}

/** Count occurrences of a character in a string. */
function countChar(s: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) count++;
  }
  return count;
}

/** Count backticks that belong to code fence markers (``` at line start). */
function countFenceBackticks(s: string): number {
  let count = 0;
  const fencePattern = /^(`{3,})/gm;
  let match;
  while ((match = fencePattern.exec(s)) !== null) {
    count += match[1].length;
  }
  return count;
}

/**
 * If `text` ends inside an unclosed code fence, return info about it.
 * Returns null if all fences are balanced.
 */
function getOpenFence(text: string): { lang: string; startOffset: number } | null {
  const fencePattern = /^(`{3,})(\S*)/gm;
  let openFence: { lang: string; startOffset: number; ticks: string } | null = null;
  let match;

  while ((match = fencePattern.exec(text)) !== null) {
    if (!openFence) {
      // Opening fence
      openFence = {
        lang: match[2],
        startOffset: match.index,
        ticks: match[1],
      };
    } else if (match[1].length >= openFence.ticks.length && !match[2]) {
      // Closing fence (must have at least as many backticks, no language tag)
      openFence = null;
    }
  }

  return openFence ? { lang: openFence.lang, startOffset: openFence.startOffset } : null;
}

export function splitMessage(text: string): string[] {
  if (text.length <= LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let openFenceLang: string | null = null;

  while (remaining.length > 0) {
    let chunk: string;

    // If continuing inside a code fence from a previous chunk, prepend the fence
    const prefix = openFenceLang !== null ? `\`\`\`${openFenceLang}\n` : "";
    const effectiveLimit = LIMIT - prefix.length;

    if (remaining.length <= effectiveLimit) {
      chunks.push(prefix + remaining);
      break;
    }

    const splitAt = findSplitPoint(remaining, effectiveLimit);
    chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // Check if this chunk ends inside an unclosed code fence
    const fullChunk = prefix + chunk;
    const fence = getOpenFence(fullChunk);

    if (fence) {
      // Close the fence at the end of this chunk
      chunks.push(fullChunk + "\n```");
      openFenceLang = fence.lang;
    } else {
      chunks.push(fullChunk);
      openFenceLang = null;
    }
  }

  // Add chunk indicators if multiple chunks
  if (chunks.length > 1) {
    return chunks.map((chunk, i) => `${chunk}\n(${i + 1}/${chunks.length})`);
  }

  return chunks;
}
