/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  followUpForSavedFeatures,
  mergeUnexploredDimensions,
  peerField,
  technologyField,
  traceLinksQuery,
} from './tools';

describe('peer inventory fields', () => {
  it('matches peer, destination and provider fields in any attribute namespace', () => {
    for (const name of [
      'attributes.feature_flag.provider.name',
      'feature_flag.provider_name',
      'peer.service',
      'attributes.server.address',
      'db.system',
      'db.system.name',
      'messaging.destination.name',
      'rpc.service',
      'url.domain',
      'upstream.host',
    ])
      expect(peerField(name)).toBe(true);
  });

  it('ignores identity and unrelated fields', () => {
    for (const name of ['service.name', 'server.port', 'db.statement', 'url.path', 'host.name'])
      expect(peerField(name)).toBe(false);
  });
});

describe('trace links query', () => {
  const window = 'WHERE `@timestamp` >= NOW() - 5 minutes';

  it('groups sorted service sets that share a trace, preferring a coalesced service name', () => {
    expect(
      traceLinksQuery(
        '$.logs',
        ['@timestamp', 'resource.attributes.service.name', 'service.name', 'trace.id'],
        window,
        ''
      )
    ).toBe(
      'FROM $.logs | WHERE `@timestamp` >= NOW() - 5 minutes | WHERE `trace.id` IS NOT NULL | EVAL trace_service = COALESCE(`resource.attributes.service.name`, `service.name`) | WHERE trace_service IS NOT NULL | STATS services = VALUES(trace_service) BY trace_key = `trace.id` | EVAL size = MV_COUNT(services) | WHERE size >= 2 AND size <= 4 | EVAL link = MV_CONCAT(MV_SORT(services), " + ") | STATS traces = COUNT(*) BY link, size | SORT traces DESC | LIMIT 50'
    );
  });

  it('keeps the service scope before the trace filter', () => {
    expect(
      traceLinksQuery(
        '$.logs',
        ['service.name', 'trace_id'],
        window,
        'WHERE `service.name` IN ("a") | '
      )
    ).toContain('| WHERE `service.name` IN ("a") | WHERE `trace_id` IS NOT NULL |');
  });

  it('returns nothing without both a service name and a trace ID column', () => {
    expect(traceLinksQuery('$.logs', ['service.name'], window, '')).toBeUndefined();
    expect(traceLinksQuery('$.logs', ['trace.id'], window, '')).toBeUndefined();
  });
});

describe('saved feature follow-up', () => {
  it('lists records without evidence and emitting services without a filter', () => {
    expect(
      followUpForSavedFeatures([
        { id: 'svc-a', type: 'entity', subtype: 'service', evidence: [] },
        {
          id: 'svc-b',
          type: 'entity',
          subtype: 'service',
          evidence: ['service.name=b'],
          filter: { field: 'service.name', eq: 'b' },
        },
        { id: 'db', type: 'entity', subtype: 'database', evidence: ['db.system=redis'] },
      ] as Parameters<typeof followUpForSavedFeatures>[0])
    ).toMatchObject({ withoutEvidence: ['svc-a'], servicesWithoutFilter: ['svc-a'] });
  });

  it('stays quiet when every saved record is complete', () => {
    expect(
      followUpForSavedFeatures([
        {
          id: 'svc-b',
          type: 'entity',
          subtype: 'service',
          evidence: ['service.name=b'],
          filter: { field: 'service.name', eq: 'b' },
        },
      ] as Parameters<typeof followUpForSavedFeatures>[0])
    ).toBeUndefined();
  });
});

describe('technology inventory fields', () => {
  it('matches SDK, runtime and language identity fields in any attribute namespace', () => {
    for (const name of [
      'telemetry.sdk.language',
      'resource.attributes.telemetry.sdk.language',
      'resource.attributes.telemetry.sdk.name',
      'telemetry.distro.version',
      'process.runtime.name',
      'resource.attributes.process.runtime.version',
      'service.language.name',
      'webengine.name',
    ])
      expect(technologyField(name)).toBe(true);
  });

  it('ignores unrelated fields that only share a prefix', () => {
    for (const name of [
      'telemetry.sdk.languages',
      'process.runtime.name.keyword_count',
      'service.name',
      'process.pid',
      'attributes.language',
    ])
      expect(technologyField(name)).toBe(false);
  });
});

describe('finish dimension review', () => {
  it('carries unexplored dimensions over as gaps without duplicating existing ones', () => {
    expect(
      mergeUnexploredDimensions(
        ['demo: technologies unexplored (no time left)'],
        [
          { namespace: 'demo', dimension: 'entities', status: 'learned', basis: 'inventory' },
          {
            namespace: 'demo',
            dimension: 'technologies',
            status: 'unexplored',
            basis: 'no time left',
          },
          {
            namespace: 'demo',
            dimension: 'infrastructure',
            status: 'unobservable',
            basis: 'no k8s or host fields populated',
          },
          { namespace: 'shop', dimension: 'dependencies', status: 'unexplored', basis: 'not read' },
        ]
      )
    ).toEqual([
      'demo: technologies unexplored (no time left)',
      'shop: dependencies unexplored (not read)',
    ]);
  });

  it('never exceeds the stored gap limit', () => {
    const review = Array.from({ length: 30 }, (_, index) => ({
      namespace: `ns${index}`,
      dimension: 'schema',
      status: 'unexplored',
      basis: 'not read',
    }));
    expect(mergeUnexploredDimensions([], review)).toHaveLength(20);
  });
});
