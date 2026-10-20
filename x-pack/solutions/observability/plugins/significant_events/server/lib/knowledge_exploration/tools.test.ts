/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { BaseFeature } from '@kbn/significant-events-schema';
import {
  componentNameProblem,
  documentIdQuery,
  featureNameProblem,
  filterFromEvidence,
  followUpForSavedFeatures,
  languagePatches,
  languagesFromRows,
  languageTechnologies,
  mergeUnexploredDimensions,
  normalizeSubtype,
  peerField,
  technologyField,
  traceLinksQuery,
} from './tools';

describe('round 3 field matchers', () => {
  it('reads frameworks from scope and service.framework fields', () => {
    for (const name of [
      'scope.name',
      'scope.version',
      'service.framework.name',
      'scope.attributes.service.framework.version',
    ])
      expect(technologyField(name)).toBe(true);
    expect(technologyField('attributes.scope.name')).toBe(false);
  });

  it('reads proxy upstream clusters and custom address attributes as peers', () => {
    for (const name of [
      'attributes.upstream.cluster',
      'attributes.quote_service_addr',
      'payment_url',
      'db_host',
      'attributes.gen_ai.system',
      'gen_ai.provider.name',
    ])
      expect(peerField(name)).toBe(true);
    expect(peerField('attributes.client_ip')).toBe(false);
  });
});

describe('subtype contract', () => {
  it('maps finer subtypes onto the shared contract and keeps the original kind', () => {
    expect(normalizeSubtype('infrastructure', 'host', { name: 'h1' })).toEqual({
      subtype: 'operating_system',
      properties: { kind: 'host', name: 'h1' },
    });
    expect(normalizeSubtype('dependency', 'messaging', {}).subtype).toBe('service_dependency');
    expect(normalizeSubtype('schema', 'log_format', {}).subtype).toBe('custom');
    expect(normalizeSubtype('technology', 'runtime', {}).subtype).toBe('programming_language');
  });

  it('leaves contract and unknown subtypes alone', () => {
    expect(normalizeSubtype('entity', 'service', { a: 1 })).toEqual({
      subtype: 'service',
      properties: { a: 1 },
    });
    expect(normalizeSubtype('entity', 'mystery', {}).subtype).toBe('mystery');
    expect(
      normalizeSubtype('technology', 'programming_language', { kind: 'x' }).properties
    ).toEqual({
      kind: 'x',
    });
  });
});

describe('document ID lookup', () => {
  const columns = new Set(['@timestamp', 'service.name', 'feature_flag.provider.name', 'message']);
  const reference =
    'FROM $.view | WHERE `@timestamp` >= NOW() - 5 minutes AND `@timestamp` < NOW() - 60 minutes | STATS count=COUNT(*) BY `service.name`';

  it('re-reads the source FROM target with METADATA _id, the window and the row values', () => {
    expect(
      documentIdQuery(
        'FROM logs-orcabench.otel-default',
        reference,
        {
          'service.name': 'checkout',
          'feature_flag.provider.name': 'flagd',
          count: '12',
          pattern: 'x',
        },
        columns
      )
    ).toBe(
      'FROM logs-orcabench.otel-default METADATA _id | WHERE `@timestamp` >= NOW() - 5 minutes AND `@timestamp` < NOW() - 60 minutes | WHERE TO_STRING(`service.name`) == "checkout" AND TO_STRING(`feature_flag.provider.name`) == "flagd" | KEEP _id | LIMIT 3'
    );
  });

  it('keeps the source pipeline and an existing METADATA clause', () => {
    expect(
      documentIdQuery(
        'FROM logs-a METADATA _index | WHERE x == 1',
        reference,
        { 'service.name': 'a' },
        columns
      )
    ).toMatch(/^FROM logs-a METADATA _index, _id \| WHERE x == 1 \| WHERE `@timestamp`/);
  });

  it('gives up without a FROM source, a time window or a usable column', () => {
    expect(
      documentIdQuery('TS metrics', reference, { 'service.name': 'a' }, columns)
    ).toBeUndefined();
    expect(
      documentIdQuery('FROM a', 'FROM $.view', { 'service.name': 'a' }, columns)
    ).toBeUndefined();
    expect(
      documentIdQuery('FROM a', reference, { pattern: 'x', count: '1' }, columns)
    ).toBeUndefined();
  });
});

describe('language propagation', () => {
  const entity = (name: string, language?: string) =>
    ({
      id: `service-${name}`,
      type: 'entity',
      subtype: 'service',
      title: name,
      description: '',
      properties: { name, ...(language ? { language } : {}) },
      confidence: 80,
      evidence: [],
      tags: [],
    } as unknown as BaseFeature);

  it('writes the technology language onto matching service entities that lack one', () => {
    const patches = languagePatches(
      [
        {
          type: 'technology',
          subtype: 'programming_language',
          title: 'Java services',
          properties: { name: 'Java', services: ['ad', 'kafka'] },
        },
        {
          type: 'technology',
          subtype: 'programming_language',
          title: 'Rust',
          properties: { name: 'Rust', service_name: 'shipping' },
        },
      ],
      [entity('ad'), entity('kafka', 'Java'), entity('shipping'), entity('cart')]
    );
    expect(patches.map((item) => [item.id, item.properties.language])).toEqual([
      ['service-ad', 'Java'],
      ['service-shipping', 'Rust'],
    ]);
  });
});

