/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { httpServerMock } from '@kbn/core-http-server-mocks';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import type { ExplorationRun } from '../../../common/knowledge_exploration';
import type { RouteHandlerScopedClients } from '../../routes/types';
import type { SignificantEventsServer } from '../../types';
import { ExplorationToolSession } from '../knowledge_exploration/tools';
import { MonitoringToolSession } from './tools';

it.each([
  { failReference: false, mode: 'metric' },
  { failReference: true, mode: 'metric' },
  { failReference: false, mode: 'count' },
])(
  'persists a native $mode monitor with service ownership and rolls back a failed reference ($failReference)',
  async ({ failReference, mode }) => {
    const source = {
      id: 'source',
      enabled: true,
      view_name: '$.source',
      esql_updated_at: 'revision',
    } as NightshiftSource;
    const pipeline =
      mode === 'count'
        ? 'WHERE http.status >= 500'
        : 'STATS metric_value=COUNT(*) BY bucket=BUCKET(@timestamp, 1 minute), service.name, service.namespace';
    const nativeRules = new Map<string, object>();
    const rules = {
      getRule: async ({ id }: { id: string }) => nativeRules.get(id),
      findRules: async () => ({ items: [...nativeRules.values()], total: nativeRules.size }),
      createRule: async ({ data }: { data: { id: string } }) => {
        nativeRules.set(data.id, data);
        return { id: data.id };
      },
      bulkDeleteRules: async ({ ids }: { ids: string[] }) => {
        ids.forEach((id) => nativeRules.delete(id));
        return { errors: [] };
      },
    };
    const references: object[] = [];
    const ki = {
      getFeatures: async () => ({
        hits: [
          {
            id: 'checkout',
            type: 'entity',
            subtype: 'service',
            properties: { service_name: 'checkout', service_namespace: 'shop' },
          },
        ],
      }),
      getSourceToQueryLinksMap: async () => ({}),
      bulkGetQueriesByIds: async (_sourceId: string, [id]: string[]) =>
        nativeRules.has(id)
          ? [
              {
                rule_id: id,
                query: {
                  esql: { query: `FROM $.source | ${pipeline}` },
                  features: [{ id: 'checkout' }],
                },
              },
            ]
          : [],
      bulk: async (_sourceId: string, operations: object[]) => {
        if (failReference) throw new Error('Knowledge reference could not be persisted');
        references.push(...operations);
        return { applied: operations.length };
      },
    };
    const clients = {
      getSignificantEventsAlertingContext: async () => ({ alertingV2RulesClient: rules }),
      getKnowledgeIndicatorClient: async () => ki,
      sourcesClient: { get: async () => ({ source }) },
      streamDataEsClient: {
        esql: {
          query: async ({ query }: { query: string }) =>
            query.includes('sample_matches')
              ? {
                  columns: [{ name: 'sample_matches', type: 'long' }],
                  values: [[4]],
                }
              : {
                  columns: [
                    { name: 'bucket', type: 'date' },
                    { name: 'metric_value', type: 'long' },
                    { name: 'service.name', type: 'keyword' },
                    { name: 'service.namespace', type: 'keyword' },
                  ],
                  values: [['2026-11-20T10:00:00Z', 7, 'checkout', 'shop']],
                },
        },
      },
    } as unknown as RouteHandlerScopedClients;
    const run = { id: 'run', written: 0 } as ExplorationRun;
    const session = new MonitoringToolSession(
      {} as SignificantEventsServer,
      clients,
      httpServerMock.createKibanaRequest({ spaceId: 'default' }),
      run,
      [source],
      {},
      new AbortController().signal
    );
    const result = session.execute('monitoring_rules', {
      action: 'upsert',
      sourceId: 'source',
      slug: 'checkout-errors',
      everyMinutes: 2,
      title: 'Checkout failures',
      description: 'Failed checkout operations per minute',
      reason: 'Observed failed checkout operations',
      ...(failReference ? { mode: 'metric' } : {}),
      pipeline,
      featureIds: ['checkout'],
    });
    if (failReference) {
      await expect(result).rejects.toThrow('Knowledge reference could not be persisted');
      expect(nativeRules.size).toBe(0);
      expect(run.written).toBe(0);
    } else {
      await expect(result).resolves.toMatchObject({ native: true, action: 'created' });
      expect(nativeRules.size).toBe(1);
      await expect(
        session.execute('monitoring_rules', {
          action: 'validate',
          sourceId: 'source',
          ruleId: [...nativeRules.keys()][0],
          reason: 'Recheck the installed rule at its original cadence',
        })
      ).resolves.toMatchObject({ valid: true, mode, featureIds: ['checkout'] });
      expect(references).toHaveLength(1);
      expect(run.written).toBe(1);
    }
  }
);

