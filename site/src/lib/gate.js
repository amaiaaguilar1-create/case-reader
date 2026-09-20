/**
 * Shared-passphrase gate for the public site.
 *
 * The passphrase itself is never stored here. What ships is a PBKDF2-SHA-256
 * hash of it plus the salt it was derived with, so reading this file does not
 * hand anyone the phrase -- they would have to brute-force it, and 310k
 * iterations makes each guess cost real time.
 *
 * Be clear-eyed about what this is: every line of the site runs in the
 * visitor's browser, so a determined person can edit around the gate. It keeps
 * out the passing stranger and the search crawler; it is not a vault. Nothing
 * behind it is secret anyway -- each reader's documents live in their own
 * browser and never touch the network.
 */

const SALT = "c1e1c0d223af2c5a0ba66af65f863ca1";
const HASH = "a0fd218f820c1b2a0107da3034e148236951c4949b0c4fd064cbb342df4dc18a";
const ITERATIONS = 310000;
const REMEMBER_KEY = "caseReader.unlocked";

function bytes(hex) {
  return Uint8Array.from(hex.match(/../g).map(h => parseInt(h, 16)));
}

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare, so timing never leaks how much of a guess was right. */
function sameDigest(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** PBKDF2-SHA-256, exported so tests can check it without the real phrase. */
export async function digest(passphrase, saltHex = SALT, iterations = ITERATIONS) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("This browser is too old to check the password.");
  const key = await subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", salt: bytes(saltHex), iterations, hash: "SHA-256" },
    key, 256,
  );
  return hex(bits);
}

export async function verify(passphrase) {
  return sameDigest(await digest(passphrase), HASH);
}

/** Has this device already been let in? Private mode can throw; treat as no. */
export function unlocked() {
  try {
    return localStorage.getItem(REMEMBER_KEY) === HASH;
  } catch {
    return false;
  }
}

export function remember() {
  try {
    localStorage.setItem(REMEMBER_KEY, HASH);
  } catch {
    /* They will type it again next visit. Still better than refusing to open. */
  }
}

export function forget() {
  try {
    localStorage.removeItem(REMEMBER_KEY);
  } catch {
    /* Nothing to clear. */
  }
}
