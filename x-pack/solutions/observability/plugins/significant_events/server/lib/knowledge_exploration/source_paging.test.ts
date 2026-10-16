/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { pageSourceFields } from './source_paging';

describe('filtered source field paging', () => {
  it('returns actual matching peer fields when an old offset belongs to another filter', () => {
    expect(pageSourceFields(['destination.address', 'server.address'], 30, 40)).toEqual({
      page: ['destination.address', 'server.address'],
      offset: 0,
      requestedOffset: 30,
      offsetReset: true,
      hasMore: false,
      nextOffset: null,
    });
  });
  it('preserves normal paging and a genuinely empty filtered result', () => {
    expect(pageSourceFields(['a', 'b', 'c'], 1, 1)).toMatchObject({
      page: ['b'],
      offset: 1,
      hasMore: true,
      nextOffset: 2,
      offsetReset: false,
    });
    expect(pageSourceFields([], 0, 20)).toMatchObject({
      page: [],
      hasMore: false,
      nextOffset: null,
    });
  });
});
