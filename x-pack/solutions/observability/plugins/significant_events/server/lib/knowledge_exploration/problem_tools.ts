/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { randomUUID } from 'node:crypto';
import type { KibanaRequest } from '@kbn/core/server';
import type { ToolDefinition } from '@kbn/inference-common';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import type { SignificantEvent } from '@kbn/significant-events-schema';
import { significantEventSchema, SEVERITY_CONTRACT_RULE } from '@kbn/significant-events-schema';
import { lazySchema, z } from '@kbn/zod/v4';
import type { ExplorationCheckpoint, ExplorationRun } from '../../../common/knowledge_exploration';
import type { RouteHandlerScopedClients } from '../../routes/types';
import type { SignificantEventsServer } from '../../types';
import { discoveryTools, EventDiscoveryToolSession } from '../event_discovery/tools';
import { monitoringTools, MonitoringToolSession } from '../monitoring_setup/tools';
import { explorationTools, ExplorationToolSession } from './tools';
import { buildEventQuerySignals, resolveEventFeatures } from './event_evidence';
import { rowIdentity } from './dependency_evidence';

export const PROBLEM_EVENT_PREFIX = 'nightshift-problem-';
const INACTIVE_EVENT_REUSE_MS = 4 * 60 * 60 * 1000;
const problemIdentity = (id: string): string =>
  id.replace(/--[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/, '');
const expiredInactiveEvent = (event: SignificantEvent): boolean =>
  event.status === 'inactive' &&
  Date.now() - Date.parse(event['@timestamp']) > INACTIVE_EVENT_REUSE_MS;
const text = lazySchema(() => z.string().min(1).max(255));
const boundedText = (maxLength: number, minLength = 1) => ({
  type: 'string' as const,
  minLength,
  maxLength,
});
const boundedTexts = (maxItems: number, maxLength: number) => ({
  type: 'array' as const,
  maxItems,
  items: boundedText(maxLength),
});
const eventInput = lazySchema(() =>
  z.object({
    action: z.enum(['index', 'read', 'upsert', 'review']),
    includeInactive: z.boolean().default(false),
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
    queryIds: z.array(text).max(25).default([]),
    ruleIds: z.array(text).max(10).default([]),
    causalFeatureIds: z.array(text).max(50).default([]),
    separateFromEventIds: z.array(text).max(25).default([]),
    distinctProblemReason: z.string().min(20).max(500).optional(),
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

const eventConfidence = {
  type: 'number' as const,
  minimum: 0,
  maximum: 1,
  description:
    'Event confidence is 0 to 1, for example 0.9. KI confidence uses a different 0 to 100 scale.',
};

export const problemTools: Record<string, ToolDefinition> = {
  ...explorationTools,
  ...monitoringTools,
  ...discoveryTools,
  knowledge_indicators: explorationTools.knowledge_indicators,
  events: {
    ...discoveryTools.events,
    description:
      'Index/read/upsert this agent’s native significant events, or review an unchanged active event. Index defaults to active/recovering problems only. Use includeInactive=true only after current telemetry suggests a recurrence or identity lookup; inactive events do not need routine health checks. Direct source telemetry can establish a problem before a rule fires. Every write must have actual query signals and at least one affected entity reference. The server attaches executed query evidence automatically; pass actual featureIds for affected services/dependencies, queryIds for saved measurements and ruleIds for relevant native monitors. It can resolve cited emitting service rows to existing KIs when namespace is unambiguous. Save a missing verified entity first. Surface a confirmed problem immediately with its executed query signals; create useful problem-specific native monitoring afterward and attach its real ruleIds; never invent a firing or detection ID. Index existing problems before creating any. A new issueKey overlapping prior affected entities requires identity review: reuse the prior event for continuation, recent recurrence or narrowed attribution. Inactive events older than four hours are preserved: the tool automatically creates a new occurrence for a fresh active finding. Only a genuinely independent mechanism may use separateFromEventIds with an explicit distinctProblemReason. issueKey is a stable lowercase slug naming namespace, service/operation and failure mechanism, never a time or run ID. Reuse eventId and issueKey for continuation and recovery. For recurrence, pass the known identity; the server reopens only within four hours of the last inactive assessment, then creates a new event without modifying the old one. A valid eventId is authoritative if a redundant issueKey differs. upsert requires sourceIds, evidenceRefs from THIS run, title, summary, assessmentNote and active/inactive status. Every selected source needs fresh evidence from source_esql lookbackMinutes<=3, endOffsetMinutes=0. Historical errors do not establish current failure. For recovery, verify positive healthy operation outcomes and clearance of all confirming mechanisms; missing data, a stopped container or a successful fault revert alone do not prove recovery. New healthy/false-alarm candidates create no events. Review means the existing operational problem remains supported; refuted or benign earlier findings must be updated inactive, not merely left active. Review an unchanged active event with action=review, eventId and current evidenceRefs; finish requires every prior active problem reviewed, or an honest partial outcome. assessmentNote must fit 900 characters. Confidence is 0 to 1. causalFeatureIds must also appear in featureIds. Use the canonical event severity and confidence contracts in the system instructions. Feature IDs are optional actual logical KI IDs in the selected sources. Operator deactivations are honored. Actual queries/results remain in the run trace; the native event links to the run in its assessment note.',
    schema: {
      type: 'object',
      required: ['action'],
      properties: {
        ...discoveryTools.events.schema?.properties,
        action: { type: 'string', enum: ['index', 'read', 'upsert', 'review'] },
        includeInactive: {
          type: 'boolean',
          description:
            'Index only: defaults to false. Include closed history only for a fresh candidate’s recurrence/identity check, not routine reinspection.',
        },
        assessmentNote: boundedText(900),
        summary: boundedText(4000),
        confidence: eventConfidence,
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: SEVERITY_CONTRACT_RULE,
        },
        separateFromEventIds: boundedTexts(25, 255),
        distinctProblemReason: boundedText(500, 20),
        queryIds: { type: 'array', items: boundedText(255) },
        ruleIds: { type: 'array', items: boundedText(255) },
      },
    },
  },
  finish_exploration: {
    ...discoveryTools.finish_exploration,
    description: `${discoveryTools.finish_exploration.description} Summary max 2000 characters; at most 20 remainingGaps, each max 500 characters. Optional monitoringBlocker records a concrete data/query/coverage reason why useful monitoring cannot be evaluated; do not claim installed coverage.`,
    schema: {
      ...discoveryTools.finish_exploration.schema,
      type: 'object',
      properties: {
        ...discoveryTools.finish_exploration.schema?.properties,
        summary: boundedText(2000),
        remainingGaps: boundedTexts(20, 500),
        monitoringBlocker: boundedText(500),
      },
    },
  },
};

/** One source/evidence session and one objective, with the tools of the three earlier agents. */
const pendingSourceSignature = (
  entries: Array<{ sourceId: string; name: string; namespace: string; missing?: readonly string[] }>
): string =>
  JSON.stringify(
    entries
      .map((entry) =>
        JSON.stringify([entry.sourceId, entry.name, entry.namespace, entry.missing ?? []])
      )
      .sort()
  );

export class ProblemToolSession {
  private reads: ExplorationToolSession;
  private monitoring: MonitoringToolSession;
  private discovery: EventDiscoveryToolSession;
  private initialActive = new Set<string>();
  private reviewed = new Set<string>();
  private prepared?: Promise<void>;
  private inventoryComplete = true;
  private monitoringAssessed = false;
  private observedEmitters = new Map<
    string,
    { sourceId: string; name: string; namespace: string; evidenceRef: string; checkedAt: number }
  >();
  private knowledgeWriteBlocked = false;
  private requestedCurrentRefresh = false;
  private pendingCurrentRefresh = new Set<string>();
  private planningFeedbackSent = false;
  private pendingFeedback = new Map<string, { signature: string; repeats: number }>();
  private stalledWork?: string;

  private continuePendingWork(kind: string, signature: string): boolean {
    if (this.stalledWork) return false;
    const prior = this.pendingFeedback.get(kind);
    const repeats = prior?.signature === signature ? prior.repeats + 1 : 1;
    this.pendingFeedback.set(kind, { signature, repeats });
    if (repeats < 3) return true;
    this.stalledWork = kind;
    return false;
  }

  private labelSource<T extends { sourceId: string }>(entry: T) {
    const source = this.sources.find((item) => item.id === entry.sourceId);
    return { ...entry, sourceType: source?.type, sourceTitle: source?.title };
  }
  private knownEvents = new Map<string, SignificantEvent>();
  private historicalIdentityChecks = new Set<string>();
  private unavailableSources = new Map<string, string>();
  private checkedWithoutRows = new Map<
    string,
    { sourceId: string; name: string; namespace: string }
  >();
  private payloadInspected = new Set<string>();
  private latencyChecks = new Map<string, Set<'current' | 'historical'>>();
  private unavailableLatency = new Map<string, Set<'current' | 'historical'>>();
  private eventLearningCandidates = new Map<
    string,
    { eventId: string; sourceIds: string[]; evidenceRefs: string[] }
  >();
  private incompleteAggregates = new Map<string, { sourceId: string; nextOffset: number }>();
  finished = false;

  constructor(
    private server: SignificantEventsServer,
    private clients: RouteHandlerScopedClients,
    private request: KibanaRequest,
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
          if (event.event_id.startsWith(PROBLEM_EVENT_PREFIX)) {
            this.initialActive.add(event.event_id);
            this.knownEvents.set(event.event_id, event);
          }
        }
        if (result.hits.length < 100 || page * 100 >= result.total) return;
      }
      this.inventoryComplete = false;
    })();
    return this.prepared;
  }

  private async loadHistoricalIdentities(sourceIds: string[], featureIds: string[]): Promise<void> {
    const key = JSON.stringify([[...sourceIds].sort(), [...featureIds].sort()]);
    if (this.historicalIdentityChecks.has(key)) return;
    const search = await this.clients.getEventSearchClient();
    for (let page = 1; page <= 10; page++) {
      const result = await search.findLatestByCurrentStatePaginated({
        sourceIds,
        topologyFeatureIds: featureIds,
        status: ['inactive'],
        page,
        perPage: 100,
      });
      for (const event of result.hits)
        if (event.event_id.startsWith(PROBLEM_EVENT_PREFIX))
          this.knownEvents.set(event.event_id, event);
      if (page * 100 >= result.total || result.hits.length < 100) {
        this.historicalIdentityChecks.add(key);
        return;
      }
    }
    throw new Error(
      'Historical identity lookup is incomplete. Resolve the existing eventId before creating another problem on these entities.'
    );
  }

  async execute(name: string, parameters: object): Promise<Record<string, unknown>> {
    this.signal.throwIfAborted();
    await this.prepare();
    if (name === 'events') return this.events(parameters);
    if (name === 'knowledge_indicators') {
      try {
        const result = await this.reads.execute(name, parameters);
        if ('action' in parameters && parameters.action === 'upsert') {
          const saved = Array.isArray(result.saved) ? result.saved.length : 0;
          this.knowledgeWriteBlocked =
            !saved && Array.isArray(result.rejected) && result.rejected.length > 0;
        }
        return result;
      } catch (error) {
        this.knowledgeWriteBlocked = true;
        throw error;
      }
    }
    if (name === 'source_esql') {
      const result = await this.reads.execute(name, parameters);
      if (Array.isArray(result.results)) {
        for (const read of result.results) {
          if (
            read &&
            typeof read === 'object' &&
            'sourceId' in read &&
            typeof read.sourceId === 'string' &&
            'error' in read &&
            typeof read.error === 'string' &&
            /forbidden|unauthorized|not authorized|unavailable|timed out|timeout|Unknown index/i.test(
              read.error
            )
          ) {
            this.unavailableSources.set(read.sourceId, read.error.slice(0, 500));
          }
          if (
            read &&
            typeof read === 'object' &&
            'sourceId' in read &&
            typeof read.sourceId === 'string' &&
            !('error' in read && read.error) &&
            !('requiresPlanning' in read && read.requiresPlanning) &&
            (!('template' in parameters) ||
              !['volume', 'schema'].includes(String(parameters.template)))
          ) {
            this.reads.examined.add(read.sourceId);
            this.unavailableSources.delete(read.sourceId);
            if (
              (('rows' in read && Array.isArray(read.rows) && !read.rows.length) ||
                ('empty' in read && read.empty === true)) &&
              'lookbackMinutes' in parameters &&
              typeof parameters.lookbackMinutes === 'number' &&
              parameters.lookbackMinutes <= 3 &&
              (!('endOffsetMinutes' in parameters) || parameters.endOffsetMinutes === 0) &&
              'serviceNamespace' in parameters &&
              typeof parameters.serviceNamespace === 'string' &&
              'serviceNames' in parameters &&
              Array.isArray(parameters.serviceNames)
            ) {
              for (const serviceName of parameters.serviceNames.filter(
                (value): value is string => typeof value === 'string'
              ))
                this.checkedWithoutRows.set(
                  JSON.stringify([read.sourceId, serviceName, parameters.serviceNamespace]),
                  {
                    sourceId: read.sourceId,
                    name: serviceName,
                    namespace: parameters.serviceNamespace,
                  }
                );
            }

            if (
              'template' in parameters &&
              parameters.template === 'custom' &&
              'pipeline' in parameters &&
              typeof parameters.pipeline === 'string' &&
              /\bSTATS\b/i.test(parameters.pipeline)
            ) {
              const key = JSON.stringify([
                read.sourceId,
                parameters.pipeline,
                'lookbackMinutes' in parameters ? parameters.lookbackMinutes : null,
                'endOffsetMinutes' in parameters ? parameters.endOffsetMinutes : 0,
              ]);
              if (
                'hasMore' in read &&
                read.hasMore &&
                'nextOffset' in read &&
                typeof read.nextOffset === 'number'
              ) {
                this.incompleteAggregates.set(key, {
                  sourceId: read.sourceId,
                  nextOffset: read.nextOffset,
                });
              } else this.incompleteAggregates.delete(key);
            }

            if (
              'rows' in read &&
              Array.isArray(read.rows) &&
              !read.rows.length &&
              'pipeline' in parameters &&
              typeof parameters.pipeline === 'string' &&
              /(?:duration|latency|elapsed|p(?:50|95|99)_?ms)/i.test(parameters.pipeline) &&
              /(?:PERCENTILE|MEDIAN|AVG|MAX|MIN)\s*\(/i.test(parameters.pipeline) &&
              'serviceNames' in parameters &&
              Array.isArray(parameters.serviceNames) &&
              'serviceNamespace' in parameters &&
              typeof parameters.serviceNamespace === 'string'
            ) {
              const kind =
                ('endOffsetMinutes' in parameters && Number(parameters.endOffsetMinutes) > 0) ||
                ('lookbackMinutes' in parameters && Number(parameters.lookbackMinutes) > 3)
                  ? 'historical'
                  : 'current';
              for (const serviceName of parameters.serviceNames.filter(
                (value): value is string => typeof value === 'string'
              )) {
                const key = JSON.stringify([
                  read.sourceId,
                  serviceName,
                  parameters.serviceNamespace,
                ]);
                if (this.latencyChecks.get(key)?.has(kind)) continue;
                const unavailable =
                  this.unavailableLatency.get(key) ?? new Set<'current' | 'historical'>();
                unavailable.add(kind);
                this.unavailableLatency.set(key, unavailable);
              }
            }

            const refs = [
              ...('rowRefs' in read && Array.isArray(read.rowRefs) ? read.rowRefs : []),
              ...('rows' in read && Array.isArray(read.rows)
                ? read.rows.flatMap((row: object | null) =>
                    row && typeof row === 'object' && 'evidenceRef' in row ? [row.evidenceRef] : []
                  )
                : []),
            ].filter((ref): ref is string => typeof ref === 'string');
            for (const ref of refs) {
              const check = this.reads.getEvidenceChecks(read.sourceId, [ref])[0];
              const identity = rowIdentity(check.row);
              const scopedNames =
                'serviceNames' in parameters && Array.isArray(parameters.serviceNames)
                  ? parameters.serviceNames.filter(
                      (value): value is string => typeof value === 'string'
                    )
                  : [];
              if (!identity.name && scopedNames.length === 1) identity.name = scopedNames[0];
              if (
                !identity.namespace &&
                'serviceNamespace' in parameters &&
                typeof parameters.serviceNamespace === 'string'
              )
                identity.namespace = parameters.serviceNamespace;
              if (!identity.name || !identity.namespace) continue;
              const key = JSON.stringify([read.sourceId, identity.name, identity.namespace]);
              const pipeline =
                'pipeline' in parameters && typeof parameters.pipeline === 'string'
                  ? parameters.pipeline
                  : '';
              const percentileColumns = [
                ...pipeline.matchAll(/([\w.]+)\s*=\s*(?:PERCENTILE|MEDIAN|AVG|MAX|MIN)\s*\(/gi),
              ].map((match) => match[1]);
              const historical =
                ('endOffsetMinutes' in parameters && Number(parameters.endOffsetMinutes) > 0) ||
                ('lookbackMinutes' in parameters && Number(parameters.lookbackMinutes) > 3);
              const sampled =
                ('sampleProbability' in parameters && Number(parameters.sampleProbability) < 1) ||
                /\bSAMPLE\s+(?:0|\.)/i.test(pipeline);
              if (
                /(?:duration|latency|elapsed|p(?:50|95|99)_?ms)/i.test(pipeline) &&
                percentileColumns.length &&
                (historical || !sampled)
              ) {
                const kind = historical ? 'historical' : 'current';
                if (
                  percentileColumns.some(
                    (column) =>
                      Boolean(check.row[column]) && Number.isFinite(Number(check.row[column]))
                  )
                ) {
                  const checked =
                    this.latencyChecks.get(key) ?? new Set<'current' | 'historical'>();
                  checked.add(kind);
                  this.latencyChecks.set(key, checked);
                  this.unavailableLatency.get(key)?.delete(kind);
                } else if (!this.latencyChecks.get(key)?.has(kind)) {
                  const unavailable =
                    this.unavailableLatency.get(key) ?? new Set<'current' | 'historical'>();
                  unavailable.add(kind);
                  this.unavailableLatency.set(key, unavailable);
                }
              }
              if (
                ['message', 'body.text', 'body', 'sample', 'sample_any', 'sample_low'].some(
                  (field) => check.row[field]
                )
              )
                this.payloadInspected.add(key);
              if (
                'lookbackMinutes' in parameters &&
                Number(parameters.lookbackMinutes) <= 3 &&
                (!('endOffsetMinutes' in parameters) || !parameters.endOffsetMinutes) &&
                !sampled
              ) {
                this.checkedWithoutRows.delete(key);
                this.observedEmitters.set(
                  JSON.stringify([read.sourceId, identity.name, identity.namespace]),
                  {
                    sourceId: read.sourceId,
                    ...identity,
                    evidenceRef: ref,
                    checkedAt: check.checkedAt,
                  }
                );
                this.pendingCurrentRefresh.delete(key);
              }
            }
          }
        }
      }
      return result;
    }

    if (name === 'finish_exploration') {
      const args = z
        .object({
          outcome: z.enum(['assessed', 'nothing_new', 'partial']),
          summary: z.string().min(1).max(2000),
          coverageComplete: z.boolean(),
          remainingGaps: z.array(z.string().min(1).max(500)).max(20),
          monitoringBlocker: z.string().min(1).max(500).optional(),
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
      if (
        this.run.learningFocus?.mode === 'initial_learning' &&
        this.observedEmitters.size &&
        !this.knowledgeWriteBlocked
      ) {
        const sourceIds = [
          ...new Set([...this.observedEmitters.values()].map((entity) => entity.sourceId)),
        ];
        try {
          const ki = await this.clients.getKnowledgeIndicatorClient();
          const known = (await ki.getFeatures(sourceIds, { limit: 10000 })).hits;
          const gaps = [...this.observedEmitters.values()].filter(
            (entity) =>
              !known.some(
                (feature) =>
                  feature.source_id === entity.sourceId &&
                  feature.type === 'entity' &&
                  feature.properties.name === entity.name &&
                  (feature.properties.service_namespace ?? feature.properties.namespace) ===
                    entity.namespace
              )
          );
          if (
            gaps.length &&
            this.continuePendingWork('source-local entity persistence', JSON.stringify(gaps))
          )
            return {
              finished: false,
              learningGaps: gaps.slice(0, 25).map((entry) => this.labelSource(entry)),
              nextAction:
                'These source-local emitters were actually observed with usable evidence but are still absent from native knowledge. Save their verified entity KIs with the supplied evidenceRefs before finishing this learning run. Do not guess language/topology or repeat the broad inventory. Then use remaining evidence to improve useful query/monitor coverage, or report its concrete data/validation blocker.',
            };
        } catch {
          this.knowledgeWriteBlocked = true;
          args.remainingGaps.push(
            'Native knowledge inventory could not be read; observed emitter persistence remains unverified.'
          );
        }
      }
      if (this.eventLearningCandidates.size && !this.knowledgeWriteBlocked) {
        const ki = await this.clients.getKnowledgeIndicatorClient();
        const learned = (
          await ki.getFeatures(
            this.sources.filter((source) => source.enabled).map((source) => source.id),
            { type: ['schema'], limit: 10000 }
          )
        ).hits;
        const missing = [...this.eventLearningCandidates.values()].filter(
          (candidate) =>
            !learned.some(
              (feature) =>
                feature.properties.kind === 'detection_learning' &&
                feature.properties.event_id === candidate.eventId &&
                candidate.sourceIds.includes(feature.source_id)
            )
        );
        if (
          missing.length &&
          this.continuePendingWork('event learning persistence', JSON.stringify(missing))
        )
          return {
            finished: false,
            eventLearningGaps: missing,
            nextAction:
              'These event transitions are persisted but their reusable detection/recovery lessons are absent from native knowledge. Save a source-local schema/custom detection_learning KI with the actual event_id and supplied evidenceRefs. Retain proven failure/recovery measurements, benign lookalikes and unknowns, plus real query/rule IDs where available. Never invent a cause. Reuse/update a stable lesson; no need to repeat unchanged known facts.',
          };
      }
      const limits = this.run.limits;
      const budgetRemaining =
        !limits ||
        ((limits.maxDurationMinutes === null ||
          Date.now() - Date.parse(this.run.startedAt) < (limits.maxDurationMinutes - 1) * 60000) &&
          (limits.maxCumulativeTokens === null ||
            this.run.tokens.total < limits.maxCumulativeTokens) &&
          (limits.maxEstimatedCostUsd === null ||
            this.run.estimatedCostUsd < limits.maxEstimatedCostUsd));
      const unreadSources = this.sources.filter(
        (source) =>
          source.enabled &&
          !this.reads.examined.has(source.id) &&
          !this.unavailableSources.has(source.id)
      );
      if (
        unreadSources.length &&
        budgetRemaining &&
        !this.reads.blocked &&
        this.continuePendingWork(
          'current source checks',
          JSON.stringify(unreadSources.map((source) => source.id))
        )
      )
        return {
          finished: false,
          unexaminedSources: unreadSources.map((source) => ({
            sourceId: source.id,
            title: source.title,
            type: source.type,
          })),
          nextAction:
            'Volume/schema probes alone are not current operation checks. Inspect a small, deliberately scoped current data read on every available source before finishing. Reuse native saved outcome queries and learned problem/recovery signatures first; return to less urgent learning afterward. Missing source coverage must not hide new problems.',
        };
      const currentKey = (entity: { sourceId: string; name: string; namespace: string }) =>
        JSON.stringify([entity.sourceId, entity.name, entity.namespace]);
      const expiredCurrent = this.reads.emittingServices.filter((entity) => {
        const observed = this.observedEmitters.get(currentKey(entity));
        return observed && Date.now() - observed.checkedAt > 3 * 60000;
      });
      if (!this.requestedCurrentRefresh && expiredCurrent.length) {
        this.requestedCurrentRefresh = true;
        for (const entity of expiredCurrent) this.pendingCurrentRefresh.add(currentKey(entity));
      }
      const unassessed = this.reads.emittingServices.filter(
        (entity) =>
          !!entity.namespace &&
          !this.unavailableSources.has(entity.sourceId) &&
          !this.checkedWithoutRows.has(
            JSON.stringify([entity.sourceId, entity.name, entity.namespace])
          ) &&
          (!this.observedEmitters.has(currentKey(entity)) ||
            this.pendingCurrentRefresh.has(currentKey(entity)))
      );
      if (
        unassessed.length &&
        budgetRemaining &&
        !this.reads.blocked &&
        this.continuePendingWork(
          'source-specific current outcome checks',
          pendingSourceSignature(unassessed)
        )
      ) {
        return {
          finished: false,
          unassessedServices: unassessed.slice(0, 25).map((entry) => this.labelSource(entry)),
          nextAction:
            'These services actually emitted in the current bounded inventory but no substantive current query/sample rows assessed them within the last three minutes. Historical comparisons, uniform probability samples and learning do not establish exact current operation coverage. A zero sampled error count can miss rare failures. Use cheap native measurements or short, scoped unsampled conditional terminal-outcome aggregates, preserving successes, failures, expected rejections and meaningful cohorts; inspect recent native rule signals. Do not respond with a broad raw-document scan. Old incident reviews do not cover new problems elsewhere. Start with unfamiliar/rare emitters: inspect scoped representative categories and outcome/progress/correctness fields, use sampling when throughput requires it, and confirm suspicious outcomes exactly. An emitter inventory is not a health check. Do not manufacture incidents or claim complete coverage. Finish partial only with the real remaining constraint after useful assessment.',
        };
      }
      if (budgetRemaining && !this.reads.blocked && this.reads.emittingServices.length) {
        const logSourceIds = this.sources
          .filter((source) => source.enabled && source.type === 'logs')
          .map((source) => source.id);
        if (logSourceIds.length) {
          const ki = await this.clients.getKnowledgeIndicatorClient();
          const known = (await ki.getFeatures(logSourceIds, { type: ['schema'], limit: 10000 }))
            .hits;
          const unparsed = this.reads.emittingServices.filter(
            (entity) =>
              logSourceIds.includes(entity.sourceId) &&
              !!entity.namespace &&
              !this.unavailableSources.has(entity.sourceId) &&
              !this.checkedWithoutRows.has(
                JSON.stringify([entity.sourceId, entity.name, entity.namespace])
              ) &&
              !this.payloadInspected.has(
                JSON.stringify([entity.sourceId, entity.name, entity.namespace])
              ) &&
              !known.some(
                (feature) =>
                  feature.type === 'schema' &&
                  feature.source_id === entity.sourceId &&
                  feature.properties.service_namespace === entity.namespace &&
                  (feature.properties.service_name === entity.name ||
                    (Array.isArray(feature.properties.services) &&
                      feature.properties.services.includes(entity.name)))
              )
          );
          if (
            unparsed.length &&
            this.continuePendingWork('unfamiliar payload checks', pendingSourceSignature(unparsed))
          ) {
            return {
              finished: false,
              unparsedLogEmitters: unparsed.slice(0, 25).map((entry) => this.labelSource(entry)),
              nextAction:
                'A broad marker aggregate or entity inventory does not explain the operation contracts of these emitting services. Inspect small representative payload/category samples for unfamiliar emitters, stratified by source AND namespace/service; use sampleProbability when throughput warrants it. Start with rare/unfamiliar emitters and inspect both normal and abnormal categories, not only an error-keyword filter. Keep service AND namespace with the samples. Then validate actual outcome/progress/correctness conditions, persist useful source-local payload KIs/measurements, and assess fresh problems. Do not infer health from zero generic markers or HTTP success alone. This is a real coverage gap, not an artifact-count target.',
            };
          }
          const latencySchemas = known.filter(
            (feature) =>
              feature.properties.kind !== 'detection_learning' &&
              /(?:duration|latency|elapsed|p(?:50|95|99)_?ms)/i.test(
                `${feature.description} ${JSON.stringify(feature.properties)}`
              )
          );
          const latencyGaps = this.reads.emittingServices.flatMap((entity) => {
            const key = JSON.stringify([entity.sourceId, entity.name, entity.namespace]);
            if (
              this.unavailableSources.has(entity.sourceId) ||
              this.checkedWithoutRows.has(key) ||
              !latencySchemas.some(
                (feature) =>
                  feature.source_id === entity.sourceId &&
                  (feature.properties.service_namespace ?? feature.properties.namespace) ===
                    entity.namespace &&
                  ((typeof feature.properties.service_name === 'string' &&
                    feature.properties.service_name
                      .split(',')
                      .map((serviceName) => serviceName.trim())
                      .includes(entity.name)) ||
                    (Array.isArray(feature.properties.services) &&
                      feature.properties.services.includes(entity.name)))
              )
            )
              return [];
            const checked = this.latencyChecks.get(key);
            const missing = (['current', 'historical'] as const).filter(
              (kind) => !checked?.has(kind) && !this.unavailableLatency.get(key)?.has(kind)
            );
            return missing.length ? [{ ...this.labelSource(entity), missing }] : [];
          });
          if (
            latencyGaps.length &&
            this.continuePendingWork('known latency contracts', pendingSourceSignature(latencyGaps))
          )
            return {
              finished: false,
              unassessedLatency: latencyGaps.slice(0, 25),
              nextAction:
                'These current log emitters have saved payload contracts exposing duration/latency, but no usable current percentile/mean and historical comparison were checked for them. Successful statuses do not assess successful-operation latency. Reuse the actual saved fields/units, inspect esql_guide topic=latency, and batch deliberately scoped per-service/operation measurements with mapped identity fields. Sample dense historical exploration, preserve rare emitters, and confirm suspicious current values exactly. When no verified baseline exists, compare a throughput-aware sampled bucketed history across the available operating range (for example an hour initially, expanding if needed), not merely another recent window. Locate step changes and confirm the earlier/current candidate populations exactly. Select historical offsets that establish baseline provenance rather than assume the preceding window was healthy. Persist reusable measurements and useful native coverage. Do not invent a threshold or manufacture an incident. If fields/history are genuinely unavailable, demonstrate the scoped data/parse gap and retain an honest partial assessment.',
            };
        }
      }
      if (
        !this.stalledWork &&
        !this.planningFeedbackSent &&
        budgetRemaining &&
        !this.reads.blocked &&
        this.run.learningFocus?.mode === 'initial_learning' &&
        (this.incompleteAggregates.size > 0 ||
          (!this.monitoringAssessed && this.reads.examined.size > 0 && !!args.monitoringBlocker))
      ) {
        this.planningFeedbackSent = true;
        return {
          finished: false,
          pendingAggregatePages: [...this.incompleteAggregates.values()].slice(0, 10),
          monitoringNotEvaluated: !this.monitoringAssessed,
          nextAction:
            'There is still usable telemetry and execution budget. Complete or narrow the pending aggregate pages; offset now pages custom queries. Reassess the observed operation contracts, not only broad HTTP/error markers. An ambiguous instrument in one service does not block useful measurements in other emitting services. Validate/persist a useful reusable measurement and evaluate justified native coverage, or establish a concrete access/data/validation blocker. Do not manufacture rules or keep scanning the same ambiguous series. Finish partial only with the actual remaining constraint and completed useful progress.',
        };
      }
      if (
        !this.stalledWork &&
        !this.monitoringAssessed &&
        !args.monitoringBlocker &&
        this.reads.examined.size > 0 &&
        this.initialActive.size === 0 &&
        !this.run.discovery?.active &&
        !this.reads.blocked &&
        budgetRemaining &&
        (this.run.evaluationMode || this.run.costEstimateComplete !== false)
      ) {
        return {
          error:
            'Current telemetry was inspected, but useful ongoing monitoring was never evaluated. Before finishing an otherwise healthy run, baseline/validate a source-local measurement or inspect existing external coverage. Save a useful reusable query and justified native rule, or report the concrete validation/data/coverage reason for leaving them unchanged. There is no rule-count target and no need to re-query silent historical namespaces.',
        };
      }
      if (this.stalledWork) {
        args.outcome = 'partial';
        args.coverageComplete = false;
        args.remainingGaps.unshift(
          `Agent made no progress on repeated feedback for ${this.stalledWork}; remaining checks are unresolved. This is not a time/cost limit or evidence of health.`
        );
      }
      const latencyDataGaps = [...this.unavailableLatency.entries()]
        .filter(([, kinds]) => kinds.size)
        .map(([key, kinds]) => `${key}: ${[...kinds].join(', ')}`);
      if (latencyDataGaps.length) {
        args.outcome = 'partial';
        args.coverageComplete = false;
        args.remainingGaps.unshift(
          `Latency aggregate reads returned no usable numeric population for ${latencyDataGaps
            .slice(0, 8)
            .join(
              '; '
            )}. This remains an unavailable population or parsing gap, not proof of health. Revisit when request telemetry or parsing improves.`
        );
      }
      if (
        this.requestedCurrentRefresh &&
        expiredCurrent.length &&
        !this.pendingCurrentRefresh.size
      ) {
        args.outcome = 'partial';
        args.coverageComplete = false;
        args.remainingGaps.unshift(
          'A bounded current-outcome refresh completed, but further learning aged some observations. Currentness is limited to their recorded collection times; a subsequent invocation must reassess newer changes. Repeating an endless sliding refresh would not establish continuous coverage.'
        );
      }
      this.run.outcome = args.outcome;
      this.run.summary = args.summary;
      this.run.coverageComplete =
        args.coverageComplete &&
        !unchecked.length &&
        this.inventoryComplete &&
        !unassessed.length &&
        !this.unavailableSources.size &&
        !unreadSources.length &&
        !this.checkedWithoutRows.size;
      this.run.remainingGaps = [
        ...args.remainingGaps,
        ...(this.checkedWithoutRows.size
          ? [
              `Scoped current reads returned no matching rows for ${
                this.checkedWithoutRows.size
              } previously observed source/service identities: ${[
                ...this.checkedWithoutRows.values(),
              ]
                .slice(0, 8)
                .map((entity) => `${entity.namespace}/${entity.name}`)
                .join(
                  ', '
                )}. This is an explicit data gap, not proof of health or telemetry absence.`,
            ]
          : []),
        ...[...this.unavailableSources.entries()].map(
          ([sourceId, error]) => `Source ${sourceId} unavailable: ${error.slice(0, 350)}`
        ),
        ...(unassessed.length
          ? [
              `Current outcomes remain unassessed for ${
                unassessed.length
              } observed source/service identities: ${unassessed
                .slice(0, 8)
                .map((entity) => `${entity.namespace}/${entity.name}`)
                .join(', ')}.`,
            ]
          : []),
        ...(args.monitoringBlocker ? [`Monitoring: ${args.monitoringBlocker}`] : []),
        ...unchecked.map((id) => `Recheck active problem ${id}`),
      ].slice(0, 20);
      this.finished = true;
      return { finished: true, ...args, uncheckedEventIds: unchecked };
    }
    if (name === 'monitoring_rules') {
      this.monitoringAssessed = true;
      return this.monitoring.execute(name, parameters);
    }
    if (name === 'monitoring_inventory') {
      const result = await this.monitoring.execute(name, parameters);
      if (
        'includeOtherRules' in parameters &&
        parameters.includeOtherRules === true &&
        Array.isArray(result.rules) &&
        result.rules.length > 0
      )
        this.monitoringAssessed = true;
      return result;
    }
    if (
      name === 'kibana_information' &&
      'action' in parameters &&
      parameters.action === 'execute'
    ) {
      const result = await this.reads.execute(name, parameters);
      if (!result.error && !result.failed) this.monitoringAssessed = true;
      return result;
    }
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
        status: args.includeInactive ? undefined : ['active', 'recovering'],
        page: Math.floor(args.offset / args.limit) + 1,
        perPage: args.limit,
      });
      for (const event of result.hits)
        if (event.event_id.startsWith(PROBLEM_EVENT_PREFIX))
          this.knownEvents.set(event.event_id, event);
      return {
        events: result.hits
          .filter((event) => event.event_id.startsWith(PROBLEM_EVENT_PREFIX))
          .map((event) => ({
            eventId: event.event_id,
            issueKey: problemIdentity(event.event_id).slice(PROBLEM_EVENT_PREFIX.length),
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
    let id = args.eventId ?? (args.issueKey ? PROBLEM_EVENT_PREFIX + args.issueKey : undefined);
    if (!id?.startsWith(PROBLEM_EVENT_PREFIX))
      throw new Error('Use an existing owned eventId or a stable issueKey.');
    let prior = await search.findLatestByEventId(id);
    if (args.eventId && !prior)
      throw new Error('eventId must identify an existing event in this space.');
    // A validated eventId is authoritative when a redundant issueKey differs.
    const identity = problemIdentity(id);
    const sourceIds = args.sourceIds.length ? args.sourceIds : prior?.source_ids ?? [];
    if (!sourceIds.length || sourceIds.some((sourceId) => !enabled.has(sourceId)))
      throw new Error('Every source must be enabled in this space.');
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
            !/`@timestamp`\s*<\s*NOW\(\)/i.test(check.query) &&
            !/\|\s*SAMPLE\s+(?:0|\.)/i.test(check.query)
        )
      ) {
        const rejected = checks
          .filter((check) => check.sourceId === sourceId)
          .slice(0, 20)
          .map((check) => ({
            ref: check.ref,
            lookbackMinutes: /NOW\(\)\s*-\s*(\d+)\s+minutes/i.exec(check.query)?.[1] ?? null,
            endOffsetMinutes: /<\s*NOW\(\)\s*-\s*(\d+)\s+minutes/i.exec(check.query)?.[1] ?? 0,
            readAgeSeconds: Math.max(0, Math.round((Date.now() - check.checkedAt) / 1000)),
            sampled: /\|\s*SAMPLE\s+(?:0|\.)/i.test(check.query),
          }));
        throw new Error(
          `Missing current outcomes for selected source ${sourceId}. Rejected references: ${JSON.stringify(
            rejected
          )}. Rerun the SAME scoped outcome query unsampled with lookbackMinutes<=3 and endOffsetMinutes=0, then cite its NEW rowRefs within three minutes of collection. A recent bucket inside a longer query is still historical evidence at this boundary. Keep older refs only as comparison context. Do not add unrelated sources to repair this error. Old errors and missing traffic do not prove current failure or recovery.`
        );
      }
    }
    const reviewing = args.action === 'review';
    if (reviewing && !prior) throw new Error('Review an existing event.');
    if (!reviewing && (!args.title || !args.summary || !args.assessmentNote || !args.status))
      throw new Error('upsert requires title, summary, assessmentNote, and status.');
    if (!prior && args.status === 'inactive')
      return { ignored: true, reason: 'Healthy or refuted candidates do not create events.' };
    const ki = await this.clients.getKnowledgeIndicatorClient();
    const known = (await ki.getFeatures(sourceIds, { limit: 10000 })).hits;
    if (!prior || prior.status === 'inactive') {
      const affectedIds = resolveEventFeatures(known, checks, args.featureIds)
        .filter((feature) => feature.type === 'entity')
        .map((feature) => feature.id);
      if (affectedIds.length) await this.loadHistoricalIdentities(sourceIds, affectedIds);
      const latest = [...this.knownEvents.values(), ...(prior ? [prior] : [])]
        .filter((event) => problemIdentity(event.event_id) === identity)
        .sort(
          (a, b) =>
            Number(b.status !== 'inactive') - Number(a.status !== 'inactive') ||
            Date.parse(b['@timestamp']) - Date.parse(a['@timestamp'])
        )[0];
      if (latest) {
        id = latest.event_id;
        prior = await search.findLatestByEventId(id);
      }
    }
    if (
      prior &&
      !expiredInactiveEvent(prior) &&
      prior.source_ids.some((sourceId) => !sourceIds.includes(sourceId))
    )
      throw new Error(
        'Recheck every source already confirming this problem; do not drop unchecked sources.'
      );
    let previousEventId: string | undefined;
    if (prior?.status === 'inactive' && (reviewing || args.status === 'inactive'))
      return { eventId: id, status: 'inactive', unchanged: true };
    if (prior && expiredInactiveEvent(prior)) {
      previousEventId = id;
      id = identity + '--' + randomUUID();
      prior = undefined;
    }
    if (prior?.status === 'inactive') {
      const deactivations = await search.findEventDeactivations(id);
      if (deactivations.some((entry) => entry.episode_id === prior.episode_id)) {
        this.reviewed.add(id);
        return { eventId: id, operatorDismissalHonored: true, status: 'inactive' };
      }
    }
    const priorEntityIds = (prior?.blast_radius ?? []).flatMap((entry) =>
      entry.type === 'entity' ? [entry.feature_id] : []
    );
    const selectedIds = args.featureIds.length ? args.featureIds : priorEntityIds;
    const features = resolveEventFeatures(known, checks, selectedIds);
    if (!selectedIds.length && features.filter((feature) => feature.type === 'entity').length > 1)
      throw new Error(
        'Cited rows include multiple entities. Pass the exact affected featureIds; broad inventory rows do not establish blast radius.'
      );
    if (args.featureIds.some((featureId) => !features.some((feature) => feature.id === featureId)))
      throw new Error('Use actual logical KI IDs in these sources.');
    if (!features.some((feature) => feature.type === 'entity'))
      throw new Error(
        'Identify at least one actually affected entity: pass its source-local featureIds, or cite rows with its service name and namespace. Save a verified entity KI first if it is not known.'
      );
    if (args.causalFeatureIds.some((featureId) => !args.featureIds.includes(featureId)))
      throw new Error('Causal feature IDs must be a subset of featureIds.');
    const references = [];
    const priorQueryIds = (prior?.signals ?? []).flatMap((signal) =>
      'query_id' in signal.metadata && signal.metadata.query_id ? [signal.metadata.query_id] : []
    );
    const priorRuleIds = (prior?.signals ?? []).flatMap((signal) =>
      signal.metadata.rule_uuid ? [signal.metadata.rule_uuid] : []
    );
    if (
      args.queryIds.length ||
      args.ruleIds.length ||
      priorQueryIds.length ||
      priorRuleIds.length
    ) {
      const links = Object.values(await ki.getSourceToQueryLinksMap(sourceIds)).flat();
      for (const queryId of args.queryIds)
        if (!links.some((link) => link.query.id === queryId))
          throw new Error(`Unknown source-local query ID: ${queryId}`);
      for (const ruleId of args.ruleIds)
        if (!links.some((link) => link.rule_backed && link.rule_id === ruleId))
          throw new Error(`Unknown source-local rule ID: ${ruleId}`);
      references.push(
        ...links
          .filter(
            (link) =>
              args.queryIds.includes(link.query.id) ||
              priorQueryIds.includes(link.query.id) ||
              (link.rule_id &&
                (args.ruleIds.includes(link.rule_id) || priorRuleIds.includes(link.rule_id)))
          )
          .map((link) => ({
            sourceId: link.source_id,
            queryId: link.query.id,
            ruleId: link.rule_backed ? link.rule_id : undefined,
          }))
      );
    }
    if (!prior) {
      await this.loadHistoricalIdentities(
        sourceIds,
        features.filter((feature) => feature.type === 'entity').map((feature) => feature.id)
      );
      const related = [...this.knownEvents.values()].filter(
        (event) =>
          !expiredInactiveEvent(event) &&
          event.source_ids.some((sourceId) => sourceIds.includes(sourceId)) &&
          event.blast_radius?.some((entity) =>
            features.some((feature) => feature.id === entity.feature_id)
          )
      );
      const unresolved = related.filter(
        (event) => !args.separateFromEventIds.includes(event.event_id)
      );
      if (unresolved.length || (related.length && !args.distinctProblemReason))
        return {
          written: false,
          requiresIdentityReview: true,
          relatedEvents: related.slice(0, 10).map((event) => ({
            eventId: event.event_id,
            status: event.status,
            title: event.title,
            summary: event.summary,
          })),
          nextAction:
            'These prior problems overlap the affected entities. Reuse the matching eventId/issueKey for continuation or recent recurrence, including when new evidence narrows the affected path or improves causal attribution. Unknown earlier cause is not a new mechanism. If this is genuinely independent, explicitly acknowledge the related IDs in separateFromEventIds and explain the distinct failure mechanism in distinctProblemReason. Do not create a duplicate merely because the title or available evidence changed.',
        };
    }
    let priorSignals = prior?.signals ?? [];
    if (prior && !priorSignals.length) {
      const previousRunId = /Evidence: Agent Explorer run ([a-zA-Z0-9-]+)/.exec(
        prior.assessment_note ?? ''
      )?.[1];
      if (previousRunId) {
        try {
          const previousRun = await this.server.problemAgent.getRun(this.request, previousRunId);
          for (const step of previousRun.steps.filter(
            (entry) => entry.kind === 'tool' && entry.name === 'events'
          )) {
            const previous = z
              .object({
                eventId: z.string(),
                status: z.enum(['active', 'inactive']),
                evidence: z
                  .array(
                    z.object({
                      sourceId: z.string(),
                      query: z.string(),
                      row: z.record(z.string(), z.string()),
                      checkedAt: z.number(),
                    })
                  )
                  .max(50),
              })
              .safeParse(JSON.parse(step.output));
            if (previous.success && previous.data.eventId === id) {
              priorSignals = buildEventQuerySignals(
                previous.data.evidence.filter((entry) => sourceIds.includes(entry.sourceId)),
                prior.assessment_note ?? '',
                previous.data.status === 'inactive'
              );
              break;
            }
          }
        } catch {
          // A cleared/truncated run cannot supply historical proof; fresh attached evidence remains available.
        }
      }
    }
    const status = reviewing ? prior?.status : args.status;
    const querySignals = buildEventQuerySignals(
      checks,
      args.assessmentNote ?? prior?.assessment_note ?? '',
      status === 'inactive',
      references,
      features
    );
    if (
      sourceIds.some(
        (sourceId) =>
          !querySignals.some(
            (signal) => signal.source_id === sourceId && signal.verdict !== 'inconclusive'
          )
      )
    )
      throw new Error(
        'Cite current outcome rows for the selected affected services in every confirming source. Rows explicitly identifying other services are context, not proof of this problem.'
      );
    const event: SignificantEvent = significantEventSchema.parse({
      ...(prior ?? {}),
      event_id: id,
      '@timestamp': new Date().toISOString(),
      source_ids: sourceIds,
      title: reviewing ? prior?.title : args.title,
      summary: reviewing ? prior?.summary : args.summary,
      status,
      severity: (reviewing || status === 'inactive') && prior ? prior.severity : args.severity,
      confidence: reviewing ? prior?.confidence : args.confidence,
      symptom_hypothesis: args.hypothesis ?? prior?.symptom_hypothesis,
      assessment_note:
        (args.assessmentNote ?? prior?.assessment_note ?? '').replace(
          /\nEvidence: Agent Explorer run[^\n]*/g,
          ''
        ) +
        '\nEvidence: Agent Explorer run ' +
        this.run.id,
      signals: [
        ...priorSignals
          .filter((signal) => signal.type !== 'query' || signal.verdict === 'confirms')
          .slice(0, 6),
        ...querySignals,
      ],
      blast_radius: features
        .filter((feature) => feature.type === 'entity')
        .map((feature) => ({
          type: 'entity',
          feature_id: feature.id,
          subtype: feature.subtype,
          name: feature.title || feature.id,
          source_id: feature.source_id,
        })),
      causal_features:
        reviewing && !args.causalFeatureIds.length
          ? prior?.causal_features
          : features
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
    this.knownEvents.set(id, event);
    if (!prior || prior.status !== status)
      this.eventLearningCandidates.set(id, {
        eventId: id,
        sourceIds,
        evidenceRefs: args.evidenceRefs,
      });
    this.run.written++;
    this.run.discovery ??= { signalCount: 0, active: 0, inactive: 0, excludedUnattributed: 0 };
    if (status === 'active' || status === 'inactive') this.run.discovery[status]++;
    return {
      eventId: id,
      issueKey: identity.slice(PROBLEM_EVENT_PREFIX.length),
      ...(previousEventId ? { previousEventId, createdNewOccurrence: true } : {}),
      status,
      ...(reviewing ? { reviewed: true } : {}),
      storedAs: 'native_alert',
      attachedSignals: querySignals.length,
      signalReferences: querySignals.map((signal) => signal.metadata),
      affectedEntities: features
        .filter((feature) => feature.type === 'entity')
        .map((feature) => feature.id),
      monitoringNextAction:
        status === 'active' && !references.some((reference) => reference.ruleId)
          ? 'Create or validate a reusable native rule for this confirmed problem using its measured failure condition. Update this event with actual ruleIds/queryIds. If coverage is blocked, give the concrete monitoringBlocker at finish; the current query signals remain inspectable.'
          : undefined,
      evidence: checks,
    };
  }
}
