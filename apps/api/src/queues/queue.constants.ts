/**
 * Registered BullMQ queues. Only queues with a producer and a worker are registered (each one
 * holds a Redis connection per process). `default`, `orders`, `inventory` and `reports` were
 * removed in Phase 5: nothing used them. Add a name here together with its first job.
 */
export const QueueName = {
  Notifications: 'notifications',
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const ALL_QUEUES: QueueName[] = Object.values(QueueName);

/** Job names on the notifications queue. */
export const EMAIL_JOB = 'email';