describe('dependency targets without entities', () => {
  it('lists saved dependency targets that no known entity names', () => {
    const followUp = followUpForSavedFeatures(
      [
        {
          id: 'dep-1',
          type: 'dependency',
          subtype: 'service_dependency',
          evidence: ['x'],
          properties: { source: 'cart', target: 'valkey-cart' },
        },
        {
          id: 'dep-2',
          type: 'dependency',
          subtype: 'service_dependency',
          evidence: ['x'],
          properties: { source: 'checkout', target: 'payment' },
        },
      ] as Parameters<typeof followUpForSavedFeatures>[0],
      [
        {
          id: 'svc-payment',
          type: 'entity',
          subtype: 'service',
          evidence: ['x'],
          filter: { field: 'service.name', eq: 'payment' },
          properties: { name: 'payment' },
        },
      ] as Parameters<typeof followUpForSavedFeatures>[0]
    );
    expect(followUp?.targetsWithoutEntity).toEqual(['valkey-cart']);
  });
});

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

const serviceEntity = (name: string, extra: Partial<BaseFeature> = {}): BaseFeature =>
  ({
    id: `service-${name}`,
    type: 'entity',
    subtype: 'service',
    title: name,
    description: '',
    properties: { name, service_namespace: 'demo' },
    confidence: 90,
    evidence: [`resource.attributes.service.name=${name}`, 'service.namespace=demo'],
    evidence_doc_ids: [`doc-${name}`],
    tags: [],
    ...extra,
  } as BaseFeature);

describe('deterministic entity completion', () => {
  it('reads the language each service reports about itself', () => {
    const languages = languagesFromRows([
      { 'resource.attributes.service.name': 'cart', 'telemetry.sdk.language': 'dotnet' },
      { 'service.name': 'quote', 'resource.attributes.telemetry.sdk.language': 'php' },
      { 'service.name': 'proxy', 'process.runtime.name': 'envoy' },
    ]);
    expect([...languages]).toEqual([
      ['cart', 'dotnet'],
      ['quote', 'php'],
    ]);
  });

  it('builds a filter from the identity equalities in the entity evidence', () => {
    expect(filterFromEvidence(serviceEntity('cart'))).toEqual({
      and: [
        { field: 'resource.attributes.service.name', eq: 'cart' },
        { field: 'service.namespace', eq: 'demo' },
      ],
    });
  });

  it('leaves silent components, existing filters and non-services alone', () => {
    expect(filterFromEvidence(serviceEntity('valkey', { evidence: ['db.system=redis'] }))).toBe(
      undefined
    );
    expect(
      filterFromEvidence(serviceEntity('cart', { filter: { field: 'service.name', eq: 'cart' } }))
    ).toBe(undefined);
    expect(filterFromEvidence(serviceEntity('cart', { subtype: 'database' }))).toBe(undefined);
  });

  it('writes a programming language KI for languages only recorded on entities', () => {
    const features = [
      serviceEntity('cart', { properties: { name: 'cart', language: 'dotnet' } }),
      serviceEntity('accounting', { properties: { name: 'accounting', language: 'dotnet' } }),
      serviceEntity('quote', { properties: { name: 'quote', language: 'php' } }),
      {
        ...serviceEntity('php'),
        id: 'technology-php',
        type: 'technology',
        subtype: 'programming_language',
        properties: { name: 'PHP' },
      } as BaseFeature,
    ];
    const derived = languageTechnologies(features);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({
      id: 'technology-language-dotnet',
      subtype: 'programming_language',
      properties: { name: 'dotnet', services: ['accounting', 'cart'] },
      evidence_doc_ids: ['doc-cart', 'doc-accounting'],
    });
  });
});

describe('observed services follow-up', () => {
  it('lists services seen emitting that have no entity yet', () => {
    expect(
      followUpForSavedFeatures(
        [serviceEntity('cart', { filter: { field: 'service.name', eq: 'cart' } })],
        [],
        ['cart', 'frontend']
      )
    ).toMatchObject({ servicesWithoutEntity: ['frontend'] });
  });
});

describe('component names', () => {
  it('accepts identifiers', () => {
    for (const name of ['valkey-cart', 'valkey', 'postgresql', 'flagd', 'gpt-4o', 'quote'])
      expect(componentNameProblem(name)).toBeUndefined();
  });

  it('rejects addresses, placeholders and descriptive phrases', () => {
    for (const name of [
      '172.18.0.27:8080',
      '10.0.0.1',
      'unspecified database',
      'unknown',
      'Valkey cart cache',
      'Valkey cart store',
    ])
      expect(componentNameProblem(name)).toBeDefined();
  });

  it('checks entity names and dependency endpoints only', () => {
    expect(
      featureNameProblem({
        type: 'dependency',
        properties: { source: 'cart', target: 'Valkey cart store' },
      })
    ).toBeDefined();
    expect(featureNameProblem({ type: 'entity', properties: { name: 'valkey' } })).toBeUndefined();
    expect(
      featureNameProblem({ type: 'technology', properties: { name: 'ASP.NET Core' } })
    ).toBeUndefined();
  });
});
