/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { hasForbiddenMonitoringOperations } from './source_pipeline';

describe('monitoring source pipeline scope', () => {
  it.each([
    'WHERE message LIKE "*schedule lookup timeout, returning cached*"',
    'WHERE message LIKE "*from server; lookup -- fallback /* marker*"',
    "WHERE message == 'lookup from another component'",
    'WHERE `lookup` == "observed-value"',
    'WHERE message RLIKE "escaped \\"lookup\\" text"',
    'EVAL log=TO_STRING(message) | STATS metric_value=COUNT(*) BY bucket=BUCKET(@timestamp,1 minute)',
  ])('allows source-local content: %s', (pipeline) => {
    expect(hasForbiddenMonitoringOperations(pipeline)).toBe(false);
  });

  it.each([
    'FROM other-source',
    'ROW message="example"',
    'WHERE message == "safe" | LOOKUP JOIN other ON key',
    'ENRICH outside-policy',
    'FORK (WHERE value > 0)',
    'INLINE STATS count=COUNT(*)',
    'COMPLETION prompt="external call"',
    'CHANGE_POINT value',
    'WHERE message == "safe"; FROM other',
    'WHERE message == "safe" /* actual comment */',
    'WHERE message == "safe" -- actual comment',
  ])('rejects external operations and actual comments: %s', (pipeline) => {
    expect(hasForbiddenMonitoringOperations(pipeline)).toBe(true);
  });
});
