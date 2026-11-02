import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { errors, jwtVerify, SignJWT } from 'jose';
import { AppConfigService } from '../../config/app-config.service';
import { durationMs } from '../../core/security/crypto';
import type { Audience } from './auth.types';

const ALG = 'EdDSA';
const AUDIENCES: Record<Audience, string> = {
  tenant: 'foodstack:tenant',
  platform: 'foodstack:platform',
};

export interface AccessClaims {
  userId: string;
  sessionId: string;
  audience: Audience;
  tenantId: string | null;
  membershipId: string | null;
  /** Authentication methods: 'pwd', plus 'totp' after two-factor verification. */
  amr: string[];
}

export interface SignedAccessToken {
  accessToken: string;
  expiresAt: string;
}

/**
 * Short-lived access tokens: JWT signed with Ed25519, algorithm pinned on verification.
 * Locally, without configured keys, a temporary pair is generated at startup; signed-in users
 * then get a new access token from their refresh cookie after an API restart.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly keyId: string;
  private readonly issuer: string;
  private readonly ttlMs: number;

  constructor(config: AppConfigService) {
    const privatePem = config.get('JWT_PRIVATE_KEY');
    const publicPem = config.get('JWT_PUBLIC_KEY');
    if (privatePem && publicPem) {
      this.privateKey = createPrivateKey(privatePem);
      this.publicKey = createPublicKey(publicPem);
      this.keyId = config.get('JWT_KEY_ID');
    } else {
      // Env validation requires keys in staging/production, so this branch is local only.
      const pair = generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
      this.keyId = `ephemeral-${randomUUID().slice(0, 8)}`;
      if (config.get('NODE_ENV') === 'development') {
        this.logger.warn('JWT keys not configured: using a temporary key pair for this process');
      }
    }
    this.issuer = config.get('JWT_ISSUER');
    this.ttlMs = durationMs(config.get('JWT_ACCESS_TTL'));
  }

  async sign(claims: AccessClaims): Promise<SignedAccessToken> {
    const expiresAt = new Date(Date.now() + this.ttlMs);
    const token = await new SignJWT({
      sid: claims.sessionId,
      ...(claims.tenantId ? { tid: claims.tenantId, mid: claims.membershipId } : {}),
      amr: claims.amr,
    })
      .setProtectedHeader({ alg: ALG, kid: this.keyId, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(AUDIENCES[claims.audience])
      .setSubject(claims.userId)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.privateKey);
    return { accessToken: token, expiresAt: expiresAt.toISOString() };
  }

  /** Throws 401 for any invalid, expired or foreign token. */
  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.publicKey, {
        algorithms: [ALG],
        issuer: this.issuer,
        audience: Object.values(AUDIENCES),
        clockTolerance: 30,
      });
      if (protectedHeader.kid !== this.keyId) throw new Error('Unknown key id');
      const audience = (Object.keys(AUDIENCES) as Audience[]).find(
        (a) => payload.aud === AUDIENCES[a],
      );
      if (!audience || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new Error('Malformed claims');
      }
      const tenantId = typeof payload.tid === 'string' ? payload.tid : null;
      if ((audience === 'tenant') !== (tenantId !== null)) throw new Error('Audience mismatch');
      return {
        userId: payload.sub,
        sessionId: payload.sid,
        audience,
        tenantId,
        membershipId: typeof payload.mid === 'string' ? payload.mid : null,
        amr: Array.isArray(payload.amr) ? payload.amr.map(String) : [],
      };
    } catch (error) {
      const expired = error instanceof errors.JWTExpired;
      throw new UnauthorizedException({
        code: expired ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_UNAUTHENTICATED',
        message: expired ? 'Access token expired' : 'Invalid access token',
      });
    }
  }
}
