/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { KibanaRequest } from '@kbn/core/server';
import type { ToolDefinition } from '@kbn/inference-common';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import type { SignificantEvent } from '@kbn/significant-events-schema';
import { significantEventSchema } from '@kbn/significant-events-schema';
import { lazySchema, z } from '@kbn/zod/v4';
import type { ExplorationCheckpoint, ExplorationRun } from '../../../common/knowledge_exploration';
import type { RouteHandlerScopedClients } from '../../routes/types';
import type { SignificantEventsServer } from '../../types';
import { discoveryTools, EventDiscoveryToolSession } from '../event_discovery/tools';
import { monitoringTools, MonitoringToolSession } from '../monitoring_setup/tools';
import { explorationTools, ExplorationToolSession } from './tools';

export const PROBLEM_EVENT_PREFIX = 'nightshift-problem-';
const text = lazySchema(() => z.string().min(1).max(255));
const eventInput = lazySchema(() =>
  z.object({
    action: z.enum(['index', 'read', 'upsert', 'review']),
    eventId: text.optional(),
    eventIds: z.array(text).max(25).default([]),
    issueKey: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .max(180)
      .optional(),
    sourceIds: z.array(text).max(50).default([]),
    evidenceRefs: z.array(text).max(50).default([]),
    featureIds: z.array(text).max(50).default([]),
    causalFeatureIds: z.array(text).max(50).default([]),
    title: z.string().min(1).max(255).optional(),
    summary: z.string().min(1).max(4000).optional(),
    assessmentNote: z.string().min(1).max(900).optional(),
    hypothesis: z.string().max(2000).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).default('low'),
    confidence: z.number().min(0).max(1).default(0.5),
    offset: z.number().int().min(0).max(10000).default(0),
    limit: z.number().int().min(1).max(100).default(25),
  })
);

export const problemTools: Record<string, ToolDefinition> = {
  ...explorationTools,
  ...monitoringTools,
  ...discoveryTools,
  knowledge_indicators: explorationTools.knowledge_indicators,
  events: {
    ...discoveryTools.events,
    description:
      'Index/read/upsert this agent’s native significant events, or review an unchanged active event. Direct source telemetry is sufficient: rules, signals and KIs are OPTIONAL. Index existing problems before creating any. issueKey is a stable lowercase slug naming namespace, service/operation and failure mechanism, never a time or run ID. Reuse eventId and issueKey for continuation, recovery and recurrence. upsert requires sourceIds, evidenceRefs from THIS run, title, summary, assessmentNote and active/inactive status. Every selected source needs fresh evidence from source_esql lookbackMinutes<=3, endOffsetMinutes=0. Historical errors do not establish current failure. For recovery, verify positive healthy operation outcomes and clearance of all confirming mechanisms; missing data, a stopped container or a successful fault revert alone do not prove recovery. New healthy/false-alarm candidates create no events. Review means the existing operational problem remains supported; refuted or benign earlier findings must be updated inactive, not merely left active. Review an unchanged active event with action=review, eventId and current evidenceRefs; finish requires every prior active problem reviewed, or an honest partial outcome. Feature IDs are optional actual logical KI IDs in the selected sources. Operator deactivations are honored. Actual queries/results remain in the run trace; the native event links to the run in its assessment note.',
    schema: {
      type: 'object',
      required: ['action'],
      properties: {
        ...discoveryTools.events.schema?.properties,
        action: { type: 'string', enum: ['index', 'read', 'upsert', 'review'] },
      },
    },
  },
  finish_exploration: discoveryTools.finish_exploration,
};

/** One source/evidence session and one objective, with the tools of the three earlier agents. */
export class ProblemToolSession {
  private reads: ExplorationToolSession;
  private monitoring: MonitoringToolSession;
  private discovery: EventDiscoveryToolSession;
  private initialActive = new Set<string>();
  private reviewed = new Set<string>();
  private prepared?: Promise<void>;
  private inventoryComplete = true;
  finished = false;

  constructor(
    server: SignificantEventsServer,
    private clients: RouteHandlerScopedClients,
    request: KibanaRequest,
    private run: ExplorationRun,
    private sources: NightshiftSource[],
    checkpoints: Record<string, ExplorationCheckpoint>,
    private signal: AbortSignal
  ) {
    this.reads = new ExplorationToolSession(
      server,
      clients,
      request,
      run,
      sources,
      checkpoints,
      signal
    );
    this.monitoring = new MonitoringToolSession(
      server,
      clients,
      request,
      run,
      sources,
      checkpoints,
      signal,
      this.reads
    );
    this.discovery = new EventDiscoveryToolSession(
      server,
      clients,
      request,
      run,
      sources,
      checkpoints,
      signal,
      this.reads
    );
  }