it('replays numeric, keyword and null evidence as bound parameters for a native count predicate', async () => {
  const query = jest
    .fn()
    .mockResolvedValue({ columns: [{ name: 'n', type: 'long' }], values: [[1]] });
  const clients = {
    getSignificantEventsAlertingContext: async () => ({}),
    getKnowledgeIndicatorClient: async () => ({
      getFeatures: async () => ({ hits: [{ id: 'gateway', type: 'entity', properties: {} }] }),
    }),
    streamDataEsClient: { esql: { query } },
  } as unknown as RouteHandlerScopedClients;
  const source = { id: 'trace', enabled: true, view_name: '$.trace' } as NightshiftSource;
  const run = { id: 'run', written: 0 } as ExplorationRun;
  const server = {} as SignificantEventsServer;
  const request = httpServerMock.createKibanaRequest(),
    signal = new AbortController().signal;
  const reads = new ExplorationToolSession(server, clients, request, run, [source], {}, signal);
  jest.spyOn(reads, 'getEvidenceRows').mockReturnValue([
    [
      { name: 'http.status', type: 'long', value: 503 },
      { name: 'label', type: 'keyword', value: '503' },
      { name: 'cause', type: 'keyword', value: null },
    ],
  ]);
  const session = new MonitoringToolSession(
    server,
    clients,
    request,
    run,
    [source],
    {},
    signal,
    reads
  );
  expect(
    await session.execute('monitoring_rules', {
      action: 'validate',
      sourceId: source.id,
      featureIds: ['gateway'],
      mode: 'count',
      positiveEvidenceRefs: ['r1'],
      pipeline: 'WHERE `http.status` >= 500',
      reason: 'Validate observed failure',
    })
  ).toMatchObject({ positiveExamplesMatched: 1, valid: true });
  expect(query.mock.lastCall[0]).toMatchObject({
    query: expect.stringContaining('`http.status`=TO_LONG(?p0)'),
    params: [{ p0: 503 }, { p1: '503' }, { p2: null }],
  });
});

it('baselines parsed row outcomes without installing a count rule or accepting partial data', async () => {
  const query = jest.fn().mockResolvedValue({
    columns: [{ name: 'bucket' }, { name: 'metric_value' }],
    values: [['2026-11-25T18:11:00Z', 4]],
  });
  const session = new MonitoringToolSession(
    {} as SignificantEventsServer,
    {
      getSignificantEventsAlertingContext: async () => ({}),
      getKnowledgeIndicatorClient: async () => ({}),
      streamDataEsClient: { esql: { query } },
    } as unknown as RouteHandlerScopedClients,
    httpServerMock.createKibanaRequest(),
    { id: 'run', written: 0 } as ExplorationRun,
    [{ id: 'source', enabled: true, view_name: '$.source' } as NightshiftSource],
    {},
    new AbortController().signal
  );
  const args = {
    action: 'baseline',
    mode: 'count',
    sourceId: 'source',
    reason: 'Measure the terminal outcome.',
    pipeline:
      '| WHERE message IS NOT NULL | EVAL outcome=JSON_EXTRACT(message,"outcome") | WHERE outcome == "failed"',
  };
  expect(await session.execute('monitoring_rules', args)).toMatchObject({
    mode: 'count',
    query: expect.stringContaining('WHERE outcome == "failed" | STATS metric_value=COUNT(*)'),
  });
  await expect(
    session.execute('monitoring_rules', { ...args, action: 'validate', featureIds: ['service'] })
  ).rejects.toThrow('Inline derived expressions');
  query.mockResolvedValue({ is_partial: true });
  await expect(session.execute('monitoring_rules', args)).rejects.toThrow('partial data');
});

it.each([
  'STATS bucket=BUCKET(@timestamp,1 minute), metric_value=COUNT(*) BY bucket, service.name',
  'STATS metric_value=COUNT(*) BY service.name',
])('returns an actionable repair for a malformed metric baseline: %s', async (pipeline) => {
  const query = jest.fn();
  const session = new MonitoringToolSession(
    {} as SignificantEventsServer,
    {
      getSignificantEventsAlertingContext: async () => ({}),
      getKnowledgeIndicatorClient: async () => ({}),
      streamDataEsClient: { esql: { query } },
    } as unknown as RouteHandlerScopedClients,
    httpServerMock.createKibanaRequest(),
    { id: 'run', written: 0 } as ExplorationRun,
    [{ id: 'source', enabled: true, view_name: '$.source' } as NightshiftSource],
    {},
    new AbortController().signal
  );
  await expect(
    session.execute('monitoring_rules', {
      action: 'baseline',
      sourceId: 'source',
      mode: 'metric',
      pipeline,
      reason: 'Evaluate observed failures',
    })
  ).rejects.toThrow('BY bucket=BUCKET(@timestamp, 1 minute)');
  expect(query).not.toHaveBeenCalled();
});
