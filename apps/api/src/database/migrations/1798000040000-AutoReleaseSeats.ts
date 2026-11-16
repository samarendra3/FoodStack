import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Frees a QR group's seats the moment ALL of its bills are fully paid.
 * Partial, pending and failed payments never complete an order, so they never release seats.
 */
export class AutoReleaseSeats1798000040000 implements MigrationInterface {
  name = 'AutoReleaseSeats1798000040000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE FUNCTION release_seats_when_guest_settled() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM orders WHERE guest_id = NEW.guest_id AND status = 'open') THEN
          RETURN NEW;
        END IF;
        IF EXISTS (
          SELECT 1 FROM payment_intents i JOIN orders o ON o.id = i.order_id
           WHERE o.guest_id = NEW.guest_id AND o.id <> NEW.id
             AND i.status = 'created' AND i.expires_at > now()
        ) THEN
          RETURN NEW;
        END IF;
        UPDATE table_seat_reservations
           SET status = 'released', released_at = now(), release_reason = 'guest_settled'
         WHERE guest_id = NEW.guest_id AND status = 'active';
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE TRIGGER orders_release_seats_trg
        AFTER UPDATE OF status ON orders
        FOR EACH ROW
        WHEN (NEW.guest_id IS NOT NULL AND NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION release_seats_when_guest_settled()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TRIGGER IF EXISTS orders_release_seats_trg ON orders');
    await q.query('DROP FUNCTION IF EXISTS release_seats_when_guest_settled()');
  }
}
