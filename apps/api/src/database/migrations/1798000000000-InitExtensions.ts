import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline: PostgreSQL extensions required by the approved schema design
 * (citext for case-insensitive emails, pg_trgm for search). No business tables yet.
 */
export class InitExtensions1798000000000 implements MigrationInterface {
  name = 'InitExtensions1798000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS citext');
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP EXTENSION IF EXISTS pg_trgm');
    await queryRunner.query('DROP EXTENSION IF EXISTS citext');
  }
}
