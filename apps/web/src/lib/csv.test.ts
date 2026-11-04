import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from './csv';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and newlines inside fields', () => {
    const text = 'Name,Desc\r\n"Tikka, Paneer","He said ""hot""\nand smoky"\r\nChai,\r\n';
    expect(parseCsv(text)).toEqual([
      ['Name', 'Desc'],
      ['Tikka, Paneer', 'He said "hot"\nand smoky'],
      ['Chai', ''],
    ]);
  });

  it('strips a BOM, detects semicolons and skips blank lines', () => {
    expect(parseCsv('﻿a;b\n\n1;2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('round-trips through toCsv', () => {
    const rows = [
      ['Category', 'Name'],
      ['Mains', 'Dal "Makhani", special'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
