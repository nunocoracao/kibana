/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { httpServerMock } from '@kbn/core-http-server-mocks';
import { KnowledgeExplorationService } from './service';
import { resetMonitoringRules } from '../monitoring_setup/tools';
import { resetDiscoveryEvents } from '../event_discovery/tools';
import { PROBLEM_AGENT_KNOWLEDGE_MARKER } from './tools';

jest.mock('../monitoring_setup/tools', () => ({
  ...jest.requireActual('../monitoring_setup/tools'),
  resetMonitoringRules: jest.fn(),
}));
jest.mock('../event_discovery/tools', () => ({
  ...jest.requireActual('../event_discovery/tools'),
  resetDiscoveryEvents: jest.fn(),
}));

it.each(['knowledge', 'rules', 'events'] as const)('deletes only %s outputs', async (category) => {
  jest.clearAllMocks();
  jest.mocked(resetMonitoringRules).mockResolvedValue({ features: 3 });
  jest.mocked(resetDiscoveryEvents).mockResolvedValue({ features: 4 });
  const bulk = jest.fn(async (_source: string, operations: unknown[]) => ({
    applied: operations.length,
  }));
  const legacyId = 'nightshift-problem-monitor-0123456789abcdef01234567';
  const client = {
    bulk,
    async *liveRevisionPages() {
      yield [
        {
          type: 'feature',
          id: 'owned',
          'source.id': 'logs',
          feature: { meta: { problem_agent_owner: 'problem-agent' } },
        },
        { type: 'feature', id: 'user', 'source.id': 'logs', feature: {} },
      ];
      yield [
        {
          type: 'query',
          id: 'standalone',
          'source.id': 'metrics',
          query: { rule_backed: false },
          evidence: [PROBLEM_AGENT_KNOWLEDGE_MARKER],
        },
        {
          type: 'query',
          id: legacyId,
          'source.id': 'metrics',
          query: { rule_backed: false, rule_id: legacyId },
        },
        {
          type: 'query',
          id: legacyId + '0',
          'source.id': 'metrics',
          query: { rule_backed: false, rule_id: legacyId + '0' },
        },
        {
          type: 'query',
          id: 'user-query',
          'source.id': 'metrics',
          query: { rule_backed: false, rule_id: legacyId },
        },
        {
          type: 'query',
          id: 'backed',
          'source.id': 'metrics',
          query: { rule_backed: true },
          evidence: [PROBLEM_AGENT_KNOWLEDGE_MARKER],
        },
      ];
    },
  };
  const service = new KnowledgeExplorationService(
    jest.fn(),
    jest.fn().mockResolvedValue({ getKnowledgeIndicatorClient: async () => client }),
    jest.fn()
  );
  const store = { getState: async () => ({ state: {}, version: '1' }), setState: jest.fn() };
  Object.assign(service, { store: () => store });
  const result = await service.resetOutputs(httpServerMock.createKibanaRequest(), [category]);
  expect(result).toEqual({
    knowledge: category === 'knowledge' ? 3 : 0,
    monitors: category === 'rules' ? 3 : 0,
    events: category === 'events' ? 4 : 0,
  });
  expect(resetMonitoringRules).toHaveBeenCalledTimes(category === 'rules' ? 1 : 0);
  expect(resetDiscoveryEvents).toHaveBeenCalledTimes(category === 'events' ? 1 : 0);
  expect(bulk.mock.calls).toEqual(
    category === 'knowledge'
      ? [
          ['logs', [{ delete: { type: 'feature', id: 'owned' } }]],
          [
            'metrics',
            [
              { delete: { type: 'query', id: 'standalone' } },
              { delete: { type: 'query', id: legacyId } },
            ],
          ],
        ]
      : []
  );
});
