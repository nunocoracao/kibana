/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { getEsqlColumnSchema } from '@kbn/ai-tools';
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
      [{ id: 'source', enabled: true, view_name: '$.telemetry' } as NightshiftSource],
      {},
      new AbortController().signal
    );
  });

  it('accepts fractional sampling through the inference tool-schema validator', () => {
    const schema = fromJSONSchema({ ...explorationTools.source_esql.schema });
    for (const sampleProbability of [0.0001, 0.2, 0.75, 1])
      expect(schema?.safeParse({ ...args, sampleProbability }).success).toBe(true);
    for (const sampleProbability of [0, -0.1, 1.1])
      expect(schema?.safeParse({ ...args, sampleProbability }).success).toBe(false);
  });

  it('runs only a capped volume probe until the caller can choose its scan strategy', async () => {
    const result = await session.execute('source_esql', args);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0].query).toContain('LIMIT 10001 | STATS documents=COUNT(*)');
    expect(query.mock.calls[0][0].query).toContain('NOW() - 1 minutes');
    expect(getEsqlColumnSchema).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      results: [{ requiresPlanning: true, countRelation: 'gte', documents: 10000 }],
    });
    expect(session.examined.size).toBe(0);
  });

  it('pages a custom aggregate beyond the first group without repeating it', async () => {
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
    const result = await session.execute('source_esql', { ...args, offset: 2 });
    expect(query.mock.calls[1][0].query).toContain('LIMIT 5');
    expect(result).toMatchObject({
      results: [
        {
          rows: [
            [3, 'c'],
            [4, 'd'],
          ],
          hasMore: true,
          nextOffset: 4,
        },
      ],
    });
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
