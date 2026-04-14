import { expect, test } from "bun:test";
import { sanitizeName } from "../src/sanitize";

test("strips user mentions", () => {
  expect(sanitizeName("<@147214763470461752> hello world")).toBe("hello world");
});

test("strips nickname mentions", () => {
  expect(sanitizeName("<@!147214763470461752> hello")).toBe("hello");
});

test("strips channel mentions", () => {
  expect(sanitizeName("check <#123456789> for details")).toBe("check for details");
});

test("strips role mentions", () => {
  expect(sanitizeName("<@&999999999> announcement")).toBe("announcement");
});

test("strips multiple mentions", () => {
  expect(sanitizeName("<@111> hey <@222> what's up")).toBe("hey what's up");
});

test("collapses multiple spaces", () => {
  expect(sanitizeName("hello    world")).toBe("hello world");
});

test("trims whitespace", () => {
  expect(sanitizeName("  hello world  ")).toBe("hello world");
});

test("truncates at 80 chars with ellipsis", () => {
  const long = "a".repeat(100);
  const result = sanitizeName(long);
  expect(result.length).toBe(80);
  expect(result.endsWith("...")).toBe(true);
  expect(result).toBe("a".repeat(77) + "...");
});

test("does not truncate at exactly 80 chars", () => {
  const exact = "a".repeat(80);
  expect(sanitizeName(exact)).toBe(exact);
});

test("returns fallback for empty content", () => {
  const result = sanitizeName("");
  expect(result).toMatch(/^Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("returns fallback when content is only mentions", () => {
  const result = sanitizeName("<@147214763470461752>");
  expect(result).toMatch(/^Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("strips custom emoji syntax", () => {
  expect(sanitizeName("hello <:smile:123456> world")).toBe("hello world");
});

test("strips animated emoji syntax", () => {
  expect(sanitizeName("hello <a:dance:789> world")).toBe("hello world");
});
