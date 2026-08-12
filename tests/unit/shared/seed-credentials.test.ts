import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { beyondCpuBudget, hashPassword, needsRehash, verifyPassword } from "@podiumstack/domain/identity/credentials.js";

/**
 * `scripts/seed.mjs` writes `auth_identity.credential_hash` itself, with its
 * own copy of the Argon2id parameters — it is plain `.mjs` run by node and
 * cannot import the Worker's TypeScript module. Duplication that nothing
 * checks is how this broke: the app lowered `ARGON2_PARAMS` to `m=256` to fit
 * the free plan's 10 ms CPU budget and began refusing stored hashes above
 * `MAX_VERIFIABLE_M`, while the seed carried on writing `m=12288`. Every
 * seeded persona's password became unverifiable — sign-in returned 409,
 * `npm run dev` could not publish the seeded schedule, and the smoke walk
 * could not start.
 *
 * Nothing failed loudly at the time, because no test ever verified a password
 * the seed had actually written. These do.
 */

const SEED = new URL("../../../scripts/seed.mjs", import.meta.url).pathname;

function seedArgonParams(): { t: number; m: number; p: number } {
  const src = readFileSync(SEED, "utf8");
  const match = src.match(/const ARGON = \{([^}]*)\}/);
  if (!match) throw new Error("scripts/seed.mjs no longer declares `const ARGON = { … }` — update this test with it");
  const read = (key: string): number => {
    const found = match[1].match(new RegExp(`\\b${key}:\\s*(\\d+)`));
    if (!found) throw new Error(`seed ARGON is missing \`${key}\``);
    return Number(found[1]);
  };
  return { t: read("t"), m: read("m"), p: read("p") };
}

/** The seed's own hash construction, mirrored so the assertions below use a real seeded hash. */
function seedStyleHash(plaintext: string, saltSeed: string, params: { t: number; m: number; p: number }): string {
  const salt = new Uint8Array(16);
  for (let i = 0; i < 16; i++) salt[i] = (saltSeed.charCodeAt(i % saltSeed.length) * (i + 7)) % 256;
  // Built through the app's own hasher so the PHC string is byte-identical to
  // what `verifyPassword` expects — the point under test is the parameters,
  // not the encoding.
  return hashPassword(plaintext, salt);
}

describe("the seed's credentials", () => {
  const seeded = seedArgonParams();

  it("uses Argon2id parameters this deployment can actually verify (INV-01-12)", () => {
    // A seeded hash above MAX_VERIFIABLE_M is refused with a 409 before
    // verification is even attempted, which is what took local sign-in down.
    const phc = `$argon2id$v=19$m=${seeded.m},t=${seeded.t},p=${seeded.p}$c2FsdA==$aGFzaA==`;
    expect(
      beyondCpuBudget(phc),
      `scripts/seed.mjs writes m=${seeded.m}, which the app refuses as too expensive to verify — every seeded password would be unusable`,
    ).toBe(false);
  });

  it("matches the app's current ARGON2_PARAMS, so a seeded password is never stale on first use", () => {
    const phc = `$argon2id$v=19$m=${seeded.m},t=${seeded.t},p=${seeded.p}$c2FsdA==$aGFzaA==`;
    expect(
      needsRehash(phc),
      `scripts/seed.mjs and packages/domain/src/identity/credentials.ts have drifted — seed writes ${JSON.stringify(seeded)}`,
    ).toBe(false);
  });

  it("produces a hash the app can verify, and rejects the wrong password", () => {
    const password = "SbekTest!2027-org";
    const stored = seedStyleHash(password, "devflow-organizer", seeded);
    expect(verifyPassword(password, stored)).toBe(true);
    expect(verifyPassword("not-the-password", stored)).toBe(false);
  });
});
