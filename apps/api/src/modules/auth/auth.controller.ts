import { requestMeta } from '../../common/http/request-meta';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AppConfigService } from '../../config/app-config.service';
import {
  challengeSchema,
  enrollConfirmSchema,
  forgotPasswordSchema,
  loginSchema,
  type LoginInput,
  mfaVerifySchema,
  type MfaVerifyInput,
  resetPasswordSchema,
} from './auth.schemas';
import { AuthService, type IssuedSession } from './auth.service';
import type { AuthContext } from './auth.types';
import { clearSessionCookies, readRefreshCookie, setSessionCookies } from './cookies';
import { AllowAudience, AllowInactiveSubscription, CurrentAuth, Public } from './decorators';

const MINUTE = 60_000;

export const CSRF_HEADER = 'x-foodstack-csrf';

@ApiTags('Auth')
@AllowInactiveSubscription()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiOperation({ summary: 'Sign in with email and password (202 when a TOTP step follows)' })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    noStore(res);
    const result = await this.auth.login(body, meta(req));
    if (result.kind === 'mfa') {
      res.status(HttpStatus.ACCEPTED);
      return {
        mfaRequired: true,
        mfaEnrollmentRequired: result.mfaEnrollmentRequired,
        challengeToken: result.challengeToken,
      };
    }
    return this.issue(res, result.session);
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiOperation({ summary: 'Complete sign-in with a TOTP or recovery code' })
  async verifyMfa(
    @Body(new ZodValidationPipe(mfaVerifySchema)) body: MfaVerifyInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    noStore(res);
    return this.issue(res, await this.auth.verifyMfa(body, meta(req)));
  }

  @Public()
  @Post('mfa/enroll/start')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiOperation({ summary: 'First sign-in: create an authenticator secret (QR code)' })
  async startEnrollment(
    @Body(new ZodValidationPipe(challengeSchema)) body: { challengeToken: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    noStore(res);
    return this.auth.startEnrollment(body.challengeToken);
  }

  @Public()
  @Post('mfa/enroll/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiOperation({ summary: 'Confirm the authenticator code; returns one-time recovery codes' })
  async confirmEnrollment(
    @Body(new ZodValidationPipe(enrollConfirmSchema))
    body: { challengeToken: string; code: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    noStore(res);
    const session = await this.auth.confirmEnrollment(body.challengeToken, body.code, meta(req));
    return { ...this.issue(res, session), recoveryCodes: session.recoveryCodes };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: MINUTE } })
  @ApiOperation({ summary: 'Rotate the refresh cookie and get a new access token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    this.assertCsrf(req);
    try {
      return this.issue(res, await this.auth.refresh(readRefreshCookie(req), meta(req)));
    } catch (error) {
      clearSessionCookies(res, this.config);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End the current session and clear its cookies' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    this.assertCsrf(req);
    await this.auth.logout(readRefreshCookie(req), meta(req));
    clearSessionCookies(res, this.config);
  }

  @Get('me')
  @AllowAudience('any')
  @ApiOperation({ summary: 'Current user, active tenant, roles, permissions and home path' })
  me(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.auth.me(auth);
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 15 * MINUTE } })
  @ApiOperation({
    summary: 'Email a password reset link (same response whether or not the account exists)',
  })
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordSchema)) body: { email: string },
    @Req() req: Request,
  ) {
    await this.auth.forgotPassword(body.email, meta(req));
    return { status: 'accepted' };
  }

  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE } })
  @ApiOperation({
    summary:
      'Set a password from an emailed link; ends all sessions. With signIn, answers like /auth/login.',
  })
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema))
    body: { token: string; password: string; signIn: boolean },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const email = await this.auth.resetPassword(body.token, body.password, meta(req));
    if (!body.signIn) return undefined;
    // The normal sign-in path: lockout, tenant status and Super Admin TOTP all still apply.
    noStore(res);
    const result = await this.auth.login(
      { email, password: body.password, rememberMe: false },
      meta(req),
    );
    if (result.kind === 'mfa') {
      res.status(HttpStatus.ACCEPTED);
      return {
        mfaRequired: true,
        mfaEnrollmentRequired: result.mfaEnrollmentRequired,
        challengeToken: result.challengeToken,
      };
    }
    res.status(HttpStatus.OK);
    return this.issue(res, result.session);
  }

  private issue(res: Response, session: IssuedSession) {
    setSessionCookies(res, this.config, {
      refreshToken: session.refreshToken,
      audience: session.profile.audience,
      persistent: session.persistent,
    });
    return {
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      profile: session.profile,
    };
  }

  /**
   * Cookie-authenticated endpoints need a custom header (a cross-site form cannot set it) and,
   * when the browser sends one, an allowed Origin. SameSite=Strict is the first layer.
   */
  private assertCsrf(req: Request): void {
    const origin = req.headers.origin;
    const allowed = this.config.get('CORS_ORIGINS');
    const originOk = !origin || allowed.length === 0 || allowed.includes(origin);
    if (req.headers[CSRF_HEADER] !== '1' || !originOk) {
      throw new ForbiddenException({ code: 'AUTH_CSRF_FAILED', message: 'Request blocked.' });
    }
  }
}

const meta = requestMeta;

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}
