import { describe, expect, test } from "bun:test";
import { splitMessage } from "../src/split";

describe("splitMessage", () => {
  test("returns single chunk for short messages", () => {
    const result = splitMessage("hello world");
    expect(result).toEqual(["hello world"]);
  });

  test("splits at line breaks before 2000 char limit", () => {
    const line = "x".repeat(100) + "\n";
    const text = line.repeat(25); // 2525 chars
    const result = splitMessage(text);
    expect(result.length).toBe(2);
    expect(result[0].length).toBeLessThanOrEqual(2000);
    expect(result[1].length).toBeGreaterThan(0);
    expect(result.join("")).toBe(text);
  });

  test("force-splits lines longer than 2000 chars", () => {
    const text = "x".repeat(4500);
    const result = splitMessage(text);
    expect(result.length).toBe(3);
    result.forEach((chunk) => expect(chunk.length).toBeLessThanOrEqual(2000));
    expect(result.join("")).toBe(text);
  });

  test("handles empty string", () => {
    expect(splitMessage("")).toEqual([""]);
  });
});
