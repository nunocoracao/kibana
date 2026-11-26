/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { getEsqlColumnSchema } from '@kbn/ai-tools';
import { z } from '@kbn/zod/v4';
import { fromJSONSchema } from '@kbn/zod/v4/from_json_schema';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import type { ExplorationRun } from '../../../common/knowledge_exploration';
import type { RouteHandlerScopedClients } from '../../routes/types';
import type { SignificantEventsServer } from '../../types';
import { ExplorationToolSession, explorationTools } from './tools';

jest.mock('@kbn/ai-tools', () => ({
  ...jest.requireActual('@kbn/ai-tools'),
  getEsqlColumnSchema: jest.fn(),
}));

const columns = [
  { name: '@timestamp', type: 'date' },
  { name: 'service.name', type: 'keyword' },
  { name: 'service.namespace', type: 'keyword' },
];

const source: NightshiftSource = {
  id: 'source',
  enabled: true,
  slug: 'telemetry',
  title: 'Telemetry',
  description: 'Production application telemetry',
  tags: ['production'],
  type: 'logs',
  esql: 'FROM logs-*',
  view_name: '$.telemetry',
  created_by: 'tester',
  created_at: '2026-11-24T10:00:00.000Z',
  updated_at: '2026-11-24T10:00:00.000Z',
  esql_updated_at: '2026-11-24T10:00:00.000Z',
};

