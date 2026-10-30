import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env, envSchema } from './env.validation';

/** Typed access to validated configuration. */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  /** Full validated configuration object. */
  snapshot(): Env {
    const keys = Object.keys(envSchema.shape) as (keyof Env)[];
    return Object.fromEntries(keys.map((key) => [key, this.get(key)])) as Env;
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }
}
