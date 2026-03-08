import { describe, expect, it } from "bun:test";
import { extractConversationTerms } from "../src/core/context/manager.js";

describe("extractConversationTerms", () => {
  it("extracts meaningful terms", () => {
    const terms = extractConversationTerms("refactor the database connection pool");
    expect(terms).toContain("refactor");
    expect(terms).toContain("database");
    expect(terms).toContain("connection");
    expect(terms).toContain("pool");
  });

  it("filters stop words", () => {
    const terms = extractConversationTerms("can you with this code file");
    expect(terms).toEqual([]);
  });

  it("deduplicates case-insensitively", () => {
    const terms = extractConversationTerms("Foo foo FOO bar");
    expect(terms).toEqual(["Foo", "bar"]);
  });

  it("limits to 15 terms", () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const terms = extractConversationTerms(words);
    expect(terms).toHaveLength(15);
  });

  it("skips words shorter than 3 chars", () => {
    const terms = extractConversationTerms("ab cd ef gh ij kl mn op");
    expect(terms).toEqual([]);
  });

  it("handles underscore-prefixed identifiers", () => {
    const terms = extractConversationTerms("_privateVar __init__ _x");
    expect(terms).toContain("_privateVar");
    expect(terms).toContain("__init__");
  });

  it("handles empty input", () => {
    expect(extractConversationTerms("")).toEqual([]);
  });

  it("handles input with only special characters", () => {
    expect(extractConversationTerms("!@#$%^&*()")).toEqual([]);
  });

  it("handles camelCase as single word", () => {
    const terms = extractConversationTerms("myFunctionName");
    expect(terms).toEqual(["myFunctionName"]);
  });

  it("handles numbers in identifiers", () => {
    const terms = extractConversationTerms("test123 abc456");
    expect(terms).toContain("test123");
    expect(terms).toContain("abc456");
  });

  it("does not extract words starting with a number", () => {
    const terms = extractConversationTerms("123test 456abc");
    expect(terms).toContain("test");
    expect(terms).toContain("abc");
  });

  // Edge cases

  it("handles unicode identifiers — only ASCII fragments extracted", () => {
    const terms = extractConversationTerms("café résumé naïve");
    expect(terms).not.toContain("café");
    expect(terms).not.toContain("résumé");
    expect(terms).not.toContain("naïve");
    expect(terms).toContain("caf");
    expect(terms).toContain("sum");
  });

  it("handles very long input without hanging", () => {
    const chunk = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango ";
    const longInput = chunk.repeat(500);
    const start = performance.now();
    const terms = extractConversationTerms(longInput);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(terms.length).toBeLessThanOrEqual(15);
  });

  it("filters stop words in various cases", () => {
    const terms = extractConversationTerms("THE And FOR");
    expect(terms).toEqual([]);
  });

  it("splits hyphenated words and skips short fragments", () => {
    const terms = extractConversationTerms("my-component");
    expect(terms).not.toContain("my");
    expect(terms).toContain("component");
  });

  it("splits dotted identifiers", () => {
    const terms = extractConversationTerms("foo.bar.baz");
    expect(terms).toContain("foo");
    expect(terms).toContain("bar");
    expect(terms).toContain("baz");
  });

  it("deduplicates repeated words", () => {
    const terms = extractConversationTerms("foo foo foo foo");
    expect(terms).toEqual(["foo"]);
  });

  it("extracts code keywords that are not stop words", () => {
    const terms = extractConversationTerms("const return import export");
    expect(terms).toContain("const");
    expect(terms).toContain("return");
    expect(terms).toContain("import");
    expect(terms).toContain("export");
  });

  it("caps at exactly 15 unique words", () => {
    const words = Array.from({ length: 20 }, (_, i) => `term${String(i).padStart(2, "0")}`).join(" ");
    const terms = extractConversationTerms(words);
    expect(terms).toHaveLength(15);
    expect(terms[0]).toBe("term00");
    expect(terms[14]).toBe("term14");
  });

  it("handles input with newlines and tabs", () => {
    const terms = extractConversationTerms("alpha\nbravo\tcharlie\n\tdelta");
    expect(terms).toContain("alpha");
    expect(terms).toContain("bravo");
    expect(terms).toContain("charlie");
    expect(terms).toContain("delta");
  });

  it("extracts nothing from numbers-only input", () => {
    const terms = extractConversationTerms("123 456 789");
    expect(terms).toEqual([]);
  });

  it("extracts a single 3-char word", () => {
    const terms = extractConversationTerms("foo");
    expect(terms).toEqual(["foo"]);
  });
});
