/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Feature } from '@kbn/significant-events-schema';
import { signalEntrySchema } from '@kbn/significant-events-schema';
import { buildEventQuerySignals, resolveEventFeatures } from './event_evidence';

it('stores executable query signals, frozen windows and actual result rows without a fabricated firing', () => {
  const checkedAt = Date.now();
  const check = {
    sourceId: 'logs',
    checkedAt,
    query:
      'FROM $.logs | WHERE `@timestamp` >= NOW() - 3 minutes | EVAL literal="NOW()" | STATS failures=COUNT(*)',
    row: { failures: '7' },
  };
  const signals = buildEventQuerySignals(
    [check, { ...check, row: { failures: '8' } }],
    'Observed failed operations'
  );
  expect(signals).toHaveLength(1);
  expect(signalEntrySchema.parse(signals[0])).toMatchObject({
    type: 'query',
    verdict: 'inconclusive',
    evidence: {
      result: 'found',
      time_range: {
        from: new Date(checkedAt - 180000).toISOString(),
        to: new Date(checkedAt).toISOString(),
      },
    },
  });
  expect(signals[0].evidence?.esql_query).toContain(
    `TO_DATETIME("${new Date(checkedAt).toISOString()}")`
  );
  expect(signals[0].evidence?.esql_query).toContain('literal="NOW()"');
  expect(signals[0].description).toContain('"failures":"7"');
  expect(signals[0].metadata).not.toHaveProperty('detection_id');
  expect(signals[0].metadata.rule_uuid).toBeUndefined();
});

it('requires unambiguous source and namespace when resolving affected entities and respects explicit scope', () => {
  const make = (id: string, source: string, namespace: string) =>
    ({
      id,
      uuid: id,
      source_id: source,
      type: 'entity',
      subtype: 'service',
      description: '',
      confidence: 95,
      properties: { name: 'gateway', service_namespace: namespace },
    } as Feature);
  const features = [
    make('one', 'logs', 'one'),
    make('two', 'logs', 'two'),
    make('other-source', 'metrics', 'one'),
  ];
  const check = {
    sourceId: 'logs',
    query: '',
    checkedAt: Date.now(),
    row: { 'service.name': 'gateway' },
  };
  expect(resolveEventFeatures(features, [check], [])).toEqual([]);
  expect(
    resolveEventFeatures(
      features,
      [{ ...check, row: { ...check.row, 'service.namespace': 'one' } }],
      []
    ).map((feature) => feature.id)
  ).toEqual(['one']);
  expect(
    resolveEventFeatures(
      features,
      [{ ...check, row: { ...check.row, 'service.namespace': 'one' } }],
      ['two']
    ).map((feature) => feature.id)
  ).toEqual(['two']);
});

it('keeps an older comparison window contextual', () => {
  const signal = buildEventQuerySignals(
    [
      {
        sourceId: 'logs',
        checkedAt: Date.now(),
        query: 'FROM logs | WHERE `@timestamp` >= NOW() - 13 minutes',
        row: { failures: '2' },
      },
    ],
    'Comparison baseline'
  )[0];
  expect(signal.verdict).toBe('inconclusive');
  expect(signal.description).toContain('Historical comparison');
});

it('keeps rows from other services contextual instead of confirming the selected affected service', () => {
  const check = {
    sourceId: 'logs',
    checkedAt: Date.now(),
    query:
      'FROM $.logs | WHERE `@timestamp` >= NOW() - 2 minutes | STATS failures=COUNT(*) BY service.name',
    outcome: {
      sourceId: 'logs',
      entityId: 'api',
      operation: 'serve',
      condition: 'failure',
      failedField: 'failures',
      healthyField: 'healthy',
      failed: 3,
      healthy: 12,
    },
    row: { 'service.name': 'api', 'service.namespace': 'production', failures: '3' },
  };
  const affected: Feature = {
    id: 'api',
    uuid: 'api',
    description: '',
    confidence: 95,
    source_id: 'logs',
    type: 'entity',
    subtype: 'service',
    properties: { name: 'api', service_namespace: 'production' },
  };
  const signals = buildEventQuerySignals(
    [check, { ...check, row: { ...check.row, 'service.name': 'worker', failures: '8' } }],
    'API failures',
    [affected]
  );
  expect(signals).toHaveLength(2);
  expect(signals[0].verdict).toBe('confirms');
  expect(signals[0].description).not.toContain('worker');
  expect(signals[1].verdict).toBe('inconclusive');
  expect(signals[1].description).toContain('outside the affected service scope');
});
