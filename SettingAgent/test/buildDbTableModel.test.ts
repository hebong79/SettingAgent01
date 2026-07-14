import { describe, it, expect } from 'vitest';
import { buildDbTableModel } from '../web/core.js';

/**
 * 검증자(qa-tester): core.js 순수 함수 buildDbTableModel({columns, rows}) → { headers, cells }.
 * 근거: 01_architect_plan.md §08 F6 + 02_developer_changes.md 02-K.
 * 컬럼 순서 보존, 셀 문자열화(null→''·누락키→''·숫자→문자열·객체→JSON·blob→[blob]), 방어성(빈/비배열→빈 모델, throw 금지).
 */

describe('buildDbTableModel (순수)', () => {
  it('columns+rows → 컬럼 순서대로 셀 정렬', () => {
    const m = buildDbTableModel({
      columns: ['id', 'plate', 'conf'],
      rows: [
        { id: 1, plate: 'car-A', conf: 0.9 },
        { id: 2, plate: 'car-B', conf: 0.8 },
      ],
    });
    expect(m.headers).toEqual(['id', 'plate', 'conf']);
    expect(m.cells).toEqual([
      ['1', 'car-A', '0.9'],
      ['2', 'car-B', '0.8'],
    ]);
  });

  it('컬럼 순서 보존(행 키 순서와 무관하게 columns 순서로 정렬)', () => {
    const m = buildDbTableModel({
      columns: ['a', 'b', 'c'],
      // 행 객체의 키 순서는 c,a,b 이지만 헤더 순서(a,b,c)를 따라야 함.
      rows: [{ c: 3, a: 1, b: 2 }],
    });
    expect(m.cells).toEqual([['1', '2', '3']]);
  });

  it('null → 빈 문자열', () => {
    const m = buildDbTableModel({ columns: ['x'], rows: [{ x: null }] });
    expect(m.cells).toEqual([['']]);
  });

  it('누락 키 → 빈 문자열(undefined 처리)', () => {
    const m = buildDbTableModel({ columns: ['x', 'y'], rows: [{ x: 1 }] });
    // y 키 없음 → ''.
    expect(m.cells).toEqual([['1', '']]);
  });

  it('숫자(0 포함) → 문자열화, boolean → 문자열', () => {
    const m = buildDbTableModel({ columns: ['n', 'z', 'b'], rows: [{ n: 42, z: 0, b: false }] });
    expect(m.cells).toEqual([['42', '0', 'false']]);
  });

  it('객체 → JSON 문자열, Buffer/Uint8Array(BLOB) → [blob]', () => {
    const m = buildDbTableModel({
      columns: ['obj', 'buf', 'arr'],
      rows: [{ obj: { k: 1 }, buf: Buffer.from([1, 2, 3]), arr: new Uint8Array([9, 9]) }],
    });
    expect(m.cells[0][0]).toBe('{"k":1}');
    expect(m.cells[0][1]).toBe('[blob]');
    expect(m.cells[0][2]).toBe('[blob]');
  });

  it('빈 rows → headers 유지, cells 빈 배열', () => {
    const m = buildDbTableModel({ columns: ['a', 'b'], rows: [] });
    expect(m.headers).toEqual(['a', 'b']);
    expect(m.cells).toEqual([]);
  });

  it('방어성: columns/rows 비배열·누락 → 빈 모델(throw 금지)', () => {
    // 의도적으로 잘못된 타입 주입(런타임 graceful 검증) → 타입 우회 캐스트.
    const bad = buildDbTableModel as unknown as (x?: unknown) => { headers: string[]; cells: string[][] };
    expect(bad({})).toEqual({ headers: [], cells: [] });
    expect(bad()).toEqual({ headers: [], cells: [] });
    expect(bad({ columns: null, rows: null })).toEqual({ headers: [], cells: [] });
    // columns 는 배열, rows 는 비배열 → headers 유지, cells 빈.
    expect(bad({ columns: ['a'], rows: 'nope' })).toEqual({ headers: ['a'], cells: [] });
  });

  it('방어성: rows 원소가 null → 전 컬럼 빈 문자열(throw 금지)', () => {
    const bad = buildDbTableModel as unknown as (x?: unknown) => { headers: string[]; cells: string[][] };
    const m = bad({ columns: ['a', 'b'], rows: [null, { a: 1 }] });
    expect(m.cells).toEqual([['', ''], ['1', '']]);
  });
});
