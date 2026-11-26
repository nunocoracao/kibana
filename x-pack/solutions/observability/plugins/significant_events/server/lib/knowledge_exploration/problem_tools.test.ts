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
import { toRuleEvent } from '../significant_events/events/to_rule_event';
import { EventDiscoveryToolSession } from '../event_discovery/tools';
import { MonitoringToolSession } from '../monitoring_setup/tools';
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
    outcome: { condition: 'operation failure', failedField: 'failures', healthyField: 'successes' },
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
        getKnowledgeIndicatorClient: async () => ({
          getFeatures,
          getTopologyFeaturesPage: getFeatures,
          getSourceToQueryLinksMap,
        }),
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
    mockEvidenceChecks.mockImplementation((_sourceId, refs) => [
      {
        query:
          'FROM $.telemetry | WHERE `@timestamp` >= NOW() - 2 minutes | STATS requests=COUNT(*)',
        row: {
          requests: '100',
          failures: refs?.includes('healthy') ? '0' : '20',
          successes: refs?.includes('healthy') ? '100' : '80',
          event_operation: 'serve',
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

  it('loads procedure text before inventory and rejects an unknown skill without any source read', async () => {
    const agent = session();
    await expect(agent.execute('load_skill', { name: 'manage-events' })).resolves.toMatchObject({
      name: 'manage-events',
      content: expect.stringContaining('## Confidence'),
    });
    await expect(agent.execute('load_skill', { name: 'other' })).resolves.toMatchObject({
      error: expect.any(String),
      available: expect.arrayContaining(['maintain-coverage']),
    });
    expect(search.findLatestByCurrentStatePaginated).not.toHaveBeenCalled();
    expect(mockReadExecute).not.toHaveBeenCalled();
  });

  it('asks for a feasible candidate check and records an independently blocked one as partial', async () => {
    const agent = session();
    const finish = {
      outcome: 'partial',
      coverageComplete: false,
      remainingGaps: [],
      summary: 'Active path needs confirmation',
    };
    expect(
      await agent.execute('finish_exploration', { ...finish, candidateStatus: 'needs_check' })
    ).toMatchObject({ finished: false, nextAction: expect.stringContaining('short exact') });
    expect(
      await agent.execute('finish_exploration', { ...finish, candidateStatus: 'blocked' })
    ).toMatchObject({ finished: false, nextAction: expect.stringContaining('candidateNote') });
    mockExaminedSources.add(source.id);
    expect(
      await agent.execute('finish_exploration', {
        ...finish,
        candidateStatus: 'blocked',
        candidateNote: 'Operation telemetry missing from the inspected source',
        monitoringBlocker: 'Source unavailable',
      })
    ).toMatchObject({
      finished: true,
      remainingGaps: expect.arrayContaining([
        'Operation telemetry missing from the inspected source',
      ]),
    });
  });

  it('normalizes mixed-case event slugs and reuses the same stored identity', async () => {
    const agent = session();
    const first = await agent.execute('events', {
      ...input,
      issueKey: input.issueKey.toUpperCase(),
    });
    const second = await agent.execute('events', input);
    expect(first.eventId).toBe(PROBLEM_EVENT_PREFIX + input.issueKey);
    expect(second.eventId).toBe(first.eventId);
    expect(events.size).toBe(1);
  });

  it('can close an existing event with fresh evidence while preserving its title', async () => {
    const agent = session();
    const created = await agent.execute('events', input);
    await agent.execute('events', {
      ...input,
      title: undefined,
      eventId: created.eventId,
      status: 'inactive',
      evidenceRefs: ['healthy'],
      assessmentNote: 'Successful operations resumed.',
    });
    expect(events.get(String(created.eventId))).toMatchObject({
      title: input.title,
      status: 'inactive',
    });
  });

  it.each(['blocker', 'native rule'])(
    'records a recovered event’s monitoring decision via %s',
    async (resolution) => {
      const agent = session();
      const { eventId } = await agent.execute('events', input);
      await agent.execute('events', { ...input, status: 'inactive', evidenceRefs: ['healthy'] });
      getFeatures.mockResolvedValue({
        hits: [
          {
            id: 'event-lesson',
            source_id: source.id,
            type: 'schema',
            properties: { kind: 'detection_learning', event_id: eventId },
          },
        ],
      });
      mockExaminedSources.add(source.id);
      const finish = {
        outcome: 'assessed',
        summary: 'Checked recovery.',
        coverageComplete: false,
        remainingGaps: [],
      };
      expect(
        await agent.execute('finish_exploration', {
          ...finish,
          monitoringBlocker: 'Traces are unavailable.',
        })
      ).toMatchObject({
        finished: false,
        uncoveredEventIds: [eventId],
      });
      if (resolution === 'native rule') {
        const upsert = jest
          .spyOn(MonitoringToolSession.prototype, 'execute')
          .mockResolvedValueOnce({
            native: true,
            saved: [{ ruleId: 'installed-rule', sourceId: source.id }],
          });
        try {
          await agent.execute('monitoring_rules', {
            action: 'upsert',
            sourceId: source.id,
            featureIds: ['event-lesson'],
          });
          expect(await agent.execute('finish_exploration', finish)).toMatchObject({
            finished: true,
          });
        } finally {
          upsert.mockRestore();
        }
        return;
      }
      const blocked = {
        ...finish,
        monitoringBlocker: 'Traces are unavailable.',
        eventMonitoringBlockers: [
          {
            eventId,
            reason:
              'The healthy and affected populations cannot yet be distinguished by the installed predicate.',
          },
        ],
      };
      expect(await agent.execute('finish_exploration', blocked)).toMatchObject({
        finished: false,
        untriedEventMonitors: [{ eventId }],
      });
      expect(await agent.execute('finish_exploration', blocked)).toMatchObject({ finished: true });
    }
  );

  it('keeps source discovery available when event inventory fails without allowing unchecked completion', async () => {
    const inventory = { sources: [{ id: source.id }], total: 1, hasMore: false, nextOffset: null };
    mockReadExecute.mockResolvedValue(inventory);
    search.findLatestByCurrentStatePaginated.mockRejectedValueOnce(
      new Error('Event search unavailable')
    );
    const agent = session();
    await expect(agent.execute('detection_sources', {})).resolves.toEqual(inventory);
    expect(search.findLatestByCurrentStatePaginated).not.toHaveBeenCalled();
    expect(getFeatures).not.toHaveBeenCalled();
    await expect(
      agent.execute('finish_exploration', {
        outcome: 'nothing_new',
        summary: 'No changes.',
        coverageComplete: true,
        remainingGaps: [],
      })
    ).rejects.toThrow('Event search unavailable');
    expect(agent.finished).toBe(false);
    const parameters = { offset: 1, limit: 1 };
    await expect(agent.execute('detection_sources', parameters)).resolves.toEqual(inventory);
    expect(mockReadExecute).toHaveBeenLastCalledWith('detection_sources', parameters);
    expect(search.findLatestByCurrentStatePaginated).toHaveBeenCalledTimes(1);
  });

  it.each(['active', 'inactive'])(
    'saves an evidence-backed %s assessment without count annotations',
    async (status) => {
      if (status === 'inactive') addActive();
      const check = mockEvidenceChecks()[0];
      mockEvidenceChecks.mockReturnValue([
        { ...check, row: { ...check.row, failures: undefined, successes: undefined } },
      ]);
      const result = await session().execute('events', { ...input, status, outcome: undefined });
      expect(events.get(String(result.eventId))).toMatchObject({
        status,
        signals: [{ verdict: 'inconclusive' }],
      });
    }
  );

  it.each([
    ['svc', 'ns', 'op'],
    ['service_name', 'service_namespace', 'event_operation'],
    ['emitter', 'environment', 'operation'],
  ])(
    'opens from measured outcomes grouped by %s and %s and retains the executed rows',
    async (name, namespace, operation) => {
      const check = mockEvidenceChecks()[0];
      const query =
        check.query.split(' | STATS')[0] +
        ` | STATS failed=COUNT(*) WHERE status == 503, healthy=COUNT(*) WHERE status == 200 BY ${name}=\`resource.attributes.service.name\`, ${namespace}=\`resource.attributes.service.namespace\`, ${operation} | SORT ${operation}`;
      const row = {
        [name]: 'api',
        [namespace]: 'prod',
        [operation]: 'open',
        failed: '36',
        healthy: '2107',
      };
      mockEvidenceChecks.mockReturnValue([{ ...check, query, row }]);
      const outcome = {
        condition: 'terminal timeout',
        failedField: 'failed',
        healthyField: 'healthy',
      };
      const result = await session().execute('events', {
        ...input,
        outcome: undefined,
        outcomes: [{ evidenceRef: 'row-1', ...outcome }],
      });
      expect(events.get(String(result.eventId))).toMatchObject({
        status: 'active',
        outcome_checks: [{ operation: 'open', failed: 36, healthy: 2107 }],
        signals: [
          { verdict: 'confirms', description: expect.stringContaining(JSON.stringify(row)) },
        ],
      });
    }
  );
  it('recognizes a service-wide outcome without conflating other grouping dimensions', async () => {
    const check = mockEvidenceChecks()[0];
    const row = { svc: 'api', ns: 'prod', failures: '10', successes: '20' };
    const query =
      check.query.split(' | STATS')[0] +
      ' | STATS failures=COUNT(*) WHERE status == 503, successes=COUNT(*) WHERE status == 200 BY svc=`service.name`, ns=`service.namespace`';
    mockEvidenceChecks.mockReturnValue([{ ...check, row, query }]);
    const { eventId } = await session().execute('events', input);
    expect(events.get(String(eventId))?.outcome_checks?.[0].operation).toBe('All operations');
    mockEvidenceChecks.mockReturnValue([
      { ...check, row: { ...row, tenant: 'x' }, query: query + ', tenant' },
    ]);
    expect(await session().execute('events', { ...input, eventId })).toMatchObject({
      status: 'active',
    });
  });

  it('opens a verified route failure when another selected entity has only contextual evidence', async () => {
    const api = {
      id: 'service-api',
      type: 'entity',
      source_id: source.id,
      properties: { name: 'api', service_namespace: 'prod' },
    };
    const worker = {
      ...api,
      id: 'service-worker',
      properties: { name: 'worker', service_namespace: 'prod' },
    };
    const edge = { ...api, id: 'dep-api-worker', type: 'dependency' };
    getFeatures.mockImplementation(async (_sources, options) => ({
      hits: [api, worker, edge].filter((f) => options.featureIds.includes(f.id)),
    }));
    const check = mockEvidenceChecks()[0];
    mockEvidenceChecks.mockReturnValue([
      {
        ...check,
        query:
          check.query.split(' | STATS')[0] +
          ' | STATS failures=COUNT(*) WHERE status == 503, successes=COUNT(*) WHERE status == 200 BY svc=`service.name`, ns=`service.namespace`, route',
        row: { svc: 'api', ns: 'prod', route: '/lookup', failures: '7', successes: '0' },
      },
    ]);
    const { eventId, affectedEntities } = await session().execute('events', {
      ...input,
      featureIds: [api.id, worker.id],
      causalFeatureIds: [edge.id],
    });
    expect(affectedEntities).toEqual([api.id, worker.id]);
    expect(events.get(String(eventId))).toMatchObject({
      status: 'active',
      outcome_checks: [{ operation: '/lookup', failed: 7 }],
      blast_radius: [{ feature_id: api.id }, { feature_id: worker.id }],
      causal_features: [{ feature_id: edge.id }],
      signals: [{ verdict: 'confirms' }],
    });
  });

  it('allows closure when the agent judges the residual failure rate to be normal', async () => {
    const { eventId } = await session().execute('events', input);
    const check = mockEvidenceChecks()[0];
    mockEvidenceChecks.mockReturnValue([
      { ...check, row: { ...check.row, failures: '1', successes: '9999' } },
    ]);
    await session().execute('events', { ...input, eventId, status: 'inactive' });
    expect(events.get(String(eventId))).toMatchObject({
      status: 'inactive',
      outcome_checks: [{ failed: 1, healthy: 9999 }],
    });
  });

  it('closes a rare failure using a longer clean window plus a fresh successful operation', async () => {
    jest.useFakeTimers();
    try {
      const check = mockEvidenceChecks()[0];
      mockEvidenceChecks.mockReturnValue([
        { ...check, row: { ...check.row, failures: '1', successes: '99' } },
      ]);
      const { eventId } = await session().execute('events', input);
      jest.advanceTimersByTime(11 * 60000);
      mockEvidenceChecks.mockImplementation((_id, refs) => [
        {
          ...check,
          checkedAt: Date.now(),
          query: check.query.replace('2 minutes', refs[0] === 'long' ? '10 minutes' : '2 minutes'),
          row: { ...check.row, failures: '0', successes: refs[0] === 'long' ? '300' : '2' },
        },
      ]);
      await session().execute('events', {
        ...input,
        eventId,
        evidenceRefs: ['healthy', 'long'],
        status: 'inactive',
      });
      expect(events.get(String(eventId))?.status).toBe('inactive');
    } finally {
      jest.useRealTimers();
    }
  });

  it('requires explicit ratings on creation and preserves ratings on update', async () => {
    await expect(session().execute('events', { ...input, severity: undefined })).rejects.toThrow(
      'severity and confidence'
    );
    const { eventId } = await session().execute('events', input);
    await session().execute('events', {
      ...input,
      eventId,
      severity: undefined,
      confidence: undefined,
    });
    expect(events.get(String(eventId))).toMatchObject({ severity: 'high', confidence: 0.9 });
  });

  it('persists measured outcomes and actual firing document identities separately from the source query', async () => {
    const firing = {
      sourceId: source.id,
      ruleId: 'rule',
      ruleName: 'API rule',
      documentId: 'hit-1',
      index: '.rule-events',
      timestamp: new Date().toISOString(),
      kind: 'signal' as const,
    };
    await expect(
      session().execute('events', { ...input, signalRefs: ['unknown'] })
    ).rejects.toThrow('fired_rules');
    const resolve = jest
      .spyOn(EventDiscoveryToolSession.prototype, 'resolveFiring')
      .mockReturnValue(firing);
    try {
      const { eventId } = await session().execute('events', { ...input, signalRefs: ['signal-1'] });
      expect(resolve).toHaveBeenCalledWith('signal-1', [source.id], expect.anything());
      expect(toRuleEvent(events.get(String(eventId))!).data).toMatchObject({
        outcome_checks: [{ failed: 20, healthy: 80, operation: 'serve' }],
        firing_references: [firing],
        monitoring_references: [],
        signals: [
          {
            type: 'query',
            verdict: 'confirms',
            metadata: { rule_name: 'Verified source evidence' },
          },
        ],
      });
    } finally {
      resolve.mockRestore();
    }
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
    'retains %s evidence when the agent closes a problem',
    async (kind) => {
      const prior = addActive();
      mockEvidenceChecks.mockReturnValue([
        {
          query: `FROM $.telemetry | WHERE \`@timestamp\` >= NOW() - ${
            kind === 'historical-window' ? 30 : kind === 'five-minute-window' ? 5 : 2
          } minutes`,
          row: { 'service.name': 'api', 'service.namespace': 'prod', successes: '100' },
          checkedAt: kind === 'expired-read' ? Date.now() - 4 * 60000 : Date.now(),
        },
      ]);
      await expect(
        session().execute('events', { ...input, eventId: prior.event_id, status: 'inactive' })
      ).resolves.toMatchObject({ status: 'inactive' });
      expect(events.get(prior.event_id)?.signals).toEqual(
        expect.arrayContaining([expect.objectContaining({ verdict: 'inconclusive' })])
      );
    }
  );

  it('preserves unchecked active problem IDs ahead of a full list of proposed gaps', async () => {
    const prior = addActive();
    const result = await session().execute('finish_exploration', {
      outcome: 'partial',
      summary: 'Partial review',
      coverageComplete: true,
      remainingGaps: Array.from({ length: 20 }, (_, i) => `Learning gap ${i}`),
    });
    expect(result).toMatchObject({
      finished: true,
      coverageComplete: false,
      remainingGaps: run.remainingGaps,
    });
    expect(run.remainingGaps).toHaveLength(20);
    expect(run.remainingGaps?.[0]).toBe(`Recheck active problem ${prior.event_id}`);
  });

  it('requires old active problems to be reviewed before a complete run can finish', async () => {
    const prior = addActive();
    const agent = session();
    const finish = {
      outcome: 'nothing_new',
      summary: 'No changes.',
      coverageComplete: true,
      remainingGaps: [],
    };
    expect(await agent.execute('finish_exploration', finish)).toMatchObject({
      status: 'continue',
      finished: false,
      uncheckedEventIds: [prior.event_id],
    });
    expect(agent.finished).toBe(false);
    await agent.execute('events', {
      action: 'review',
      outcome: input.outcome,
      eventId: prior.event_id,
      evidenceRefs: ['row-1'],
    });
    await agent.execute('finish_exploration', finish);
    expect(agent.finished).toBe(true);
    expect(run.coverageComplete).toBe(true);
  });

  it('closes and reopens the same problem identity across separate runs', async () => {
    const created = await session().execute('events', input);
    await session().execute('events', {
      ...input,
      eventId: created.eventId,
      evidenceRefs: ['healthy'],
      status: 'inactive',
    });
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

  it.each([4 * 60 * 60 * 1000, 4 * 60 * 60 * 1000 + 1])(
    'preserves inactive history and chooses the correct recurrence at age %i ms',
    async (age) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-11-24T10:00:00Z'));
      try {
        const created = await session().execute('events', input);
        await session().execute('events', {
          ...input,
          eventId: created.eventId,
          evidenceRefs: ['healthy'],
          status: 'inactive',
        });
        const closed = { ...events.get(String(created.eventId))! };
        jest.advanceTimersByTime(age);
        const resumed = await session().execute('events', { ...input, eventId: created.eventId });
        if (age === 4 * 60 * 60 * 1000) {
          expect(resumed.eventId).toBe(created.eventId);
          expect(events.size).toBe(1);
        } else {
          expect(resumed.eventId).not.toBe(created.eventId);
          expect(resumed).toMatchObject({
            issueKey: input.issueKey,
            previousEventId: created.eventId,
            createdNewOccurrence: true,
          });
          expect(events.get(String(created.eventId))).toEqual(closed);
          expect(events.get(String(resumed.eventId))?.status).toBe('active');
          const continued = await session().execute('events', {
            ...input,
            eventId: created.eventId,
          });
          expect(continued.eventId).toBe(resumed.eventId);
          expect(events.size).toBe(2);
          await session().execute('events', {
            ...input,
            eventId: resumed.eventId,
            evidenceRefs: ['healthy'],
            status: 'inactive',
          });
          const recentRecurrence = await session().execute('events', input);
          expect(recentRecurrence.eventId).toBe(resumed.eventId);
          expect(events.size).toBe(2);
        }
      } finally {
        jest.useRealTimers();
      }
    }
  );

  it('leaves an inactive closing assessment untouched instead of refreshing its age', async () => {
    const created = await session().execute('events', input);
    await session().execute('events', {
      ...input,
      eventId: created.eventId,
      evidenceRefs: ['healthy'],
      status: 'inactive',
    });
    const closed = { ...events.get(String(created.eventId))! };
    await session().execute('events', {
      ...input,
      eventId: created.eventId,
      status: 'inactive',
      summary: 'Redundant old assessment',
    });
    expect(events.get(String(created.eventId))).toEqual(closed);
    const index = await session().execute('events', { action: 'index' });
    expect(index.events).toEqual([]);
    expect(index.activeProblemsToReview).toEqual([]);
    expect(index).not.toHaveProperty('recentRecurrenceIdentities');
    await session().execute('events', {
      action: 'index',
      includeInactive: true,
      sourceIds: [source.id],
      featureIds: ['service-api'],
    });
    expect(search.findLatestByCurrentStatePaginated).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIds: [source.id],
        topologyFeatureIds: ['service-api'],
        status: undefined,
      })
    );
  });

  it('reuses the same event when the model passes its full ID as the issue key', async () => {
    const first = await session().execute('events', input);
    const updated = await session().execute('events', { ...input, issueKey: first.eventId });
    expect(updated.eventId).toBe(first.eventId);
    expect(events.size).toBe(1);
  });

  it('uses a valid existing eventId when the model redundantly changes the issueKey', async () => {
    const created = await session().execute('events', input);
    const continued = await session().execute('events', {
      ...input,
      eventId: created.eventId,
      issueKey: 'improved-description',
      title: 'A clearer title',
    });
    expect(continued).toMatchObject({ eventId: created.eventId, issueKey: input.issueKey });
    expect(events.get(String(created.eventId))?.title).toBe('A clearer title');
    expect(events.size).toBe(1);
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
    expect(events.get(String(result.eventId))?.signals?.[0].metadata.rule_uuid).toBeUndefined();
    expect(events.get(String(result.eventId))?.monitoring_references).toEqual([
      { sourceId: 'source-a', queryId: 'measurement' },
      { sourceId: 'source-a', queryId: 'monitor', ruleId: 'monitor' },
    ]);
    const refreshed = await session().execute('events', { ...input, eventId: result.eventId });
    expect(refreshed.monitoringNextAction).toBeUndefined();
    expect(refreshed.monitoringReferences).toContainEqual(
      expect.objectContaining({ queryId: 'monitor', ruleId: 'monitor' })
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
    const cursor = { sourceId: 'source-a', type: 'schema', id: 'first' };
    getFeatures.mockResolvedValueOnce({ hits: [], nextCursor: cursor }).mockResolvedValue({
      hits: [
        {
          source_id: 'source-a',
          type: 'schema',
          properties: { kind: 'detection_learning', event_id: event.eventId },
        },
      ],
    });
    expect(await agent.execute('finish_exploration', finish)).toMatchObject({
      finished: false,
      uncoveredEventIds: [event.eventId],
    });
    expect(getFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ after: cursor, featureTypes: ['schema'], sourceIds: ['source-a'] })
    );
  });

  it.each(['active', 'inactive'] as const)(
    'allows a distinct issue key on overlapping %s entities',
    async (status) => {
      const prior = await session().execute('events', { ...input, status: 'active' });
      const event = events.get(String(prior.eventId));
      if (!event) throw new Error('Missing created event');
      events.set(event.event_id, { ...event, status });
      const agent = session();
      await agent.execute('events', { action: 'index' });
      const result = await agent.execute('events', { ...input, issueKey: 'same-path-new-label' });
      expect(result.eventId).not.toBe(prior.eventId);
      const updated = await agent.execute('events', { ...input, eventId: prior.eventId });
      expect(updated.eventId).toBe(prior.eventId);
      expect(events.size).toBe(2);
    }
  );

  it('keeps inactive history out of routine event checks while allowing explicit identity lookup', async () => {
    const prior = await session().execute('events', input);
    await session().execute('events', {
      ...input,
      eventId: prior.eventId,
      evidenceRefs: ['healthy'],
      status: 'inactive',
    });
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

  it.each([
    { error: '403 forbidden' },
    { status: 'unavailable', nextAction: 'No timestamp for a bounded time probe.' },
  ])('allows an honest partial exit for an unavailable source: %j', async (failure) => {
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
      results: [{ sourceId: 'source-a', ...failure }],
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
      expect(result).toMatchObject({
        status: 'finished',
        finished: true,
        coverageComplete: false,
        outcome: 'partial',
        remainingGaps: run.remainingGaps,
      });
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
    await expect(current.execute('monitoring_rules', { action: 'invalid' })).rejects.toThrow();
    const result = await current.execute('finish_exploration', {
      outcome: 'partial',
      summary: 'Healthy current operations; monitoring not assessed.',
      coverageComplete: false,
      remainingGaps: ['No monitor was evaluated.'],
    });
    expect(result).toMatchObject({
      status: 'continue',
      nextAction: expect.stringContaining('monitoring was never evaluated'),
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
  it('learns a namespace-less service from the source census before any outcome is measured', async () => {
    run.learningFocus = { mode: 'initial_learning', sources: [], note: 'Cold source' };
    mockEmittingServices.push({
      sourceId: 'source-a',
      name: 'worker',
      namespace: '',
      evidenceRef: 'census-ref',
    });
    getFeatures.mockResolvedValue({ hits: [] });
    const agent = session();
    const finish = {
      outcome: 'partial',
      summary: 'Examined inventory',
      coverageComplete: false,
      remainingGaps: [],
    };
    expect(await agent.execute('finish_exploration', finish)).toMatchObject({
      learningGaps: [{ name: 'worker', evidenceRef: 'census-ref' }],
    });
    getFeatures.mockResolvedValue({
      hits: [{ source_id: 'source-a', subtype: 'service', properties: { name: 'worker' } }],
    });
    expect(await agent.execute('finish_exploration', finish)).not.toHaveProperty('learningGaps');
  });
  it.each(['name', 'service_name'])(
    'recognizes persisted source-local emitters with %s before finishing',
    async (key) => {
      run.learningFocus = { mode: 'initial_learning', sources: [], note: 'Learn current emitters' };
      getFeatures.mockResolvedValue({ hits: [] });
      const agent = session();
      mockReadExecute.mockResolvedValue({
        results: [{ sourceId: 'source-a', rowRefs: ['row-1'] }],
      });
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
            subtype: 'service',
            properties: { [key]: 'api', service_namespace: 'prod' },
          },
        ],
      });
      expect(await agent.execute('finish_exploration', finish)).toMatchObject({
        finished: false,
        monitoringNotEvaluated: true,
      });
      await agent.execute('finish_exploration', finish);
      expect(agent.finished).toBe(true);
    }
  );
});
