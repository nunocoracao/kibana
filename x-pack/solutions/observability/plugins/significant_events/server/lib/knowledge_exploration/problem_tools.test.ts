/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { httpServerMock } from '@kbn/core-http-server-mocks';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import { significantEventSchema } from '@kbn/significant-events-schema';
import type { SignificantEvent } from '@kbn/significant-events-schema';
import type { ExplorationRun } from '../../../common/knowledge_exploration';
import { emptyExplorationTokens } from '../../../common/knowledge_exploration';
import type { RouteHandlerScopedClients } from '../../routes/types';
import type { SignificantEventsServer } from '../../types';
import { ProblemToolSession, PROBLEM_EVENT_PREFIX } from './problem_tools';

const mockEvidenceChecks = jest.fn();
const mockReadExecute = jest.fn();
const mockExaminedSources = new Set<string>();
const mockEmittingServices: Array<{
  sourceId: string;
  name: string;
  namespace: string;
  evidenceRef: string;
}> = [];
jest.mock('./tools', () => ({
  ...jest.requireActual('./tools'),
  ExplorationToolSession: jest.fn().mockImplementation(() => ({
    pendingCheckpoints: {},
    examined: mockExaminedSources,
    emittingServices: mockEmittingServices,
    blocked: false,
    execute: mockReadExecute,
    getEvidenceChecks: mockEvidenceChecks,
  })),
}));