  public get examined() {
    return this.reads.examined;
  }
  public get pendingCheckpoints() {
    return this.reads.pendingCheckpoints;
  }
  public get blocked() {
    return this.reads.blocked;
  }

  private async prepare(): Promise<void> {
    this.prepared ??= (async () => {
      const search = await this.clients.getEventSearchClient();
      for (let page = 1; page <= 10; page++) {
        const result = await search.findLatestByCurrentStatePaginated({
          sourceIds: this.sources.filter((source) => source.enabled).map((source) => source.id),
          status: ['active', 'recovering'],
          page,
          perPage: 100,
        });
        for (const event of result.hits) {
          if (event.event_id.startsWith(PROBLEM_EVENT_PREFIX))
            this.initialActive.add(event.event_id);
        }
        if (result.hits.length < 100 || page * 100 >= result.total) return;
      }
      this.inventoryComplete = false;
    })();
    return this.prepared;
  }

  async execute(name: string, parameters: object): Promise<Record<string, unknown>> {
    this.signal.throwIfAborted();
    await this.prepare();
    if (name === 'events') return this.events(parameters);
    if (name === 'finish_exploration') {
      const args = z
        .object({
          outcome: z.enum(['assessed', 'nothing_new', 'partial']),
          summary: z.string().min(1).max(2000),
          coverageComplete: z.boolean(),
          remainingGaps: z.array(z.string().min(1).max(500)).max(20),
        })
        .parse(parameters);
      const unchecked = [...this.initialActive].filter((id) => !this.reviewed.has(id));
      if ((unchecked.length || !this.inventoryComplete) && args.outcome !== 'partial') {
        return {
          error:
            'Recheck all existing active problems before completing, or finish partial with the unresolved work.',
          uncheckedEventIds: unchecked,
          inventoryComplete: this.inventoryComplete,
        };
      }
      this.run.outcome = args.outcome;
      this.run.summary = args.summary;
      this.run.coverageComplete =
        args.coverageComplete && !unchecked.length && this.inventoryComplete;
      this.run.remainingGaps = [
        ...args.remainingGaps,
        ...unchecked.map((id) => `Recheck active problem ${id}`),
      ].slice(0, 20);
      this.finished = true;
      return { finished: true, ...args, uncheckedEventIds: unchecked };
    }
    if (name === 'monitoring_rules' || name === 'monitoring_inventory')
      return this.monitoring.execute(name, parameters);
    if (name === 'fired_rules' || name === 'rule_change_points')
      return this.discovery.execute(name, parameters);
    return this.reads.execute(name, parameters);
  }

