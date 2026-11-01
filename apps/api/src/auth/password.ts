import argon2 from "argon2";

// OWASP-recommended argon2id baseline (m=19 MiB, t=2, p=1).
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string) => argon2.hash(plain, OPTIONS);

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * Hash of a random password, verified against when the email doesn't exist so that
 * "unknown user" and "wrong password" take the same time (no user enumeration by timing).
 */
export const DUMMY_HASH = hashPassword("dummy-password-for-timing-equalisation");
