/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { httpServerMock } from '@kbn/core-http-server-mocks';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import type { StreamQuery } from '@kbn/significant-events-schema';
import type { ExplorationRun } from '../../../common/knowledge_exploration';
import type { RouteHandlerScopedClients } from '../../routes/types';
import type { SignificantEventsServer } from '../../types';
import { ExplorationToolSession } from './tools';
import type { KIBulkOperation } from '../knowledge_indicators/knowledge_indicator_client/types';

it.each(['structured', 'json'])(
  'saves a validated source pipeline and feature IDs as a canonical native query (%s)',
  async (form) => {
    const saved: Array<{ sourceId: string; query: StreamQuery }> = [];
    const client = {
      getFeatures: async () => ({
        hits: [
          {
            id: 'service-api',
            type: 'entity',
            subtype: 'service',
            title: 'API',
            properties: { name: 'api', service_namespace: 'prod' },
            evidence: ['observed'],
            meta: {},
          },
        ],
      }),
      bulkGetQueriesByIds: async () => [],
      upsertQuery: async () => {
        throw new Error('Legacy promotion would demote existing native metric rules');
      },
      bulk: async (sourceId: string, operations: KIBulkOperation[]) => {
        for (const operation of operations) {
          if ('index' in operation && 'query' in operation.index)
            saved.push({ sourceId, query: operation.index.query });
        }
        return { applied: operations.length };
      },
    };
    const source = { id: 'source', enabled: true, view_name: '$.telemetry' } as NightshiftSource;
    const clients = {
      getKnowledgeIndicatorClient: async () => client,
    } as unknown as RouteHandlerScopedClients;
    const run = { id: 'run', written: 0 } as ExplorationRun;
    const session = new ExplorationToolSession(
      {} as SignificantEventsServer,
      clients,
      httpServerMock.createKibanaRequest({ spaceId: 'default' }),
      run,
      [source],
      {},
      new AbortController().signal
    );
    const queries = [
      {
        id: 'api-outcomes',
        title: 'API outcomes',
        description: 'Observed outcomes per service',
        esql: { query: '| STATS operations=COUNT(*) BY service.name' },
        features: ['service-api'],
      },
    ];
    await session.execute('knowledge_indicators', {
      action: 'upsert',
      sourceId: 'source',
      ...(form === 'structured' ? { queries } : { queriesJson: JSON.stringify(queries) }),
    });
    expect(saved).toMatchObject([
      {
        sourceId: 'source',
        query: {
          id: 'api-outcomes',
          type: 'stats',
          rule_backed: false,
          esql: { query: 'FROM $.telemetry | STATS operations=COUNT(*) BY service.name' },
          features: [{ id: 'service-api' }],
        },
      },
    ]);
    expect(run.written).toBe(1);
  }
);

it('preserves an existing native rule reference when its ID is reused for a standalone query', async () => {
  const reference = {
    query: { id: 'native-monitor' },
    rule_backed: true,
    rule_id: 'native-monitor',
  };
  const bulk = jest.fn();
  const session = new ExplorationToolSession(
    {} as SignificantEventsServer,
    {
      getKnowledgeIndicatorClient: async () => ({
        bulkGetQueriesByIds: async () => [reference],
        bulk,
      }),
    } as unknown as RouteHandlerScopedClients,
    httpServerMock.createKibanaRequest({ spaceId: 'default' }),
    { id: 'run', written: 0 } as ExplorationRun,
    [{ id: 'source', enabled: true, view_name: '$.telemetry' } as NightshiftSource],
    {},
    new AbortController().signal
  );
  await expect(
    session.execute('knowledge_indicators', {
      action: 'upsert',
      sourceId: 'source',
      queries: [
        {
          id: 'native-monitor',
          title: 'Measurement',
          description: 'Observed operation count',
          esql: { query: '| STATS n=COUNT(*)' },
        },
      ],
    })
  ).rejects.toThrow('Use monitoring_rules');
  expect(bulk).not.toHaveBeenCalled();
});
