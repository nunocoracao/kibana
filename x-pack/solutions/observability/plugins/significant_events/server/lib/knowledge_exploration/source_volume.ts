/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';

export const explorationWindowSchema = z.object({
  lookbackMinutes: z.number().int().min(1).max(5256000),
  endOffsetMinutes: z.number().int().min(0).max(5256000).default(0),
});
const VOLUME_CAP = 10000;

export const sourceTimeWindow = (lookbackMinutes: number, endOffsetMinutes: number): string => {
  explorationWindowSchema.parse({ lookbackMinutes, endOffsetMinutes });
  const lower = `WHERE \`@timestamp\` >= NOW() - ${lookbackMinutes + endOffsetMinutes} minutes`;
  return endOffsetMinutes
    ? `${lower} AND \`@timestamp\` < NOW() - ${endOffsetMinutes} minutes`
    : lower;
};

export const volumeQuery = (
  sourceView: string,
  lookbackMinutes: number,
  endOffsetMinutes: number
): string =>
  `FROM ${sourceView} | ${sourceTimeWindow(lookbackMinutes, endOffsetMinutes)} | LIMIT ${
    VOLUME_CAP + 1
  } | STATS documents=COUNT(*)`;

export const summarizeVolume = (count: number, lookbackMinutes: number, elapsedMs: number) => ({
  documents: Math.min(count, VOLUME_CAP),
  countRelation: count > VOLUME_CAP ? 'gte' : 'eq',
  documentsPerSecond: Math.min(count, VOLUME_CAP) / (lookbackMinutes * 60),
  rateRelation: count > VOLUME_CAP ? 'lower_bound' : 'window_average',
  elapsedMs,
  coverageComplete: false,
  note: 'Source-wide volume probe only; no service filter or knowledge completeness claim. The cap bounds rows entering COUNT, not source-view work or remote latency. If capped or slow, narrow or sample separate earlier intervals before parsing/aggregating. A quiet interval does not establish absence elsewhere.',
});
