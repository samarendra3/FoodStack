import { describe, expect, it } from 'vitest';
import { addonProblem, decodeLine, encodeLine, pickedAddons } from './cart-line';

const groups = [
  {
    id: 'g1',
    name: 'Milk',
    minSelect: 1,
    maxSelect: 1,
    options: [
      { id: 'o1', name: 'Regular', priceMinor: 0 },
      { id: 'o2', name: 'Oat', priceMinor: 3000 },
    ],
  },
  {
    id: 'g2',
    name: 'Extras',
    minSelect: 0,
    maxSelect: 2,
    options: [
      { id: 'o3', name: 'Cheese', priceMinor: 2000 },
      { id: 'o4', name: 'Honey', priceMinor: 1000 },
      { id: 'o5', name: 'Nuts', priceMinor: 1500 },
    ],
  },
];

describe('cart line keys', () => {
  it('keeps the old key formats for plain items and portions', () => {
    expect(encodeLine({ itemId: 'i', variantId: null, addonIds: [], note: '' })).toBe('i');
    expect(encodeLine({ itemId: 'i', variantId: 'v', addonIds: [], note: ' ' })).toBe('i:v');
    expect(decodeLine('i')).toEqual({ itemId: 'i', variantId: null, addonIds: [], note: '' });
    expect(decodeLine('i:v')).toEqual({ itemId: 'i', variantId: 'v', addonIds: [], note: '' });
  });

  it('round-trips add-ons (order-insensitive) and notes with separators in them', () => {
    const a = encodeLine({
      itemId: 'i',
      variantId: null,
      addonIds: ['o4', 'o3'],
      note: 'no: onion, ok',
    });
    const b = encodeLine({
      itemId: 'i',
      variantId: null,
      addonIds: ['o3', 'o4'],
      note: 'no: onion, ok',
    });
    expect(a).toBe(b); // same choice = same line
    expect(decodeLine(a)).toEqual({
      itemId: 'i',
      variantId: null,
      addonIds: ['o3', 'o4'],
      note: 'no: onion, ok',
    });
  });

  it('separates the same dish with different instructions', () => {
    const plain = encodeLine({ itemId: 'i', variantId: null, addonIds: [], note: '' });
    const noted = encodeLine({ itemId: 'i', variantId: null, addonIds: [], note: 'less spicy' });
    expect(plain).not.toBe(noted);
  });
});

describe('add-on rules', () => {
  it('requires required groups and caps maximums', () => {
    expect(addonProblem(groups, [])).toBe('Choose Milk');
    expect(addonProblem(groups, ['o1', 'o2'])).toBe('Choose at most 1 for Milk');
    expect(addonProblem(groups, ['o2', 'o3', 'o4', 'o5'])).toBe('Choose at most 2 for Extras');
    expect(addonProblem(groups, ['o2', 'o3'])).toBeNull();
    expect(addonProblem(undefined, [])).toBeNull();
  });

  it('resolves picked options and drops unknown ids', () => {
    expect(pickedAddons(groups, ['o2', 'zz']).map((o) => o.name)).toEqual(['Oat']);
  });
});
