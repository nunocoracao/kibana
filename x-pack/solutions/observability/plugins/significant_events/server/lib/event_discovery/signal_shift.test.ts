/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { detectSeriesShift } from './signal_shift';

describe('relative native signal shifts', () => {
  it('exposes an error-ratio rise below one absolute unit', () => {
    expect(detectSeriesShift([0, 0, 0, 0.8, 0.8])).toEqual({
      reference: 0,
      newest: 0.8,
      ratio: null,
    });
  });
  it('uses relative changes for fractional metrics', () => {
    expect(detectSeriesShift([0.1, 0.1, 0.1, 0.4, 0.4])?.ratio).toBe(4);
    expect(detectSeriesShift([0.6, 0.6, 0.6, 0.1, 0.1])?.ratio).toBe(0.17);
  });
  it('does not flag a stable zero or modest numerical variation', () => {
    expect(detectSeriesShift([0, 0, 0, 0, 0])).toBeUndefined();
    expect(detectSeriesShift([0.5, 0.5, 0.5, 0.52, 0.52])).toBeUndefined();
  });
  it('retains hints for count-sized measurements', () => {
    expect(detectSeriesShift([1000, 1000, 1000, 1700, 1700])?.ratio).toBe(1.7);
  });
  it('does not invent a reference for sparse history', () => {
    expect(detectSeriesShift([0, 0, 0.8, 0.8])).toBeUndefined();
  });
});
