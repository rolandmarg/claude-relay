import { describe, expect, test } from "bun:test";
import { splitMessage } from "../src/split";

describe("splitMessage", () => {
  test("returns single chunk for short messages", () => {
    const result = splitMessage("hello world");
    expect(result).toEqual(["hello world"]);
  });

  test("no chunk indicator for single-chunk messages", () => {
    const result = splitMessage("short message");
    expect(result.length).toBe(1);
    expect(result[0]).not.toContain("(1/");
  });

  test("splits at line breaks before 1900 char limit", () => {
    const line = "x".repeat(100) + "\n";
    const text = line.repeat(25); // 2525 chars
    const result = splitMessage(text);
    expect(result.length).toBe(2);
    // Each chunk has indicator appended
    expect(result[0]).toContain("(1/2)");
    expect(result[1]).toContain("(2/2)");
  });

  test("force-splits lines longer than 1900 chars", () => {
    const text = "x".repeat(4500);
    const result = splitMessage(text);
    expect(result.length).toBe(3);
    expect(result[0]).toContain("(1/3)");
    expect(result[2]).toContain("(3/3)");
  });

  test("handles empty string", () => {
    expect(splitMessage("")).toEqual([""]);
  });

  // --- Code-block-aware tests ---

  test("closes and reopens code fence across chunks", () => {
    // Build a message with a long code block that forces splitting
    const codeLine = "  console.log('test');\n";
    const codeBlock =
      "```typescript\n" + codeLine.repeat(100) + "```\n";
    // This should be well over 1900 chars
    expect(codeBlock.length).toBeGreaterThan(1900);

    const result = splitMessage(codeBlock);
    expect(result.length).toBeGreaterThan(1);

    // First chunk should end with a closing fence (plus indicator)
    const firstChunk = result[0];
    // The chunk content (before indicator) should end with ```
    const firstContent = firstChunk.replace(/\n\(\d+\/\d+\)$/, "");
    expect(firstContent).toMatch(/```$/);

    // Second chunk should reopen with the language tag
    const secondContent = result[1].replace(/\n\(\d+\/\d+\)$/, "");
    expect(secondContent).toMatch(/^```typescript\n/);
  });

  test("does not add fence closing when not inside a code block", () => {
    const text = "Hello world\n".repeat(200); // ~2400 chars of plain text
    const result = splitMessage(text);
    expect(result.length).toBeGreaterThan(1);

    for (const chunk of result) {
      const content = chunk.replace(/\n\(\d+\/\d+\)$/, "");
      // Should not contain dangling code fences
      expect(content).not.toMatch(/^```\w*\n/);
    }
  });

  test("handles balanced code fences (no reopening needed)", () => {
    // Complete code block that fits in one chunk + trailing text that doesn't
    const block = "```js\nconsole.log('hi');\n```\n";
    const text = block + "x".repeat(1900);
    const result = splitMessage(text);
    expect(result.length).toBeGreaterThan(1);

    // Second chunk should NOT start with a fence reopening
    const secondContent = result[1].replace(/\n\(\d+\/\d+\)$/, "");
    expect(secondContent).not.toMatch(/^```/);
  });

  test("chunk indicators show correct counts", () => {
    const text = "a".repeat(5000);
    const result = splitMessage(text);
    const total = result.length;
    for (let i = 0; i < total; i++) {
      expect(result[i]).toContain(`(${i + 1}/${total})`);
    }
  });
});
