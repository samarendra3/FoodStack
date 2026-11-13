import { financialYear, invoiceNumber } from './invoices';

describe('GST invoice numbering', () => {
  it('uses the Indian financial year (April to March)', () => {
    expect(financialYear('2026-04-01')).toBe('26-27');
    expect(financialYear('2027-03-31')).toBe('26-27');
    expect(financialYear('2026-03-31')).toBe('25-26');
    expect(financialYear('2099-12-01')).toBe('99-00');
  });

  it('builds numbers within the 16-character GST limit and allowed characters', () => {
    const n = invoiceNumber('main', '26-27', 42);
    expect(n).toBe('MAIN/26-27/00042');
    expect(n.length).toBeLessThanOrEqual(16);
    const long = invoiceNumber('downtown_branch-2', '26-27', 99999);
    expect(long).toBe('DOWN/26-27/99999');
    expect(long).toMatch(/^[A-Za-z0-9/-]{1,16}$/);
    expect(invoiceNumber('__', '26-27', 1)).toBe('INV/26-27/00001');
  });
});
