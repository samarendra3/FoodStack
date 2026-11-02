const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  platform_support: 'Platform Support',
  owner: 'Restaurant Owner',
  restaurant_admin: 'Restaurant Admin',
  branch_manager: 'Branch Manager',
  accountant: 'Accountant',
  cashier: 'Cashier',
  waiter: 'Waiter',
  kitchen_manager: 'Kitchen Manager',
  kitchen_staff: 'Kitchen Staff',
  inventory_manager: 'Inventory Manager',
  purchase_manager: 'Purchase Manager',
};

export function roleLabel(code: string): string {
  return ROLE_LABELS[code] ?? code.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase() ||
    '?'
  );
}