describe('unified problem lifecycle', () => {
  const source: NightshiftSource = {
    id: 'source-a',
    title: 'Telemetry',
    slug: 'telemetry',
    enabled: true,
    tags: [],
    esql: 'FROM logs-*',
    view_name: '$.telemetry',
    type: 'logs',
    created_by: 'tester',
    created_at: '2026-11-20T10:00:00.000Z',
    updated_at: '2026-11-20T10:00:00.000Z',
    esql_updated_at: '2026-11-20T10:00:00.000Z',
  };
  let events: Map<string, SignificantEvent>;
  const getFeatures = jest.fn();
  const deactivations = jest.fn();
  const getSourceToQueryLinksMap = jest.fn();
  let run: ExplorationRun;
  const input = {
    action: 'upsert',
    issueKey: 'estate-api-operation-failure',
    sourceIds: ['source-a'],
    evidenceRefs: ['row-1'],
    title: 'API — operation failures',
    summary: 'The API operation fails.',
    assessmentNote: 'Current operation outcomes confirm the assessment.',
    status: 'active',
    severity: 'high',
    confidence: 0.9,
  };
  const search = {
    findLatestByCurrentStatePaginated: jest.fn(async ({ status }: { status?: string[] }) => {
      const hits = [...events.values()].filter((event) => !status || status.includes(event.status));
      return { hits, total: hits.length };
    }),
    findLatestByEventId: jest.fn(async (id: string) => {
      const event = events.get(id);
      return event && { ...event, created_at: event['@timestamp'], episode_id: 'episode' };
    }),
    findEventDeactivations: deactivations,
    createEvent: jest.fn(async ({ event }: { event: SignificantEvent }) => {
      events.set(event.event_id, event);
      return { groupHash: 'group', alertId: 'episode' };
    }),
    updateEvent: jest.fn(async ({ event }: { event: SignificantEvent }) => {
      events.set(event.event_id, event);
      return { updated: true };
    }),
  };
  const session = () =>
    new ProblemToolSession(
      {} as SignificantEventsServer,
      {
        getEventSearchClient: async () => search,
        getKnowledgeIndicatorClient: async () => ({ getFeatures, getSourceToQueryLinksMap }),
      } as unknown as RouteHandlerScopedClients,
      httpServerMock.createKibanaRequest(),
      run,
      [source],
      {},
      new AbortController().signal
    );
  const addActive = () => {
    const event = significantEventSchema.parse({
      event_id: PROBLEM_EVENT_PREFIX + input.issueKey,
      '@timestamp': new Date().toISOString(),
      source_ids: ['source-a'],
      title: input.title,
      summary: input.summary,
      status: 'active',
      severity: 'high',
      confidence: 0.9,
      signals: [],
    });
    events.set(event.event_id, event);
    return event;
  };
  beforeEach(() => {
    mockExaminedSources.clear();
    mockExaminedSources.add('source-a');
    mockEmittingServices.length = 0;
    getSourceToQueryLinksMap.mockResolvedValue({});
    mockReadExecute.mockReset();
    jest.clearAllMocks();
    events = new Map();
    deactivations.mockResolvedValue([]);
    getFeatures.mockResolvedValue({
      hits: [
        {
          id: 'service-api',
          source_id: 'source-a',
          type: 'entity',
          subtype: 'service',
          title: 'API',
          properties: { name: 'api', service_namespace: 'prod' },
        },
      ],
    });
    mockEvidenceChecks.mockImplementation(() => [
      {
        query:
          'FROM $.telemetry | WHERE `@timestamp` >= NOW() - 2 minutes | STATS requests=COUNT(*)',
        row: {
          requests: '100',
          failures: '20',
          'service.name': 'api',
          'service.namespace': 'prod',
        },
        checkedAt: Date.now(),
      },
    ]);
    run = {
      id: 'run-1',
      reason: 'manual',
      startedAt: new Date().toISOString(),
      status: 'running',
      summary: '',
      connectorId: 'model',
      model: 'Model',
      thinking: true,
      steps: [],
      tokens: emptyExplorationTokens(),
      estimatedCostUsd: 0,
      written: 0,
      examinedSources: [],
    };
  });

  it('creates a native problem with inspectable current query signals and an exact affected entity before a rule fires', async () => {
    const result = await session().execute('events', input);
    expect(events.get(String(result.eventId))?.status).toBe('active');
    expect(events.get(String(result.eventId))?.signals?.[0]).toMatchObject({
      type: 'query',
      verdict: 'confirms',
      evidence: { result: 'found' },
    });
    expect(events.get(String(result.eventId))?.blast_radius).toMatchObject([
      { feature_id: 'service-api', source_id: 'source-a' },
    ]);
    expect(run.written).toBe(1);
  });

  it.each(['historical-window', 'five-minute-window', 'expired-read'])(
    'refuses to close a problem using %s evidence',
    async (kind) => {
      const prior = addActive();
      mockEvidenceChecks.mockReturnValue([
        {
          query: `FROM $.telemetry | WHERE \`@timestamp\` >= NOW() - ${
            kind === 'historical-window' ? 30 : kind === 'five-minute-window' ? 5 : 2
          } minutes`,
          row: { successes: '100' },
          checkedAt: kind === 'expired-read' ? Date.now() - 4 * 60000 : Date.now(),
        },
      ]);
      await expect(
        session().execute('events', { ...input, eventId: prior.event_id, status: 'inactive' })
      ).rejects.toThrow(
        /Missing current outcomes for selected source source-a\. Rejected references:.*row-1/
      );
      expect(events.get(prior.event_id)?.status).toBe('active');
    }
  );

  it('requires old active problems to be reviewed before a complete run can finish', async () => {
    const prior = addActive();
    const agent = session();
    const finish = {
      outcome: 'nothing_new',
      summary: 'No changes.',
      coverageComplete: true,
      remainingGaps: [],
    };
    expect(await agent.execute('finish_exploration', finish)).toHaveProperty('error');
    expect(agent.finished).toBe(false);
    await agent.execute('events', {
      action: 'review',
      eventId: prior.event_id,
      evidenceRefs: ['row-1'],
    });
    await agent.execute('finish_exploration', finish);
    expect(agent.finished).toBe(true);
    expect(run.coverageComplete).toBe(true);
  });

  it('closes and reopens the same problem identity across separate runs', async () => {
    const created = await session().execute('events', input);
    await session().execute('events', { ...input, eventId: created.eventId, status: 'inactive' });
    expect(events.get(String(created.eventId))?.status).toBe('inactive');
    await session().execute('events', {
      ...input,
      eventId: created.eventId,
      title: 'The same operation is failing again',
    });
    expect(events.get(String(created.eventId))?.title).toBe('The same operation is failing again');
    expect(events.size).toBe(1);
    expect(events.get(String(created.eventId))?.status).toBe('active');
  });

  it('retains real measurement/rule references while excluding an unbacked query generated rule ID', async () => {
    getSourceToQueryLinksMap.mockResolvedValue({
      'source-a': [
        {
          source_id: 'source-a',
          query: { id: 'measurement' },
          rule_backed: false,
          rule_id: 'not-installed',
        },
        { source_id: 'source-a', query: { id: 'monitor' }, rule_backed: true, rule_id: 'monitor' },
      ],
    });
    const result = await session().execute('events', {
      ...input,
      queryIds: ['measurement'],
      ruleIds: ['monitor'],
    });
    expect(events.get(String(result.eventId))?.signals?.[0].metadata).toMatchObject({
      query_id: 'measurement',
      rule_uuid: 'monitor',
    });
    const refreshed = await session().execute('events', { ...input, eventId: result.eventId });
    expect(refreshed.monitoringNextAction).toBeUndefined();
    expect(refreshed.signalReferences).toContainEqual(
      expect.objectContaining({ query_id: 'measurement', rule_uuid: 'monitor' })
    );
    getSourceToQueryLinksMap.mockResolvedValue({ 'source-a': [] });
    const removed = await session().execute('events', { ...input, eventId: result.eventId });
    expect(removed.monitoringNextAction).toBeTruthy();
  });

  it('surfaces currently emitting services missed by narrow incident checks before finishing', async () => {
    mockEmittingServices.push({
      sourceId: 'source-a',
      name: 'worker',
      namespace: 'prod',
      evidenceRef: 'row-2',
    });
    const agent = session();
    const finish = {
      outcome: 'partial',
      summary: 'Known incident checks only',
      coverageComplete: false,
      remainingGaps: [],
      monitoringBlocker: 'No validated measurement',
    };
    expect(await agent.execute('finish_exploration', finish)).toMatchObject({
      finished: false,
      unassessedServices: [{ name: 'worker', evidenceRef: 'row-2' }],
    });
    expect(agent.finished).toBe(false);
  });

  it('does not count a generic aggregate as payload understanding for an unfamiliar log emitter', async () => {
    mockEmittingServices.push({
      sourceId: 'source-a',
      name: 'worker',
      namespace: 'prod',
      evidenceRef: 'row-2',
    });
    getFeatures.mockResolvedValue({ hits: [] });
    mockEvidenceChecks.mockReturnValue([
      {
        query: 'FROM logs-* | WHERE `@timestamp` >= NOW() - 1 minutes',
        checkedAt: Date.now(),
        row: { 'service.name': 'worker', 'service.namespace': 'prod', count: '20' },
      },
    ]);
    mockReadExecute.mockResolvedValue({ results: [{ sourceId: 'source-a', rowRefs: ['row-2'] }] });
    const agent = session();
    await agent.execute('source_esql', { template: 'custom', lookbackMinutes: 1 });
    const result = await agent.execute('finish_exploration', {
      outcome: 'partial',
      summary: 'Only marker counts read',
      coverageComplete: false,
      remainingGaps: [],
    });
    expect(result).toMatchObject({
      finished: false,
      unparsedLogEmitters: [{ name: 'worker', namespace: 'prod' }],
    });
  });

  it('persists a reusable native lesson after a newly created event before finishing', async () => {
    const agent = session();
    const event = await agent.execute('events', input);
    const finish = {
      outcome: 'assessed',
      summary: 'Found a supported failure',
      coverageComplete: true,
      remainingGaps: [],
    };
    expect(await agent.execute('finish_exploration', finish)).toMatchObject({
      finished: false,
      eventLearningGaps: [
        { eventId: event.eventId, sourceIds: ['source-a'], evidenceRefs: ['row-1'] },
      ],
    });
    getFeatures.mockResolvedValue({
      hits: [
        {
          source_id: 'source-a',
          type: 'schema',
          properties: { kind: 'detection_learning', event_id: event.eventId },
        },
      ],
    });
    expect(await agent.execute('finish_exploration', finish)).toMatchObject({ finished: true });
  });

  it.each(['active', 'inactive'] as const)(
    'requires identity review before creating another key for overlapping %s entities',
    async (status) => {
      const prior = await session().execute('events', { ...input, status: 'active' });
      const event = events.get(String(prior.eventId));
      if (!event) throw new Error('Missing created event');
      events.set(event.event_id, { ...event, status });
      const agent = session();
      await agent.execute('events', { action: 'index' });
      const result = await agent.execute('events', { ...input, issueKey: 'same-path-new-label' });
      expect(result).toMatchObject({
        written: false,
        requiresIdentityReview: true,
        relatedEvents: [{ eventId: prior.eventId }],
      });
      expect(events.size).toBe(1);
      const updated = await agent.execute('events', { ...input, eventId: prior.eventId });
      expect(updated.eventId).toBe(prior.eventId);
      expect(events.size).toBe(1);
    }
  );

  it('keeps inactive history out of routine event checks while allowing explicit identity lookup', async () => {
    const prior = await session().execute('events', input);
    await session().execute('events', { ...input, eventId: prior.eventId, status: 'inactive' });
    const agent = session();
    expect(await agent.execute('events', { action: 'index' })).toMatchObject({
      events: [],
      total: 0,
      activeProblemsToReview: [],
    });
    expect(await agent.execute('events', { action: 'index', includeInactive: true })).toMatchObject(
      {
        events: [{ eventId: prior.eventId, status: 'inactive' }],
        total: 1,
        activeProblemsToReview: [],
      }
    );
  });

  it('permits a genuinely distinct mechanism after explicit overlap review', async () => {
    const prior = await session().execute('events', input);
    const agent = session();
    await agent.execute('events', { action: 'index' });
    const created = await agent.execute('events', {
      ...input,
      issueKey: 'independent-correctness-violation',
      separateFromEventIds: [prior.eventId],
      distinctProblemReason:
        'An independent correctness invariant is broken while the existing event measures request timeouts.',
    });
    expect(created.status).toBe('active');
    expect(events.size).toBe(2);
  });

  it('requires current latency and historical comparison for a known emitting duration contract', async () => {
    mockEmittingServices.push({
      sourceId: 'source-a',
      name: 'api',
      namespace: 'prod',
      evidenceRef: 'inventory',
    });
    getFeatures.mockResolvedValue({
      hits: [
        {
          id: 'api-format',
          source_id: 'source-a',
          type: 'schema',
          description: 'Operation duration_ms and status',
          properties: { kind: 'log_format', service_name: 'api', service_namespace: 'prod' },
        },
      ],
    });
    mockEvidenceChecks.mockReturnValue([
      {
        query: 'FROM logs-* | WHERE `@timestamp` >= NOW() - 1 minutes',
        checkedAt: Date.now(),
        row: { 'service.name': 'api', 'service.namespace': 'prod', p95: '250', n: '50' },
      },
    ]);
    mockReadExecute.mockResolvedValue({
      results: [
        {
          sourceId: 'source-a',
          rows: [{ 'service.name': 'api' }],
          rowRefs: ['row-1'],
        },
      ],
    });
    const agent = session();
    const scope = {
      sourceIds: ['source-a'],
      template: 'custom',
      lookbackMinutes: 1,
      serviceNames: ['api'],
      serviceNamespace: 'prod',
    };
    const finish = {
      outcome: 'partial',
      coverageComplete: false,
      summary: 'Outcomes checked; latency not yet assessed.',
      remainingGaps: [],
      monitoringBlocker: 'Native rule validation is unavailable in this fixture.',
    };
    await agent.execute('source_esql', {
      ...scope,
      pipeline: '| STATS n=COUNT(*) BY service.name,service.namespace',
    });
    expect(await agent.execute('finish_exploration', finish)).toMatchObject({
      finished: false,
      unassessedLatency: [{ name: 'api', missing: ['current', 'historical'] }],
    });
    const latency = '| STATS p95=PERCENTILE(duration_ms,95) BY service.name,service.namespace';
    await agent.execute('source_esql', { ...scope, pipeline: latency });
    expect(await agent.execute('finish_exploration', finish)).toMatchObject({
      finished: false,
      unassessedLatency: [{ name: 'api', missing: ['historical'] }],
    });
    await agent.execute('source_esql', { ...scope, pipeline: latency, endOffsetMinutes: 30 });
    expect(await agent.execute('finish_exploration', finish)).toMatchObject({ finished: true });
  });

  it.each([false, true])(
    'finishes explicitly partial after scoped duration aggregates have no usable population (empty=%s)',
    async (empty) => {
      mockEmittingServices.push({
        sourceId: 'source-a',
        name: 'api',
        namespace: 'prod',
        evidenceRef: 'inventory',
      });
      getFeatures.mockResolvedValue({
        hits: [
          {
            id: 'api-format',
            source_id: 'source-a',
            type: 'schema',
            description: 'Request duration_ms',
            properties: { service_name: 'api', service_namespace: 'prod' },
          },
        ],
      });
      mockEvidenceChecks.mockReturnValue([
        {
          query: 'FROM logs-* | WHERE `@timestamp` >= NOW() - 1 minutes',
          checkedAt: Date.now(),
          row: { 'service.name': 'api', 'service.namespace': 'prod', p95: '', n: '0' },
        },
      ]);
      mockReadExecute.mockResolvedValue({
        results: [
          { sourceId: 'source-a', rows: empty ? [] : [[0, null]], rowRefs: empty ? [] : ['row-1'] },
        ],
      });
      const agent = session();
      const read = {
        sourceIds: ['source-a'],
        template: 'custom',
        lookbackMinutes: 1,
        serviceNames: ['api'],
        serviceNamespace: 'prod',
        pipeline:
          '| STATS n=COUNT(duration_ms),p95=PERCENTILE(duration_ms,95) BY service.name,service.namespace',
      };
      await agent.execute('source_esql', read);
      await agent.execute('source_esql', { ...read, endOffsetMinutes: 30 });
      expect(
        await agent.execute('finish_exploration', {
          outcome: 'assessed',
          coverageComplete: true,
          summary: 'No request duration population.',
          remainingGaps: [],
          monitoringBlocker: 'No request population supports a monitor.',
        })
      ).toMatchObject({ finished: true, outcome: 'partial', coverageComplete: false });
      expect(run.remainingGaps).toContainEqual(expect.stringContaining('not proof of health'));
    }
  );

  it.each(['historical', 'stale', 'sampled'])(
    'does not use %s reads as current emitter coverage',
    async (kind) => {
      mockEmittingServices.push({
        sourceId: 'source-a',
        name: 'api',
        namespace: 'prod',
        evidenceRef: 'inventory',
      });
      mockEvidenceChecks.mockReturnValue([
        {
          query: 'FROM logs-* | WHERE `@timestamp` >= NOW() - 1 minutes',
          checkedAt: kind === 'stale' ? Date.now() - 4 * 60000 : Date.now(),
          row: { 'service.name': 'api', 'service.namespace': 'prod', successes: '10' },
        },
      ]);
      mockReadExecute.mockResolvedValue({
        results: [{ sourceId: 'source-a', rows: [[10]], rowRefs: ['row-1'] }],
      });
      const agent = session();
      await agent.execute('source_esql', {
        sourceIds: ['source-a'],
        template: 'custom',
        lookbackMinutes: 1,
        endOffsetMinutes: kind === 'historical' ? 30 : 0,
        sampleProbability: kind === 'sampled' ? 0.02 : 1,
        pipeline: '| STATS successes=COUNT(*) BY service.name,service.namespace',
      });
      expect(
        await agent.execute('finish_exploration', {
          outcome: 'assessed',
          coverageComplete: true,
          summary: 'A read occurred.',
          remainingGaps: [],
          monitoringBlocker: 'No monitor change in fixture.',
        })
      ).toMatchObject({
        finished: false,
        unassessedServices: [{ name: 'api', namespace: 'prod' }],
      });
      expect(agent.finished).toBe(false);
    }
  );

  it('performs one bounded stale-outcome refresh instead of an endless sliding sweep', async () => {
    getFeatures.mockResolvedValue({
      hits: [
        {
          id: 'api-format',
          source_id: 'source-a',
          type: 'schema',
          description: 'HTTP status contract',
          properties: { service_name: 'api', service_namespace: 'prod' },
        },
      ],
    });
    let at = Date.now();
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => at);
    try {
      mockEmittingServices.push({
        sourceId: 'source-a',
        name: 'api',
        namespace: 'prod',
        evidenceRef: 'inventory',
      });
      mockEvidenceChecks.mockImplementation(() => [
        {
          query: 'FROM logs-* | WHERE `@timestamp` >= NOW() - 1 minutes',
          checkedAt: at,
          row: { 'service.name': 'api', 'service.namespace': 'prod', successes: '10' },
        },
      ]);
      mockReadExecute.mockResolvedValue({
        results: [{ sourceId: 'source-a', rows: [[10]], rowRefs: ['row-1'] }],
      });
      const agent = session();
      const read = { template: 'custom', lookbackMinutes: 1 };
      const finish = {
        outcome: 'assessed',
        coverageComplete: true,
        summary: 'Current outcomes checked.',
        remainingGaps: [],
        monitoringBlocker: 'No monitoring change justified in this fixture.',
      };
      await agent.execute('source_esql', read);
      at += 4 * 60000;
      expect(await agent.execute('finish_exploration', finish)).toMatchObject({
        finished: false,
        unassessedServices: [{ name: 'api' }],
      });
      await agent.execute('source_esql', read);
      at += 4 * 60000;
      expect(await agent.execute('finish_exploration', finish)).toMatchObject({
        finished: true,
        outcome: 'partial',
        coverageComplete: false,
      });
      expect(run.remainingGaps).toContainEqual(
        expect.stringContaining('bounded current-outcome refresh completed')
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('continues pending current service checks while budget and data remain', async () => {
    mockEmittingServices.push({
      sourceId: 'source-a',
      name: 'worker',
      namespace: 'prod',
      evidenceRef: 'row-2',
    });
    const agent = session();
    const finish = {
      outcome: 'partial',
      summary: 'Current checks still incomplete',
      coverageComplete: false,
      remainingGaps: ['Worker not checked'],
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      mockEmittingServices[0].evidenceRef = `refreshed-inventory-${attempt}`;
      expect(await agent.execute('finish_exploration', finish)).toHaveProperty('finished', false);
      expect(agent.finished).toBe(false);
    }
    expect(await agent.execute('finish_exploration', finish)).toHaveProperty('finished', true);
    expect(run.outcome).toBe('partial');
    expect(run.coverageComplete).toBe(false);
    expect(run.remainingGaps).toContainEqual(expect.stringContaining('no progress'));
  });

  it('allows an honest partial exit for an unavailable source', async () => {
    mockExaminedSources.clear();
    const agent = session();
    const finish = {
      outcome: 'partial',
      summary: 'Source access failed',
      coverageComplete: false,
      remainingGaps: ['Source forbidden'],
      monitoringBlocker: 'Source access forbidden',
    };
    expect(await agent.execute('finish_exploration', finish)).toHaveProperty('unexaminedSources');
    mockReadExecute.mockResolvedValue({
      results: [{ sourceId: 'source-a', error: '403 forbidden' }],
    });
    await agent.execute('source_esql', { template: 'custom' });
    expect(await agent.execute('finish_exploration', finish)).toHaveProperty('finished', true);
    expect(run.coverageComplete).toBe(false);
  });

  it.each([false, true])(
    'keeps a scoped current empty read unknown even after historical data (history=%s)',
    async (history) => {
      mockEmittingServices.push({
        sourceId: 'source-a',
        name: 'worker',
        namespace: 'prod',
        evidenceRef: 'row-2',
      });
      const agent = session();
      mockReadExecute.mockResolvedValue({
        results: [{ sourceId: 'source-a', rows: [], rowRefs: [] }],
      });
      await agent.execute('source_esql', {
        template: 'samples',
        lookbackMinutes: 3,
        serviceNames: ['worker'],
        serviceNamespace: 'prod',
      });
      if (history) {
        mockReadExecute.mockResolvedValue({
          results: [{ sourceId: 'source-a', rows: [[10]], rowRefs: ['old-row'] }],
        });
        mockEvidenceChecks.mockReturnValue([
          {
            query:
              'FROM logs-* | WHERE `@timestamp` >= NOW() - 31 minutes AND `@timestamp` < NOW() - 30 minutes',
            checkedAt: Date.now(),
            row: { 'service.name': 'worker', 'service.namespace': 'prod', successes: '10' },
          },
        ]);
        await agent.execute('source_esql', {
          template: 'custom',
          lookbackMinutes: 1,
          endOffsetMinutes: 30,
          serviceNames: ['worker'],
          serviceNamespace: 'prod',
        });
      }
      const result = await agent.execute('finish_exploration', {
        outcome: 'partial',
        summary: 'Worker checked but no rows',
        coverageComplete: true,
        remainingGaps: [],
        monitoringBlocker: 'No current outcome rows to validate a monitor',
      });
      expect(result).toHaveProperty('finished', true);
      expect(run.coverageComplete).toBe(false);
      expect(run.remainingGaps).toContainEqual(expect.stringContaining('not proof of health'));
    }
  );

  it('recognizes a single-service scoped aggregate even when its projection omits identity columns', async () => {
    mockEmittingServices.push({
      sourceId: 'source-a',
      name: 'worker',
      namespace: 'prod',
      evidenceRef: 'row-2',
    });
    getFeatures.mockResolvedValue({
      hits: [
        {
          source_id: 'source-a',
          type: 'schema',
          properties: { service_name: 'worker', service_namespace: 'prod' },
        },
      ],
    });
    mockEvidenceChecks.mockReturnValue([
      {
        query:
          'FROM $.telemetry | WHERE @timestamp >= NOW() - 2 minutes | WHERE service.name == "worker" | STATS n=COUNT(*)',
        row: { n: '100' },
        checkedAt: Date.now(),
      },
    ]);
    mockReadExecute.mockResolvedValue({
      results: [{ sourceId: 'source-a', rows: [[100]], rowRefs: ['row-1'] }],
    });
    const agent = session();
    await agent.execute('source_esql', {
      template: 'custom',
      lookbackMinutes: 2,
      serviceNames: ['worker'],
      serviceNamespace: 'prod',
    });
    expect(
      await agent.execute('finish_exploration', {
        outcome: 'partial',
        summary: 'Scoped worker outcome checked',
        coverageComplete: false,
        remainingGaps: [],
        monitoringBlocker: 'No additional monitor validated',
      })
    ).toHaveProperty('finished', true);
  });

  it('does not reopen a problem deactivated by an operator', async () => {
    const prior = addActive();
    events.set(prior.event_id, { ...prior, status: 'inactive' });
    deactivations.mockResolvedValue([
      { episode_id: 'episode', reason: 'Dismissed by the operator.' },
    ]);
    const result = await session().execute('events', { ...input, eventId: prior.event_id });
    expect(result.operatorDismissalHonored).toBe(true);
    expect(events.get(prior.event_id)?.status).toBe('inactive');
  });
  it('does not finish a healthy observed estate without evaluating ongoing monitoring', async () => {
    const current = session();
    mockReadExecute.mockResolvedValue({
      results: [{ sourceId: 'source-a', rows: [{ operations: 42 }] }],
    });
    await current.execute('source_esql', {
      sourceIds: ['source-a'],
      template: 'custom',
      lookbackMinutes: 3,
      pipeline: 'STATS operations=COUNT(*)',
    });
    const result = await current.execute('finish_exploration', {
      outcome: 'partial',
      summary: 'Healthy current operations; monitoring not assessed.',
      coverageComplete: false,
      remainingGaps: ['No monitor was evaluated.'],
    });
    expect(result).toMatchObject({
      error: expect.stringContaining('monitoring was never evaluated'),
    });
    await current.execute('finish_exploration', {
      outcome: 'partial',
      summary: 'Observed outcomes are healthy; monitoring has an explicit data blocker.',
      coverageComplete: false,
      remainingGaps: [],
      monitoringBlocker:
        'No parsed operation-failure field was validated; broad keyword counts match benign JSON keys.',
    });
    expect(current.finished).toBe(true);
    expect(run.remainingGaps).toContain(
      'Monitoring: No parsed operation-failure field was validated; broad keyword counts match benign JSON keys.'
    );
  });
  it('persists actually observed new emitters before a learning run can finish', async () => {
    run.learningFocus = { mode: 'initial_learning', sources: [], note: 'Learn current emitters' };
    getFeatures.mockResolvedValue({ hits: [] });
    const agent = session();
    mockReadExecute.mockResolvedValue({ results: [{ sourceId: 'source-a', rowRefs: ['row-1'] }] });
    await agent.execute('source_esql', { template: 'custom', lookbackMinutes: 1 });
    const finish = {
      outcome: 'partial',
      summary: 'No current incident',
      coverageComplete: false,
      remainingGaps: [],
      monitoringBlocker: 'Useful monitoring needs additional payload validation',
    };
    expect(await agent.execute('finish_exploration', finish)).toMatchObject({
      finished: false,
      learningGaps: [
        { sourceId: 'source-a', name: 'api', namespace: 'prod', evidenceRef: 'row-1' },
      ],
    });
    expect(agent.finished).toBe(false);
    getFeatures.mockResolvedValue({
      hits: [
        {
          id: 'api',
          source_id: 'source-a',
          type: 'entity',
          properties: { name: 'api', service_namespace: 'prod' },
        },
      ],
    });
    expect(await agent.execute('finish_exploration', finish)).toMatchObject({
      finished: false,
      monitoringNotEvaluated: true,
    });
    await agent.execute('finish_exploration', finish);
    expect(agent.finished).toBe(true);
  });
});
