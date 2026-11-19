import { describe, expect, it } from "vitest";
import { speakable } from "../src/lib/speak.js";

describe("speakable", () => {
  it("reads years as a person would", () => {
    expect(speakable("founded in 1978.")).toBe("founded in nineteen seventy eight.");
    expect(speakable("In 1948 he sailed.")).toBe("In nineteen forty eight he sailed.");
    expect(speakable("the 2008 crisis")).toBe("the two thousand eight crisis");
    expect(speakable("In 2000, Marta joined")).toBe("In two thousand, Marta joined");
    expect(speakable("graduated in 2013")).toBe("graduated in twenty thirteen");
    expect(speakable("March 2023")).toBe("March twenty twenty three");
  });

  it("reads decades and ranges", () => {
    expect(speakable("during the 1970s")).toBe("during the nineteen seventies");
    expect(speakable("the mid-1980s")).toBe("the mid-nineteen eighties");
    expect(speakable("the 2000s")).toBe("the two thousands");
    expect(speakable("Financials, 2018-2022")).toBe(
      "Financials, twenty eighteen to twenty twenty two",
    );
  });

  it("moves dollars after the scale", () => {
    expect(speakable("$1.3 billion")).toBe("1.3 billion dollars");
    expect(speakable("$1.3 Billion")).toBe("1.3 billion dollars");
    expect(speakable("a $12 billion offer")).toBe("a 12 billion dollars offer");
    expect(speakable("worth $9 billion.")).toBe("worth 9 billion dollars.");
    expect(speakable("$225 million")).toBe("225 million dollars");
    expect(speakable("a fare of $1.41.")).toBe("a fare of 1.41 dollars.");
    expect(speakable("it cost $1.")).toBe("it cost 1 dollar.");
  });

  it("collapses dotted acronyms", () => {
    expect(speakable("she got an M.B.A. to run it")).toBe("she got an MBA to run it");
    expect(speakable("A.J.M. Pemberly")).toBe("AJM Pemberly");
    expect(speakable("the U.S. state of Indiana")).toContain("United States");
    expect(speakable("college in the U.K. in 1980")).toContain("United Kingdom");
  });

  it("expands state codes after a city", () => {
    const out = speakable("LEXINGTON, Ky.—Each spring");
    expect(out.startsWith("LEXINGTON, Kentucky")).toBe(true);
    expect(out).not.toContain("Ky");
    expect(speakable("Portland, ME 04101")).toBe("Portland, Maine 04101");
    expect(speakable("returned, In 1978, she left.")).not.toContain("Indiana");
  });

  it("leaves ordinary numbers alone", () => {
    expect(speakable("about 1,500 employees")).toBe("about 1,500 employees");
    expect(speakable("founded in 1978.")).not.toContain("dollar");
    expect(speakable("")).toBe("");
  });

  it("smooths pause-heavy punctuation", () => {
    const out = speakable("Kentucky—Each spring");
    expect(out).not.toContain("—");
    expect(out).toContain("Kentucky, Each");
    expect(speakable("Ferries (LFC) was")).toBe("Ferries, LFC, was");
    expect(speakable("tomorrow… we’ll see")).not.toContain("…");
  });

  it("reads roman after a name as an ordinal", () => {
    expect(speakable("Arthur Penhallow II, his uncle")).toBe(
      "Arthur Penhallow the second, his uncle",
    );
    expect(speakable("Queen Elizabeth II opened")).toBe(
      "Queen Elizabeth the second opened",
    );
  });

  it("reads roman after a common noun as a cardinal", () => {
    expect(speakable("World War II ended")).toBe("World War two ended");
    expect(speakable("World War I began")).toBe("World War one began");
    expect(speakable("Chapter II introduces")).toBe("Chapter two introduces");
  });

  it("does not eat the pronoun I", () => {
    expect(speakable("And I have a plan.")).toBe("And I have a plan.");
    expect(speakable("But I also need help")).toBe("But I also need help");
  });
});
