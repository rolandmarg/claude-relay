import { expect, test } from "bun:test";
import { cleanTitle } from "../src/dobby/haiku";

test("returns title as-is when clean", () => {
  expect(cleanTitle("Model and Reasoning Query")).toBe("Model and Reasoning Query");
});

test("strips surrounding double quotes", () => {
  expect(cleanTitle("\"Model Query\"")).toBe("Model Query");
});

test("strips surrounding single quotes", () => {
  expect(cleanTitle("'Model Query'")).toBe("Model Query");
});

test("strips Title: prefix", () => {
  expect(cleanTitle("Title: Model Query")).toBe("Model Query");
});

test("strips title: prefix case-insensitive", () => {
  expect(cleanTitle("title: Model Query")).toBe("Model Query");
});

test("strips trailing period", () => {
  expect(cleanTitle("Model Query.")).toBe("Model Query");
});

test("truncates to 40 chars with ellipsis", () => {
  const long = "word ".repeat(20);
  const result = cleanTitle(long);
  expect(result?.length).toBe(40);
  expect(result?.endsWith("...")).toBe(true);
});

test("does not truncate at exactly 40 chars", () => {
  const exact = "a".repeat(40);
  expect(cleanTitle(exact)).toBe(exact);
});

test("returns null for empty string", () => {
  expect(cleanTitle("")).toBeNull();
});

test("returns null for whitespace-only", () => {
  expect(cleanTitle("   ")).toBeNull();
});

test("handles combined cleanup", () => {
  expect(cleanTitle("\"Title: Some Good Title.\"")).toBe("Some Good Title");
});
