import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { envFilePaths } from '../config/env-files';
import { validateEnv } from '../config/env.validation';
import { buildDataSourceOptions } from './typeorm.options';

// Used only by the TypeORM CLI (migrations), connecting as the schema owner. Loads env files like the Nest app does;
// process.loadEnvFile never overrides variables that are already set, so the first file
// (and the real environment) wins.
for (const file of envFilePaths()) {
  if (existsSync(file)) process.loadEnvFile(file);
}

export default new DataSource(buildDataSourceOptions(validateEnv(process.env), 'owner'));
