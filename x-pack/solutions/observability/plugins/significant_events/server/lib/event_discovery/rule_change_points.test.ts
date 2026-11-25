/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { KibanaRequest } from '@kbn/core/server';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import type { RouteHandlerScopedClients } from '../../routes/types';
import { inspectRuleChangePoints } from './rule_change_points';

const minute = 60000;
const end = Date.parse('2026-11-24T12:00:00Z');
const start = end - 60 * minute;
const source = { id: 's', enabled: true, view_name: '$.logs' } as NightshiftSource;
const search = jest.fn(),
  getRule = jest.fn();
const clients = {
  scopedClusterClient: { asCurrentUser: { search } },
  getSignificantEventsAlertingContext: async () => ({ alertingV2RulesClient: { getRule } }),
} as unknown as RouteHandlerScopedClients;
const rule = {
  query: { base: 'FROM "$.logs" | STATS n=COUNT(*)' },
  metadata: {},
  grouping: { fields: ['bucket', 'service.name'] },
};
const selected = {
  ruleId: 'r',
  kind: 'signal' as const,
  sourceIds: ['s'],
  dimensions: { 'service.name': 'api', 'service.namespace': 'prod' },
};
const inspect = (params: object = {}) =>
  inspectRuleChangePoints(
    clients,
    { spaceId: 'space' } as KibanaRequest,
    [source],
    params,
    new AbortController().signal,
    (ref) => (ref === 'signal-1' ? selected : undefined)
  );
const args = { ruleId: 'r', sourceId: 's', groupFiltersJson: '{"service.name":"api"}' };
const response = (offsets: number[], type: object = { stationary: {} }) => ({
  _shards: { failed: 0 },
  timed_out: false,
  aggregations: {
    over_time: {
      buckets: offsets.map((i) => {
        const key = start + i * minute;
        return {
          key,
          doc_count: 2,
          last_write: { value: key + 10 },
          latest: { top: [{ sort: [key + 10], metrics: { discovery_value: i } }] },
        };
      }),
    },
    change_points: { type, bucket: { key: start + 15 * minute } },
  },
});
const offsets = Array.from({ length: 25 }, (_, i) => i);
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(end + 45000);
  getRule.mockReset().mockResolvedValue(rule);
  search.mockReset().mockResolvedValue(response(offsets));
});
afterEach(() => jest.restoreAllMocks());

it('counts every missing complete minute and keeps the series opt-in', async () => {
  const result = await inspect(args);
  expect(result).toMatchObject({
    status: 'no_change_detected',
    history: {
      observedBuckets: 25,
      missingBuckets: 35,
      leadingMissingMinutes: 0,
      internalMissingMinutes: 0,
      trailingMissingMinutes: 35,
      lastMeasurementAt: new Date(start + 24 * minute).toISOString(),
    },
  });
  expect(result).not.toHaveProperty('series');
  const detail = await inspect({ ...args, includeSeries: true });
  expect(detail.series).toHaveLength(60);
  expect((detail.series as Array<{ value: number | null }>)[59].value).toBeNull();
});
it('binds a run-local reference to its rule and all emitted dimensions', async () => {
  search.mockResolvedValue(response(offsets, { dip: { change_point: 15 } }));
  expect(await inspect({ signalRef: 'signal-1' })).toMatchObject({
    status: 'change_detected',
    changeType: 'dip',
    direction: 'down',
    changedAt: new Date(start + 15 * minute).toISOString(),
    groups: selected.dimensions,
  });
  expect(search.mock.calls[0][0].query.bool.filter).toContainEqual({
    term: { 'data.service.namespace': 'prod' },
  });
  await expect(inspect({ signalRef: 'unknown' })).rejects.toThrow('signalRef');
});
it('reports direction from the observed levels on both sides of a step', async () => {
  search.mockResolvedValue(response(offsets, { step_change: { change_point: 15 } }));
  expect(await inspect(args)).toMatchObject({
    status: 'change_detected',
    direction: 'up',
    level: { beforeMean: 7, afterMean: 19.5 },
  });
});
it.each(['FROM $.logs_archive', 'FROM other | EVAL label="$.logs"', 'FROM $.logs, unrelated'])(
  'does not infer scope from %s',
  async (base) => {
    getRule.mockResolvedValue({ ...rule, query: { base } });
    await expect(inspect(args)).rejects.toThrow('exact FROM');
    expect(search).not.toHaveBeenCalled();
  }
);
it('names the required group and rejects a short window before searching', async () => {
  expect(await inspect({ sourceId: 's', ruleId: 'r' })).toMatchObject({
    status: 'indeterminable',
    requiredDimensions: ['service.name'],
  });
  expect(await inspect({ ...args, lookbackMinutes: 20 })).toMatchObject({
    status: 'indeterminable',
  });
  expect(search).not.toHaveBeenCalled();
});
it.each([{ timed_out: true }, { _shards: { failed: 1 } }])(
  'discards partial results',
  async (partial) => {
    search.mockResolvedValue({ ...response(offsets), ...partial });
    expect(await inspect(args)).toMatchObject({
      status: 'indeterminable',
      reason: expect.stringContaining('partial'),
    });
  }
);
it('counts numeric latest revisions, distinguishes internal and edge gaps and handles empty history', async () => {
  const data = response(offsets.map((i) => i + 5));
  data.aggregations.over_time.buckets[2].last_write.value++;
  search.mockResolvedValue(data);
  expect(await inspect(args)).toMatchObject({
    status: 'indeterminable',
    history: {
      observedBuckets: 24,
      leadingMissingMinutes: 5,
      internalMissingMinutes: 1,
      trailingMissingMinutes: 30,
    },
  });
  search.mockResolvedValue(response([]));
  expect(await inspect(args)).toMatchObject({
    status: 'indeterminable',
    history: { observedBuckets: 0, missingBuckets: 60, lastMeasurementAt: null },
  });
});
