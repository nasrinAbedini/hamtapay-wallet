import { MigrationInterface, QueryRunner } from "typeorm";

export class AllowReturnedWithdrawal1763100000000 implements MigrationInterface {
  name = "AllowReturnedWithdrawal1763100000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_status_check;
      ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_status_check
        CHECK(status IN ('PENDING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED','RETURNED'));
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE withdrawals SET status='SUCCEEDED' WHERE status='RETURNED';
      ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_status_check;
      ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_status_check
        CHECK(status IN ('PENDING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED'));
    `);
  }
}
