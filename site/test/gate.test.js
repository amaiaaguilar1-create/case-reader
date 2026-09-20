import { beforeEach, describe, expect, it } from "vitest";
import { digest, forget, remember, unlocked, verify } from "../src/lib/gate.js";

// The real passphrase is deliberately absent from this repo. Pass it in to
// exercise the accepting path locally:  READER_PASSPHRASE='…' npm test
const PHRASE = process.env.READER_PASSPHRASE;

function fakeStorage() {
  const store = new Map();
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
}

describe("digest", () => {
  it("matches a known PBKDF2-SHA-256 vector", async () => {
    const out = await digest("a known test phrase", "00112233445566778899aabbccddeeff", 1000);
    expect(out).toBe("ddd4958d1b01522a43ebab21e455a03509271dff57da94257341f8dde4193c0b");
  });

  it("separates phrases that differ only in case or spacing", async () => {
    const salt = "00112233445566778899aabbccddeeff";
    const a = await digest("Shared Phrase", salt, 1000);
    expect(await digest("shared phrase", salt, 1000)).not.toBe(a);
    expect(await digest(" Shared Phrase ", salt, 1000)).not.toBe(a);
  });
});

describe("verify", () => {
  it("rejects the empty string and a plainly wrong guess", async () => {
    expect(await verify("")).toBe(false);
    expect(await verify("password")).toBe(false);
    expect(await verify("let me in")).toBe(false);
  });

  it.skipIf(!PHRASE)("accepts the shared passphrase", async () => {
    expect(await verify(PHRASE)).toBe(true);
    expect(await verify(PHRASE.toLowerCase())).toBe(false);
    expect(await verify(` ${PHRASE} `)).toBe(false);
  });
});

describe("remembering a device", () => {
  beforeEach(() => {
    globalThis.localStorage = fakeStorage();
  });

  it("starts locked, opens after remember(), closes after forget()", () => {
    expect(unlocked()).toBe(false);
    remember();
    expect(unlocked()).toBe(true);
    forget();
    expect(unlocked()).toBe(false);
  });

  it("stays locked when the stored value is not the current digest", () => {
    globalThis.localStorage.setItem("caseReader.unlocked", "true");
    expect(unlocked()).toBe(false);
  });

  it("stays locked, rather than throwing, when storage is blocked", () => {
    globalThis.localStorage = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); },
    };
    expect(unlocked()).toBe(false);
    expect(() => remember()).not.toThrow();
    expect(() => forget()).not.toThrow();
  });
});
