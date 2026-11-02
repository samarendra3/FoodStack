import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/** OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane). */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Hashes running at once; extra callers wait, so a login flood cannot exhaust memory. */
const MAX_CONCURRENT = 4;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

@Injectable()
export class PasswordHasher {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** Verified against for unknown emails so response time does not reveal which accounts exist. */
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return this.limit(() => argon2.hash(password, OPTIONS));
  }

  /** False for a wrong password or a malformed hash; never throws for bad input. */
  verify(hash: string, password: string): Promise<boolean> {
    return this.limit(() => argon2.verify(hash, password).catch(() => false));
  }

  /** Spends the same work as a real verification, then fails. */
  async verifyDummy(password: string): Promise<false> {
    this.dummyHash ??= argon2.hash('dummy-password-for-timing', OPTIONS);
    await this.verify(await this.dummyHash, password);
    return false;
  }

  private async limit<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
