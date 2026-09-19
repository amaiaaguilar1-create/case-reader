import { describe, expect, it } from "vitest";
import { speakable } from "../src/lib/speak.js";

describe("speakable", () => {
  it("reads years as a person would", () => {
    expect(speakable("founded in 1978.")).toBe("founded in nineteen seventy eight.");
    expect(speakable("In 1948 he fled.")).toBe("In nineteen forty eight he fled.");
    expect(speakable("the 2008 crisis")).toBe("the two thousand eight crisis");
    expect(speakable("In 2000, Jordan joined")).toBe("In two thousand, Jordan joined");
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
    expect(speakable("a $15 billion bid")).toBe("a 15 billion dollars bid");
    expect(speakable("worth $11 billion.")).toBe("worth 11 billion dollars.");
    expect(speakable("$225 million")).toBe("225 million dollars");
    expect(speakable("equivalent of $1.41.")).toBe("equivalent of 1.41 dollars.");
    expect(speakable("it cost $1.")).toBe("it cost 1 dollar.");
  });

  it("collapses dotted acronyms", () => {
    expect(speakable("he got an M.B.A. to comply")).toBe("he got an MBA to comply");
    expect(speakable("A.J.M. Wheatcroft")).toBe("AJM Wheatcroft");
    expect(speakable("the U.S. state of Indiana")).toContain("United States");
    expect(speakable("college in the U.K. in 1980")).toContain("United Kingdom");
  });

  it("expands state codes after a city", () => {
    const out = speakable("LOUISVILLE, Ky.—Each summer");
    expect(out.startsWith("LOUISVILLE, Kentucky")).toBe(true);
    expect(out).not.toContain("Ky");
    expect(speakable("Boston, MA 02163")).toBe("Boston, Massachusetts 02163");
    expect(speakable("returned, In 1978, she left.")).not.toContain("Indiana");
  });

  it("leaves ordinary numbers alone", () => {
    expect(speakable("about 1,500 employees")).toBe("about 1,500 employees");
    expect(speakable("founded in 1978.")).not.toContain("dollar");
    expect(speakable("")).toBe("");
  });

  it("smooths pause-heavy punctuation", () => {
    const out = speakable("Kentucky—Each summer");
    expect(out).not.toContain("—");
    expect(out).toContain("Kentucky, Each");
    expect(speakable("Holding (FHH) was")).toBe("Holding, FHH, was");
    expect(speakable("independence… we’ll be better")).not.toContain("…");
  });

  it("reads roman after a name as an ordinal", () => {
    expect(speakable("Owsley Brown II, his uncle")).toBe(
      "Owsley Brown the second, his uncle",
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
    expect(speakable("And I have experience.")).toBe("And I have experience.");
    expect(speakable("But I also need people")).toBe("But I also need people");
  });
});