  private async events(parameters: object): Promise<Record<string, unknown>> {
    const args = eventInput.parse(
      Object.fromEntries(
        Object.entries(parameters).filter(([, value]) => value !== '' && value !== null)
      )
    );
    const search = await this.clients.getEventSearchClient();
    const enabled = new Set(
      this.sources.filter((source) => source.enabled).map((source) => source.id)
    );
    if (args.action === 'index') {
      const result = await search.findLatestByCurrentStatePaginated({
        sourceIds: [...enabled],
        page: Math.floor(args.offset / args.limit) + 1,
        perPage: args.limit,
      });
      return {
        events: result.hits
          .filter((event) => event.event_id.startsWith(PROBLEM_EVENT_PREFIX))
          .map((event) => ({
            eventId: event.event_id,
            issueKey: event.event_id.slice(PROBLEM_EVENT_PREFIX.length),
            status: event.status,
            title: event.title,
            summary: event.summary,
            assessmentNote: event.assessment_note,
            sourceIds: event.source_ids,
            affectedEntities: event.blast_radius ?? [],
            causalFeatures: event.causal_features ?? [],
          })),
        total: result.total,
        hasMore: args.offset + args.limit < result.total,
        nextOffset: args.offset + args.limit,
        activeProblemsToReview: [...this.initialActive].filter((id) => !this.reviewed.has(id)),
      };
    }
    if (args.action === 'read') {
      const events = [...(await search.findLatestByEventIds(args.eventIds)).values()];
      return {
        events: events.filter(
          (event) =>
            event.event_id.startsWith(PROBLEM_EVENT_PREFIX) &&
            event.source_ids.some((id) => enabled.has(id))
        ),
      };
    }
    const id = args.eventId ?? (args.issueKey ? PROBLEM_EVENT_PREFIX + args.issueKey : undefined);
    if (!id?.startsWith(PROBLEM_EVENT_PREFIX))
      throw new Error('Use an existing owned eventId or a stable issueKey.');
    const prior = await search.findLatestByEventId(id);
    if (args.eventId && !prior)
      throw new Error('eventId must identify an existing event in this space.');
    if (args.issueKey && id !== PROBLEM_EVENT_PREFIX + args.issueKey)
      throw new Error('Preserve the original issueKey on continuing problems.');
    const sourceIds = args.sourceIds.length ? args.sourceIds : prior?.source_ids ?? [];
    if (!sourceIds.length || sourceIds.some((sourceId) => !enabled.has(sourceId)))
      throw new Error('Every source must be enabled in this space.');
    if (prior && prior.source_ids.some((sourceId) => !sourceIds.includes(sourceId)))
      throw new Error(
        'Recheck every source already confirming this problem; do not drop unchecked sources.'
      );
    const checks = sourceIds.flatMap((sourceId) =>
      args.evidenceRefs.flatMap((ref) => {
        try {
          return this.reads
            .getEvidenceChecks(sourceId, [ref])
            .map((entry) => ({ ...entry, sourceId, ref }));
        } catch {
          return [];
        }
      })
    );
    if (args.evidenceRefs.some((ref) => !checks.some((check) => check.ref === ref)))
      throw new Error('Evidence refs must be actual rows from this run and selected sources.');
    for (const sourceId of sourceIds) {
      if (
        !checks.some(
          (check) =>
            check.sourceId === sourceId &&
            Date.now() - check.checkedAt <= 3 * 60000 &&
            /WHERE\s+`@timestamp`\s*>=\s*NOW\(\)\s*-\s*[123] minutes/i.test(check.query) &&
            !/`@timestamp`\s*<\s*NOW\(\)/i.test(check.query)
        )
      ) {
        throw new Error(
          'Check current outcomes for EVERY source with lookbackMinutes<=3, endOffsetMinutes=0, and cite those evidenceRefs. Old errors and missing traffic do not prove current failure or recovery.'
        );
      }
    }
    if (args.action === 'review') {
      if (!prior) throw new Error('Review an existing event.');
      this.reviewed.add(id);
      return { reviewed: true, eventId: id, status: prior.status };
    }
    if (!args.title || !args.summary || !args.assessmentNote || !args.status)
      throw new Error('upsert requires title, summary, assessmentNote, and status.');
    if (!prior && args.status === 'inactive')
      return { ignored: true, reason: 'Healthy or refuted candidates do not create events.' };
    if (prior?.status === 'inactive') {
      const deactivations = await search.findEventDeactivations(id);
      if (deactivations.some((entry) => entry.episode_id === prior.episode_id)) {
        this.reviewed.add(id);
        return { eventId: id, operatorDismissalHonored: true, status: 'inactive' };
      }
    }
    const ki = await this.clients.getKnowledgeIndicatorClient();
    const features = args.featureIds.length
      ? (await ki.getFeatures(sourceIds, { limit: 10000 })).hits.filter((feature) =>
          args.featureIds.includes(feature.id)
        )
      : [];
    if (new Set(features.map((feature) => feature.id)).size !== new Set(args.featureIds).size)
      throw new Error('Use actual logical KI IDs in these sources. KIs are optional.');
    if (args.causalFeatureIds.some((featureId) => !args.featureIds.includes(featureId)))
      throw new Error('Causal feature IDs must be a subset of featureIds.');
    const event: SignificantEvent = significantEventSchema.parse({
      ...(prior ?? {}),
      event_id: id,
      '@timestamp': new Date().toISOString(),
      source_ids: sourceIds,
      title: prior?.title ?? args.title,
      summary: args.summary,
      status: args.status,
      severity: args.status === 'inactive' && prior ? prior.severity : args.severity,
      confidence: args.confidence,
      symptom_hypothesis: args.hypothesis ?? prior?.symptom_hypothesis,
      assessment_note: args.assessmentNote + '\nEvidence: Agent Explorer run ' + this.run.id,
      signals: [],
      blast_radius: features
        .filter((feature) => feature.type === 'entity')
        .map((feature) => ({
          type: 'entity',
          feature_id: feature.id,
          subtype: feature.subtype,
          name: feature.title || feature.id,
          source_id: feature.source_id,
        })),
      causal_features: features
        .filter((feature) => args.causalFeatureIds.includes(feature.id))
        .map((feature) => ({
          feature_id: feature.id,
          type: feature.type,
          subtype: feature.subtype,
          name: feature.title || feature.id,
          source_id: feature.source_id,
        })),
    });
    this.signal.throwIfAborted();
    if (prior) {
      const result = await search.updateEvent({ event, prior, origin: { actor: 'agent_tool' } });
      if (!result.updated)
        throw new Error('Event changed concurrently; read the latest version and reassess.');
    } else await search.createEvent({ event, origin: { actor: 'agent_tool' } });
    this.reviewed.add(id);
    this.run.written++;
    this.run.discovery ??= { signalCount: 0, active: 0, inactive: 0, excludedUnattributed: 0 };
    this.run.discovery[args.status]++;
    return {
      eventId: id,
      issueKey: id.slice(PROBLEM_EVENT_PREFIX.length),
      status: args.status,
      storedAs: 'native_alert',
      evidence: checks,
    };
  }
}
