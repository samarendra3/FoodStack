import { InitExtensions1798000000000 } from './migrations/1798000000000-InitExtensions';
import { AppRoleGrants1798000001000 } from './migrations/1798000001000-AppRoleGrants';
import { TenancyCore1798000002000 } from './migrations/1798000002000-TenancyCore';
import { Identity1798000003000 } from './migrations/1798000003000-Identity';
import { AccessControl1798000004000 } from './migrations/1798000004000-AccessControl';
import { AuditLogs1798000005000 } from './migrations/1798000005000-AuditLogs';
import { SeedPermissionsAndSystemRoles1798000006000 } from './migrations/1798000006000-SeedPermissionsAndSystemRoles';
import { SessionPersistence1798000007000 } from './migrations/1798000007000-SessionPersistence';
import { AccessRequests1798000008000 } from './migrations/1798000008000-AccessRequests';
import { Menu1798000009000 } from './migrations/1798000009000-Menu';
import { Inventory1798000010000 } from './migrations/1798000010000-Inventory';
import { Reports1798000011000 } from './migrations/1798000011000-Reports';
import { Promotions1798000012000 } from './migrations/1798000012000-Promotions';
import { MenuVariants1798000012500 } from './migrations/1798000012500-MenuVariants';
import { Orders1798000013000 } from './migrations/1798000013000-Orders';
import { ListIndexes1798000014000 } from './migrations/1798000014000-ListIndexes';
import { Subscriptions1798000015000 } from './migrations/1798000015000-Subscriptions';
import { SubscriptionLifecycle1798000016000 } from './migrations/1798000016000-SubscriptionLifecycle';
import { PlanCatalogue1798000017000 } from './migrations/1798000017000-PlanCatalogue';
import { PlanManagement1798000018000 } from './migrations/1798000018000-PlanManagement';
import { Addons1798000019000 } from './migrations/1798000019000-Addons';
import { PaymentSessions1798000020000 } from './migrations/1798000020000-PaymentSessions';
import { OrderUsageCounters1798000021000 } from './migrations/1798000021000-OrderUsageCounters';
import { PerRestaurantUsage1798000022000 } from './migrations/1798000022000-PerRestaurantUsage';
import { EmailOutbox1798000023000 } from './migrations/1798000023000-EmailOutbox';
import { AnalyticsIndexes1798000024000 } from './migrations/1798000024000-AnalyticsIndexes';
import { MenuItemBranches1798000025000 } from './migrations/1798000025000-MenuItemBranches';
import { DiningTables1798000026000 } from './migrations/1798000026000-DiningTables';
import { OrderBillLabel1798000027000 } from './migrations/1798000027000-OrderBillLabel';
import { OperationsModules1798000028000 } from './migrations/1798000028000-OperationsModules';
import { PlatformSettings1798000029000 } from './migrations/1798000029000-PlatformSettings';
import { TableSessions1798000030000 } from './migrations/1798000030000-TableSessions';
import { OrderEvents1798000031000 } from './migrations/1798000031000-OrderEvents';
import { SecureQrAndGuestDetails1798000032000 } from './migrations/1798000032000-SecureQrAndGuestDetails';
import { OrderItemAddons1798000033000 } from './migrations/1798000033000-OrderItemAddons';
import { ItemKitchenStatus1798000034000 } from './migrations/1798000034000-ItemKitchenStatus';
import { WaiterAssignments1798000035000 } from './migrations/1798000035000-WaiterAssignments';
import { RestaurantOnlinePayments1798000036000 } from './migrations/1798000036000-RestaurantOnlinePayments';
import { BillingPaymentStatus1798000037000 } from './migrations/1798000037000-BillingPaymentStatus';

/**
 * All migrations in order, for code that cannot load them by file glob (the e2e test setup).
 * The CLI still discovers migrations from the folder; a test checks this list matches it.
 */
export const ALL_MIGRATIONS = [
  InitExtensions1798000000000,
  AppRoleGrants1798000001000,
  TenancyCore1798000002000,
  Identity1798000003000,
  AccessControl1798000004000,
  AuditLogs1798000005000,
  SeedPermissionsAndSystemRoles1798000006000,
  SessionPersistence1798000007000,
  AccessRequests1798000008000,
  Menu1798000009000,
  Inventory1798000010000,
  Reports1798000011000,
  Promotions1798000012000,
  MenuVariants1798000012500,
  Orders1798000013000,
  ListIndexes1798000014000,
  Subscriptions1798000015000,
  SubscriptionLifecycle1798000016000,
  PlanCatalogue1798000017000,
  PlanManagement1798000018000,
  Addons1798000019000,
  PaymentSessions1798000020000,
  OrderUsageCounters1798000021000,
  PerRestaurantUsage1798000022000,
  EmailOutbox1798000023000,
  AnalyticsIndexes1798000024000,
  MenuItemBranches1798000025000,
  DiningTables1798000026000,
  OrderBillLabel1798000027000,
  OperationsModules1798000028000,
  PlatformSettings1798000029000,
  TableSessions1798000030000,
  OrderEvents1798000031000,
  SecureQrAndGuestDetails1798000032000,
  OrderItemAddons1798000033000,
  ItemKitchenStatus1798000034000,
  WaiterAssignments1798000035000,
  RestaurantOnlinePayments1798000036000,
  BillingPaymentStatus1798000037000,
];
