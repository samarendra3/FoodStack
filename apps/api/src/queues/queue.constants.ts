/**
 * Queue names reserved by the architecture (docs/system-architecture.md §6).
 * Processors are added by the owning business modules in later phases.
 */
export const QueueName = {
  Default: 'default',
  Notifications: 'notifications',
  Orders: 'orders',
  Inventory: 'inventory',
  Reports: 'reports',
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const ALL_QUEUES: QueueName[] = Object.values(QueueName);
