import { randomBytes } from 'node:crypto';
import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { Secret, TOTP } from 'otpauth';
import { toDataURL } from 'qrcode';
import { AppConfigService } from '../../config/app-config.service';
import { decryptSecret, encryptSecret } from '../../core/security/crypto';
import { REDIS_CLIENT } from '../../shared/redis/redis.constants';

const PERIOD_S = 30;
export const RECOVERY_CODE_COUNT = 10;

/**
 * TOTP (RFC 6238: SHA-1, 6 digits, 30 s, ±1 step). Secrets are AES-256-GCM encrypted at rest and
 * an accepted time step cannot be replayed.
 */
@Injectable()
export class MfaService {
  private readonly key: Buffer | undefined;
  private readonly issuer: string;
  private readonly prefix: string;

  constructor(
    config: AppConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    const key = config.get('MFA_ENCRYPTION_KEY');
    this.key = key ? Buffer.from(key, 'base64') : undefined;
    if (!this.key && config.get('NODE_ENV') !== 'test') {
      // Required in staging/production by env validation; locally, say so before a Super Admin
      // hits it at their first sign-in.
      new Logger(MfaService.name).warn(
        'MFA_ENCRYPTION_KEY is not set: Super Admin sign-in (two-step verification) and queued email (password reset, invitations) will fail. Copy it from .env.example.',
      );
    }
    this.issuer = config.get('MFA_ISSUER');
    this.prefix = `${config.get('QUEUE_PREFIX')}:auth`;
  }

  /** New secret for enrolment: encrypted value to store, plus what the authenticator app needs. */
  async createSecret(accountEmail: string) {
    const secret = new Secret({ size: 20 });
    const totp = this.totp(secret, accountEmail);
    const otpauthUrl = totp.toString();
    return {
      encrypted: encryptSecret(secret.base32, this.requireKey()),
      otpauthUrl,
      manualKey: secret.base32,
      qrDataUrl: await toDataURL(otpauthUrl, { margin: 1, width: 220 }),
    };
  }

  /** True once per valid code: the matched time step is remembered to block replays. */
  async verify(userId: string, encrypted: Buffer, code: string): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false;
    const secret = Secret.fromBase32(decryptSecret(encrypted, this.requireKey()));
    const delta = this.totp(secret, '').validate({ token: code, window: 1 });
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 1000 / PERIOD_S) + delta;
    // SET NX: only the first use of this step for this user succeeds.
    const fresh = await this.redis.set(
      `${this.prefix}:totp-step:${userId}:${step}`,
      '1',
      'EX',
      PERIOD_S * 3,
      'NX',
    );
    return fresh === 'OK';
  }

  /** Counts a failed attempt; true once the limit is reached. */
  async registerFailure(challengeId: string, limit = 5): Promise<boolean> {
    const key = `${this.prefix}:mfa-attempts:${challengeId}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 15 * 60);
    return count >= limit;
  }

  /** Human-friendly one-time codes, e.g. "7KQ2-M9XD". */
  generateRecoveryCodes(): string[] {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const chars = [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join('');
      return `${chars.slice(0, 4)}-${chars.slice(4)}`;
    });
  }

  normalizeRecoveryCode(code: string): string {
    return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  private totp(secret: Secret, label: string): TOTP {
    return new TOTP({
      issuer: this.issuer,
      label,
      algorithm: 'SHA1',
      digits: 6,
      period: PERIOD_S,
      secret,
    });
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new InternalServerErrorException(
        'MFA_ENCRYPTION_KEY is not configured (pnpm --filter @foodstack/api keys:generate)',
      );
    }
    return this.key;
  }
}
