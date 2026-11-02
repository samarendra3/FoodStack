import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remembers whether the user chose "Remember me" at sign-in, so every refresh re-issues the
 * refresh cookie the same way: persistent (Max-Age) or browser-session only.
 */
export class SessionPersistence1798000007000 implements MigrationInterface {
  name = 'SessionPersistence1798000007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE sessions ADD COLUMN persistent boolean NOT NULL DEFAULT true',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE sessions DROP COLUMN persistent');
  }
}
