import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DbContext } from '../../core/db/db-context';
import { PasswordHasher } from '../../core/security/password-hasher';
import { AccessService } from './access.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { TokenService } from './token.service';

/**
 * Sign-in, sessions, two-factor and password reset (docs/phase-3-design.md §4), plus the global
 * AuthGuard that protects every route not marked @Public().
 */
@Module({
  controllers: [AuthController],
  providers: [
    DbContext,
    PasswordHasher,
    TokenService,
    AccessService,
    MfaService,
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [DbContext, AccessService, PasswordHasher],
})
export class AuthModule {}