describe('source query planning and evidence', () => {
  const query = jest.fn();
  let session: ExplorationToolSession;
  const args = {
    sourceIds: ['source'],
    template: 'custom',
    lookbackMinutes: 2,
    pipeline: '| STATS n=COUNT(*) BY `service.name` | SORT `service.name`',
    maxRows: 2,
  };
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getEsqlColumnSchema).mockResolvedValue(columns);
    query.mockResolvedValue({ columns: [{ name: 'documents', type: 'long' }], values: [[10001]] });
    session = new ExplorationToolSession(
      {} as SignificantEventsServer,
      { streamDataEsClient: { esql: { query } } } as unknown as RouteHandlerScopedClients,
      httpServerMock.createKibanaRequest(),
      { id: 'run', written: 0 } as ExplorationRun,
      [source],
      {},
      new AbortController().signal
    );
  });

  it('categorizes log bodies with workload-only identity without inventing a service', async () => {
    jest
      .mocked(getEsqlColumnSchema)
      .mockResolvedValue([
        columns[0],
        { name: 'body.text', type: 'text' },
        { name: 'resource.attributes.k8s.deployment.name.keyword', type: 'keyword' },
      ]);
    const sample = {
      sourceIds: [source.id],
      template: 'samples',
      sampleKind: 'errors',
      lookbackMinutes: 3,
    };
    await session.execute('source_esql', { ...sample, template: 'volume' });
    query.mockResolvedValue({
      columns: [
        { name: 'sample' },
        { name: 'count' },
        { name: 'resource.attributes.k8s.deployment.name.keyword' },
      ],
      values: [['Upstream query failed', 2, 'worker']],
    });
    const result = await session.execute('source_esql', sample);
    expect(result.results).toMatchObject([
      {
        status: 'completed',
        rows: [
          {
            workload: { 'resource.attributes.k8s.deployment.name.keyword': 'worker' },
            service: { name: '' },
          },
        ],
        query: expect.stringContaining(
          'CATEGORIZE(log), `resource.attributes.k8s.deployment.name.keyword`'
        ),
      },
    ]);
    expect(session.emittingServices).toEqual([]);
    const next = await session.execute('source_esql', sample);
    expect(next.firstLook).toBeUndefined();
  });

  it('pairs scoped measurements after volume planning and labels the disjoint evidence windows', async () => {
    const pair = { ...args, serviceNames: ['checkout'], compareEndOffsetMinutes: 8 };
    const first = await session.execute('source_esql', pair);
    expect(first).not.toHaveProperty('baselineComparison');
    expect(first.results).toMatchObject([{ status: 'requires_planning' }]);
    const result = await session.execute('source_esql', pair);
    expect(result).toMatchObject({
      results: [{ evidenceWindow: { kind: 'current', lookbackMinutes: 2, endOffsetMinutes: 0 } }],
      baselineComparison: [
        {
          evidenceWindow: {
            kind: 'historical_comparison',
            lookbackMinutes: 2,
            endOffsetMinutes: 8,
          },
          query: expect.stringContaining('NOW() - 10 minutes'),
        },
      ],
    });
    const scoped = await session.execute('source_esql', {
      ...pair,
      template: 'custom',
      serviceNames: undefined,
      pipeline: '| WHERE `service.name` == "checkout" | STATS records=COUNT(*)',
    });
    expect(scoped).toHaveProperty('baselineComparison');
    await expect(
      session.execute('source_esql', { ...pair, compareEndOffsetMinutes: 1 })
    ).rejects.toThrow('before the entire current window');
  });

  it('pages only enabled source metadata from one snapshot without reading or assessing telemetry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-24T12:00:00.000Z'));
    try {
      const lastNoveltyCheckAt = '2026-11-23T10:00:00.000Z';
      session = new ExplorationToolSession(
        {} as SignificantEventsServer,
        { streamDataEsClient: { esql: { query } } } as unknown as RouteHandlerScopedClients,
        httpServerMock.createKibanaRequest(),
        { id: 'run', sourceId: 'second' } as ExplorationRun,
        [
          source,
          { ...source, id: 'disabled', enabled: false },
          { ...source, id: 'second', description: undefined },
        ],
        { 'source:novelty': { signature: 'persisted', checkedAt: lastNoveltyCheckAt } },
        new AbortController().signal
      );
      session.pendingCheckpoints['source:novelty'] = {
        signature: 'pending',
        checkedAt: new Date().toISOString(),
      };
      const first = await session.execute('detection_sources', { limit: 1 });
      expect(first).toMatchObject({
        snapshotAt: expect.any(String),
        offset: 0,
        limit: 1,
        total: 2,
        hasMore: true,
        nextOffset: 1,
        prioritySourceId: 'second',
        sources: [
          {
            id: source.id,
            description: source.description,
            tags: source.tags,
            viewName: source.view_name,
            revision: source.esql_updated_at,
            lastNoveltyCheckAt,
          },
        ],
      });
      expect(first.sources).toHaveLength(1);
      expect(first).not.toHaveProperty('sources.0.lastChecked');
      jest.advanceTimersByTime(60000);
      expect(await session.execute('detection_sources', { offset: 1, limit: 1 })).toMatchObject({
        snapshotAt: first.snapshotAt,
        offset: 1,
        limit: 1,
        total: 2,
        hasMore: false,
        nextOffset: null,
        sources: [{ id: 'second', description: null, lastNoveltyCheckAt: null }],
      });
      expect(await session.execute('detection_sources', { offset: 2, limit: 1 })).toMatchObject({
        snapshotAt: first.snapshotAt,
        sources: [],
        hasMore: false,
        nextOffset: null,
      });
      expect(query).not.toHaveBeenCalled();
      expect(getEsqlColumnSchema).not.toHaveBeenCalled();
      expect(session.examined.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('enforces the same paging boundaries for inference and direct execution', async () => {
    const schema = fromJSONSchema({ ...explorationTools.detection_sources.schema });
    expect(await session.execute('detection_sources', {})).toMatchObject({ offset: 0, limit: 50 });
    for (const parameters of [
      { offset: -1 },
      { offset: 0.5 },
      { offset: 10001 },
      { limit: 0 },
      { limit: 1.5 },
      { limit: 101 },
    ]) {
      expect(schema?.safeParse(parameters).success).toBe(false);
      await expect(session.execute('detection_sources', parameters)).rejects.toThrow();
    }
    const parameters = { offset: 10000, limit: 100 };
    expect(schema?.safeParse(parameters).success).toBe(true);
    expect(await session.execute('detection_sources', parameters)).toMatchObject({
      ...parameters,
      sources: [],
      hasMore: false,
      nextOffset: null,
    });
  });

  it('keeps Kibana context separate from source evidence and scopes successful checkpoints', async () => {
    const getSchema = async () => z.object({ service: z.string() });
    const tools = ['observability.get_alerts', 'observability.dashboard'].map((id) => ({
      id,
      description: 'Observability',
      annotations: { readOnlyHint: true },
      getSchema,
    }));
    const execute = jest
      .fn()
      .mockResolvedValue({ results: [{ type: 'other', data: { alerts: [], total: 0 } }] });
    const server = {
      agentBuilder: { tools: { getRegistry: async () => ({ list: async () => tools }), execute } },
    };
    const lookup = new ExplorationToolSession(
      server as unknown as SignificantEventsServer,
      {} as RouteHandlerScopedClients,
      httpServerMock.createKibanaRequest(),
      {} as ExplorationRun,
      [source],
      {},
      new AbortController().signal
    );
    const call = (params: object) => lookup.execute('kibana_information', params);
    expect(await call({ action: 'catalog', limit: 1 })).toMatchObject({
      total: 2,
      nextOffset: 1,
      tools: [{ id: 'observability.dashboard' }],
    });
    expect(await call({ action: 'catalog', offset: 1 })).toMatchObject({
      nextOffset: null,
      tools: [{ id: 'observability.get_alerts' }],
    });
    const args = {
      action: 'execute',
      toolId: tools[0].id,
      parameters: { service: 'checkout' },
      checkpointKey: 'inventory',
    };
    expect(await call({ ...args, parametersJson: '{}' })).toHaveProperty('error');
    expect(await call({ ...args, parameters: {} })).toMatchObject({
      issues: [{ path: ['service'] }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await call(args)).toMatchObject({
      monitoringAssessed: true,
      provenance: { toolId: args.toolId, parameters: args.parameters },
    });
    expect(await call({ ...args, toolId: tools[1].id })).toMatchObject({
      monitoringAssessed: false,
    });
    await call({ ...args, parameters: { service: 'worker' } });
    expect(Object.keys(lookup.pendingCheckpoints)).toHaveLength(3);
    expect(() => lookup.getEvidenceChecks(source.id, ['r1'])).toThrow();
    execute.mockResolvedValue({
      results: [
        { type: 'other', data: {} },
        { type: 'error', data: { message: 'Access denied' } },
      ],
    });
    expect(await call({ ...args, checkpointKey: 'failed' })).toMatchObject({
      status: 'partial',
      error: 'Access denied',
      monitoringAssessed: false,
    });
    expect(Object.keys(lookup.pendingCheckpoints)).toHaveLength(3);
    execute.mockResolvedValue({
      results: [
        { type: 'other', data: { v: 1 } },
        { type: 'other', data: { v: 'x'.repeat(15000) } },
      ],
    });
    expect(await call(args)).toMatchObject({
      truncated: true,
      totalResults: 2,
      results: [{ data: { v: 1 } }],
      monitoringAssessed: false,
    });
  });

  it('binds KI catalog continuation to the initial snapshot and filters', async () => {
    const getAgentCatalog = jest.fn().mockResolvedValue({
      total: 25001,
      queryTotal: 0,
      rows: [],
      after: { sourceId: source.id, type: 'feature', id: 'storage-id' },
    });
    const lookup = new ExplorationToolSession(
      {} as SignificantEventsServer,
      {
        getKnowledgeIndicatorClient: async () => ({ getAgentCatalog }),
      } as unknown as RouteHandlerScopedClients,
      httpServerMock.createKibanaRequest(),
      {} as ExplorationRun,
      [source],
      {},
      new AbortController().signal
    );
    const page = await lookup.execute('knowledge_indicators', { action: 'index', query: 'worker' });
    await lookup.execute('knowledge_indicators', {
      action: 'index',
      query: 'WORKER',
      cursor: page.nextCursor,
    });
    expect(getAgentCatalog.mock.calls[1][0]).toMatchObject({
      asOf: page.asOf,
      after: { id: 'storage-id' },
    });
    await expect(
      lookup.execute('knowledge_indicators', {
        action: 'index',
        kind: 'query',
        cursor: page.nextCursor,
      })
    ).rejects.toThrow();
    expect(getAgentCatalog).toHaveBeenCalledTimes(2);
  });

  it('accepts fractional sampling through the inference tool-schema validator', () => {
    const schema = fromJSONSchema({ ...explorationTools.source_esql.schema });
    for (const sampleProbability of [0.0001, 0.2, 0.75, 1])
      expect(schema?.safeParse({ ...args, sampleProbability }).success).toBe(true);
    for (const sampleProbability of [0, -0.1, 1.1])
      expect(schema?.safeParse({ ...args, sampleProbability }).success).toBe(false);
  });

  it('retries a partial volume probe once and labels the actual historical window', async () => {
    query
      .mockResolvedValueOnce({ is_partial: true, values: [[999]] })
      .mockResolvedValueOnce({ values: [[60]] });
    const probe = {
      sourceIds: [source.id],
      template: 'volume',
      lookbackMinutes: 10,
      endOffsetMinutes: 2,
    };
    expect(await session.execute('source_esql', probe)).toMatchObject({
      results: [
        {
          documents: 60,
          documentsPerSecond: 1,
          requestedLookbackMinutes: 10,
          evidenceWindow: { lookbackMinutes: 1, endOffsetMinutes: 2 },
          query: expect.stringContaining('NOW() - 3 minutes'),
        },
      ],
    });
    query.mockResolvedValue({ is_partial: true, values: [[99]] });
    expect(await session.execute('source_esql', probe)).toMatchObject({
      failed: true,
      results: [{ coverageComplete: false, error: expect.stringContaining('one minute') }],
    });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('profiles a bounded first page of actual fields when no keywords are supplied', async () => {
    await session.execute('source_esql', { ...args, template: 'volume' });
    const many = Array.from({ length: 30 }, (_, i) => ({ name: 'metric.' + i, type: 'long' }));
    jest.mocked(getEsqlColumnSchema).mockResolvedValue([...columns, ...many]);
    expect(
      await session.execute('source_esql', { ...args, template: 'profile', maxRows: 100 })
    ).toMatchObject({
      failed: false,
      results: [{ totalFields: 33, nextOffset: 12, hasMore: true }],
    });
  });

  it('repairs only raw field previews, preserving filters and aggregates', async () => {
    await session.execute('source_esql', { ...args, template: 'volume' });
    const result = await session.execute('source_esql', {
      ...args,
      pipeline: '| KEEP `service.name`, `service.*`, `absent` | SORT `service.name` DESC | LIMIT 2',
    });
    expect(result).toMatchObject({
      failed: false,
      results: [
        {
          query: expect.stringContaining(
            'KEEP `service.name`, service.* | SORT `service.name` DESC | LIMIT 2'
          ),
          warnings: expect.arrayContaining([expect.stringContaining('absent')]),
        },
      ],
    });
    const filtered = '| WHERE absent IS NOT NULL | KEEP service.name, absent | LIMIT 2';
    query.mockRejectedValueOnce(new Error('verification_exception: Unknown column [absent]'));
    expect(await session.execute('source_esql', { ...args, pipeline: filtered })).toMatchObject({
      failed: true,
    });
    expect(query.mock.lastCall[0].query).toContain(filtered.slice(2));
  });

  it('routes each feature to its unique evidence owner and rejects ambiguous writes before saving', async () => {
    const ki = {
      getFeatures: async () => ({ hits: [] }),
      bulk: jest.fn(),
      getDefaultExpiresAt: jest.fn(),
    };
    const multi = new ExplorationToolSession(
      {} as SignificantEventsServer,
      {
        getKnowledgeIndicatorClient: async () => ki,
        streamDataEsClient: { esql: { query } },
      } as unknown as RouteHandlerScopedClients,
      httpServerMock.createKibanaRequest(),
      { id: 'run', written: 0 } as ExplorationRun,
      [source, { ...source, id: 'second' }],
      {},
      new AbortController().signal
    );
    const refs = await Promise.all(
      [source.id, 'second'].map(async (sourceId) => {
        const read = await multi.execute('source_esql', {
          sourceIds: [sourceId],
          template: 'schema',
          lookbackMinutes: 2,
        });
        return (read.results as Array<{ columns: Array<{ evidenceRef: string }> }>)[0].columns[0]
          .evidenceRef;
      })
    );
    const feature = {
      id: 'sample-format',
      type: 'schema',
      subtype: 'custom',
      title: 'Sample format',
      description: 'Observed schema field.',
      properties: {},
      confidence: 80,
      tags: [],
      evidence: [],
      evidence_doc_ids: [],
    };
    const upsert = (handles: string[][]) =>
      multi.execute('knowledge_indicators', {
        action: 'upsert',
        features: handles.map((evidence_refs) => ({ ...feature, evidence_refs })),
      });
    await expect(upsert([[refs[0]], refs])).rejects.toThrow('top-level sourceId');
    expect(ki.bulk).not.toHaveBeenCalled();
    expect(await upsert(refs.map((ref) => [ref]))).toMatchObject({
      saved: [
        { sourceId: source.id, id: feature.id },
        { sourceId: 'second', id: feature.id },
      ],
      rejected: [],
    });
    expect(ki.bulk.mock.calls.map(([id]) => id)).toEqual([source.id, 'second']);
  });

  it('preserves native evidence values and types for rule predicate replay', async () => {
    await session.execute('source_esql', { ...args, template: 'volume' });
    const cells = [
      { name: 'status', type: 'long', value: 503 },
      { name: 'label', type: 'keyword', value: '503' },
      { name: 'fallback', type: 'boolean', value: false },
      { name: 'outcome', type: 'keyword', value: null },
    ];
    query.mockResolvedValueOnce({
      columns: cells.map(({ name, type }) => ({ name, type })),
      values: [cells.map(({ value }) => value)],
    });
    const result = await session.execute('source_esql', args);
    const [{ rowRefs }] = result.results as Array<{ rowRefs: string[] }>;
    expect(session.getEvidenceRows(source.id, rowRefs)).toEqual([cells]);
  });

  it('resolves exact catalog slugs to canonical IDs and rejects mistyped selectors', async () => {
    const probe = { ...args, template: 'volume', sourceIds: [source.slug, source.id] };
    const result = await session.execute('source_esql', probe);
    expect(result.results).toMatchObject([{ sourceId: source.id, status: 'completed' }]);
    expect(result.results).toHaveLength(1);
    expect(
      await session.execute('source_esql', { ...probe, sourceIds: ['telemetr'] })
    ).toMatchObject({ failed: true });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported sampling before even probing volume', async () => {
    await expect(
      session.execute('source_esql', { ...args, template: 'peers', sampleProbability: 0.1 })
    ).rejects.toThrow('sampleProbability');
    expect(query).not.toHaveBeenCalled();
  });

  it('reports an unmapped time field on explicit or automatic volume probes without inferring a healthy source', async () => {
    query.mockRejectedValueOnce(new Error('Unknown column [@timestamp]'));
    expect(await session.execute('source_esql', args)).toMatchObject({
      failed: false,
      results: [{ status: 'unavailable', executedTemplate: 'volume', coverageComplete: false }],
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('runs only a capped volume probe until the caller can choose its scan strategy', async () => {
    const result = await session.execute('source_esql', args);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0].query).toContain('LIMIT 10001 | STATS documents=COUNT(*)');
    expect(query.mock.calls[0][0].query).toContain('NOW() - 1 minutes');
    expect(getEsqlColumnSchema).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      results: [
        {
          requiresPlanning: true,
          requestedTemplate: 'custom',
          executedTemplate: 'volume',
          status: 'requires_planning',
          countRelation: 'gte',
          documents: 10000,
        },
      ],
    });
    expect(session.examined.size).toBe(0);
  });

  it('returns a query-repair action without registering failed SQL as health evidence', async () => {
    await session.execute('source_esql', args);
    query.mockRejectedValueOnce(new Error('verification_exception: Unknown column [metric.name]'));
    const result = await session.execute('source_esql', args);
    expect(result).toMatchObject({
      failed: true,
      results: [
        { coverageComplete: false, nextAction: expect.stringContaining('template=schema') },
      ],
    });
    expect(session.examined.size).toBe(0);
    expect(session.blocked).toBe(false);
  });

  it('reports truncated live aggregates and rejects an unstable continuation', async () => {
    await session.execute('source_esql', args);
    query.mockResolvedValue({
      columns: [
        { name: 'n', type: 'long' },
        { name: 'service.name', type: 'keyword' },
      ],
      values: [
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
        [4, 'd'],
        [5, 'e'],
      ],
    });
    const result = await session.execute('source_esql', args);
    expect(result).toMatchObject({
      results: [
        {
          rows: [
            [1, 'a'],
            [2, 'b'],
          ],
          truncated: true,
          coverageComplete: false,
          hasMore: false,
          nextOffset: null,
        },
      ],
    });
    const calls = query.mock.calls.length;
    await expect(session.execute('source_esql', { ...args, offset: 2 })).rejects.toThrow('Narrow');
    expect(query).toHaveBeenCalledTimes(calls);
  });

  it('scopes probability sampling before exploration and labels approximate counts', async () => {
    await session.execute('source_esql', args);
    query.mockResolvedValue({ columns: [{ name: 'n', type: 'long' }], values: [[10]] });
    const result = await session.execute('source_esql', {
      ...args,
      serviceNames: ['worker'],
      serviceNamespace: 'prod',
      sampleProbability: 0.01,
    });
    expect(query.mock.calls[1][0].query).toContain(
      'IN ("worker") AND `service.namespace` == "prod" | SAMPLE 0.01 |'
    );
    expect(result).toMatchObject({
      results: [{ sampling: { probability: 0.01, exactCounts: false } }],
    });
  });

  it('honors an explicit latest-row pipeline supplied with the samples template', async () => {
    await session.execute('source_esql', args);
    query.mockResolvedValue({
      columns: [{ name: 'service.name', type: 'keyword' }],
      values: [['api']],
    });
    const result = await session.execute('source_esql', {
      ...args,
      template: 'samples',
      pipeline: '| SORT @timestamp DESC | KEEP `service.name`',
    });
    expect(query.mock.calls[1][0].query).toContain('SORT @timestamp DESC | KEEP `service.name`');
    expect(query.mock.calls[1][0].query).not.toContain('CATEGORIZE');
    expect(result).toMatchObject({ templateRequested: 'samples', templateUsed: 'custom' });
  });

  it('flags a combined limited read that omits a requested emitting service', async () => {
    await session.execute('source_esql', args);
    query.mockResolvedValue({
      columns: [{ name: 'service.name', type: 'keyword' }],
      values: [['api'], ['api']],
    });
    const result = await session.execute('source_esql', {
      ...args,
      serviceNames: ['api', 'worker'],
    });
    expect(result).toMatchObject({
      results: [
        {
          warnings: expect.arrayContaining([
            expect.stringContaining('no rows identifying requested services: worker'),
          ]),
        },
      ],
    });
  });

  it('warns about literal dotted JSON keys when parsed values silently come back null', async () => {
    await session.execute('source_esql', args);
    query.mockResolvedValue({
      columns: [{ name: 'error', type: 'keyword' }],
      values: [[null]],
    });
    expect(
      await session.execute('source_esql', {
        ...args,
        pipeline: '| EVAL error=JSON_EXTRACT(message, "error.message") | KEEP error',
      })
    ).toMatchObject({
      results: [
        { warnings: expect.arrayContaining([expect.stringContaining('bracket notation')]) },
      ],
    });
  });

  it.each(['technology', 'peers', 'trace_links', 'infrastructure'] as const)(
    'rejects partial %s inventory before issuing evidence references',
    async (template) => {
      await session.execute('source_esql', { ...args, template: 'volume' });
      jest.mocked(getEsqlColumnSchema).mockResolvedValue([
        ...columns,
        ...['telemetry.sdk.name', 'peer.service', 'trace.id', 'host.name'].map((name) => ({
          name,
          type: 'keyword',
        })),
      ]);
      query.mockResolvedValue({ columns, values: [], is_partial: true });
      expect(await session.execute('source_esql', { ...args, template })).toMatchObject({
        failed: true,
        results: [{ status: 'failed', error: expect.stringContaining('partial results') }],
      });
      expect(session.examined.size).toBe(0);
    }
  );

  it('does not record partial query results as usable current evidence', async () => {
    await session.execute('source_esql', args);
    query.mockResolvedValue({
      columns: [{ name: 'n', type: 'long' }],
      values: [[0]],
      is_partial: true,
    });
    const result = await session.execute('source_esql', args);
    expect(result).toMatchObject({
      failed: true,
      results: [{ error: expect.stringContaining('partial results') }],
    });
    expect(() => session.getEvidenceChecks('source', ['r1'])).toThrow();
  });
  it('surfaces bounded current emitters even when the first actual read targets an old incident', async () => {
    await session.execute('source_esql', args);
    query.mockImplementation(async ({ query: esql }: { query: string }) =>
      esql.includes('BY service_name=')
        ? {
            columns: [
              { name: 'service_name', type: 'keyword' },
              { name: 'namespace', type: 'keyword' },
              { name: 'count', type: 'long' },
            ],
            values: [['new-worker', 'prod', 12]],
          }
        : { columns: [{ name: 'n', type: 'long' }], values: [[20]] }
    );
    const result = await session.execute('source_esql', {
      ...args,
      lookbackMinutes: 10,
      serviceNames: ['api'],
    });
    expect(result).toMatchObject({
      firstLook: {
        source: {
          services: {
            window: { lookbackMinutes: 3, endOffsetMinutes: 0 },
            services: [{ service_name: 'new-worker', namespace: 'prod' }],
          },
        },
      },
    });
    expect(session.emittingServices).toEqual([
      {
        sourceId: 'source',
        name: 'new-worker',
        namespace: 'prod',
        evidenceRef: expect.any(String),
      },
    ]);
    const inventoryQuery = query.mock.calls[2][0].query;
    expect(inventoryQuery).toContain('NOW() - 3 minutes');
    expect(inventoryQuery).not.toContain('IN ("api")');
  });
});
