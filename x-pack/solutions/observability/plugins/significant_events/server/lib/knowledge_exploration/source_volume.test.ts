/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  explorationWindowSchema,
  sourceTimeWindow,
  summarizeVolume,
  volumeQuery,
} from './source_volume';
import { readEsqlGuide } from './esql_guide';

describe('agent-controlled source exploration', () => {
  it('requires an explicit duration rather than silently scanning a day', () => {
    expect(explorationWindowSchema.safeParse({}).success).toBe(false);
    expect(explorationWindowSchema.parse({ lookbackMinutes: 2 })).toEqual({
      lookbackMinutes: 2,
      endOffsetMinutes: 0,
    });
    for (const lookbackMinutes of [0, -1, 1.5, 5256001]) {
      expect(explorationWindowSchema.safeParse({ lookbackMinutes }).success).toBe(false);
    }
  });

  it('samples the requested older interval with both bounds', () => {
    expect(sourceTimeWindow(5, 120)).toBe(
      'WHERE `@timestamp` >= NOW() - 125 minutes AND `@timestamp` < NOW() - 120 minutes'
    );
    expect(sourceTimeWindow(2, 0)).toBe('WHERE `@timestamp` >= NOW() - 2 minutes');
  });

  it('caps aggregation input before counting and keeps the configured source view', () => {
    expect(volumeQuery('$.nightshift.sources.default.logs', 1, 0)).toBe(
      'FROM $.nightshift.sources.default.logs | WHERE `@timestamp` >= NOW() - 1 minutes | LIMIT 10001 | STATS documents=COUNT(*)'
    );
  });

  it('distinguishes exact-window rates from capped lower bounds without claiming coverage', () => {
    expect(summarizeVolume(120, 2, 123)).toMatchObject({
      documents: 120,
      documentsPerSecond: 1,
      countRelation: 'eq',
      rateRelation: 'window_average',
      elapsedMs: 123,
      coverageComplete: false,
    });
    expect(summarizeVolume(10001, 1, 600)).toMatchObject({
      documents: 10000,
      countRelation: 'gte',
      rateRelation: 'lower_bound',
      coverageComplete: false,
    });
    expect(summarizeVolume(0, 1, 50).coverageComplete).toBe(false);
  });

  it('provides focused, bounded recipes and rejects unknown topics', () => {
    for (const topic of ['volume', 'schema', 'patterns', 'relationships', 'metrics', 'errors']) {
      const guide = readEsqlGuide({ topic });
      expect(guide.topic).toBe(topic);
      expect(guide.guidance.length).toBeLessThan(1500);
      expect(guide.reference).toMatch(/^https:\/\/www.elastic.co\//);
    }
    expect(() => readEsqlGuide({ topic: 'invented' })).toThrow();
  });
});
