import { describe, expect, it } from 'vitest';
import { accessRequestFormSchema, tenantSlugSchema } from './access-request.js';

const valid = {
  restaurantName: 'Spice Hub',
  contactName: 'Priya Shah',
  email: 'priya@example.com',
  phone: '',
  city: '',
  branchCount: '',
  message: '',
};

describe('accessRequestFormSchema', () => {
  it('accepts the required fields with optional ones left empty', () => {
    expect(accessRequestFormSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a bad email, phone and branch count', () => {
    const result = accessRequestFormSchema.safeParse({
      ...valid,
      email: 'nope',
      phone: 'call me',
      branchCount: '0',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual([
      'branchCount',
      'email',
      'phone',
    ]);
  });
});

describe('tenantSlugSchema', () => {
  it.each(['spice-hub', 'cafe9', 'abc'])('accepts %s', (slug) => {
    expect(tenantSlugSchema.safeParse(slug).success).toBe(true);
  });
  it.each(['ab', '-spice', 'spice-', 'spice hub', 'a'.repeat(49)])('rejects %s', (slug) => {
    expect(tenantSlugSchema.safeParse(slug).success).toBe(false);
  });
});
