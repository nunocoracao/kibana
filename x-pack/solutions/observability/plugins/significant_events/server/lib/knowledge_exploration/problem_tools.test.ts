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
jest.mock('./tools', () => ({
  ...jest.requireActual('./tools'),
  ExplorationToolSession: jest.fn().mockImplementation(() => ({
    pendingCheckpoints: {},
    examined: new Set(),
    blocked: false,
    execute: jest.fn(),
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
        getKnowledgeIndicatorClient: async () => ({ getFeatures }),
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
    jest.clearAllMocks();
    events = new Map();
    deactivations.mockResolvedValue([]);
    mockEvidenceChecks.mockImplementation(() => [
      {
        query:
          'FROM $.telemetry | WHERE `@timestamp` >= NOW() - 2 minutes | STATS requests=COUNT(*)',
        row: { requests: '100', failures: '20' },
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

  it('creates a native problem directly from current source evidence with no KI or fired rule prerequisite', async () => {
    const result = await session().execute('events', input);
    expect(events.get(String(result.eventId))?.status).toBe('active');
    expect(getFeatures).not.toHaveBeenCalled();
    expect(run.written).toBe(1);
  });

  it.each(['historical-window', 'expired-read'])(
    'refuses to close a problem using %s evidence',
    async (kind) => {
      const prior = addActive();
      mockEvidenceChecks.mockReturnValue([
        {
          query: `FROM $.telemetry | WHERE \`@timestamp\` >= NOW() - ${
            kind === 'historical-window' ? 30 : 2
          } minutes`,
          row: { successes: '100' },
          checkedAt: kind === 'expired-read' ? Date.now() - 4 * 60000 : Date.now(),
        },
      ]);
      await expect(
        session().execute('events', { ...input, eventId: prior.event_id, status: 'inactive' })
      ).rejects.toThrow('current outcomes');
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
    await session().execute('events', { ...input, eventId: created.eventId });
    expect(events.size).toBe(1);
    expect(events.get(String(created.eventId))?.status).toBe('active');
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
});
