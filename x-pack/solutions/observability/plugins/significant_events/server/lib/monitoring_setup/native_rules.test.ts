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
import { MonitoringToolSession } from './tools';

it.each([false, true])(
  'persists a native monitor and rolls it back if its knowledge reference fails (failure=%s)',
  async (failReference) => {
    const source = {
      id: 'source',
      enabled: true,
      view_name: '$.source',
      esql_updated_at: 'revision',
    } as NightshiftSource;
    const nativeRules = new Map<string, object>();
    const rules = {
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
            properties: { name: 'checkout', service_namespace: 'shop' },
          },
        ],
      }),
      getSourceToQueryLinksMap: async () => ({}),
      bulkGetQueriesByIds: async () => [],
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
          query: async () => ({
            columns: [
              { name: 'bucket', type: 'date' },
              { name: 'metric_value', type: 'long' },
              { name: 'service.name', type: 'keyword' },
              { name: 'service.namespace', type: 'keyword' },
            ],
            values: [['2026-11-20T10:00:00Z', 7, 'checkout', 'shop']],
          }),
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
      title: 'Checkout failures',
      description: 'Failed checkout operations per minute',
      reason: 'Observed failed checkout operations',
      mode: 'metric',
      pipeline:
        'STATS metric_value=COUNT(*) BY bucket=BUCKET(@timestamp, 1 minute), service.name, service.namespace',
      featureIds: ['checkout'],
    });
    if (failReference) {
      await expect(result).rejects.toThrow('Knowledge reference could not be persisted');
      expect(nativeRules.size).toBe(0);
      expect(run.written).toBe(0);
    } else {
      await expect(result).resolves.toMatchObject({ native: true, action: 'created' });
      expect(nativeRules.size).toBe(1);
      expect(references).toHaveLength(1);
      expect(run.written).toBe(1);
    }
  }
);
