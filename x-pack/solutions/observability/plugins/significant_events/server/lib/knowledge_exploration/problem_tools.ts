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
import type { Feature, SignificantEvent } from '@kbn/significant-events-schema';
import { significantEventSchema } from '@kbn/significant-events-schema';
import { lazySchema, z } from '@kbn/zod/v4';
import type { ExplorationCheckpoint, ExplorationRun } from '../../../common/knowledge_exploration';
import type { RouteHandlerScopedClients } from '../../routes/types';
import type { SignificantEventsServer } from '../../types';
import { discoveryTools, EventDiscoveryToolSession } from '../event_discovery/tools';
import { monitoringTools, MonitoringToolSession } from '../monitoring_setup/tools';
import { explorationTools, ExplorationToolSession } from './tools';
import {
  collectEventOutcomes,
  eventRowScope,
  buildEventQuerySignals,
  resolveEventFeatures,
  type EventEvidenceCheck,
} from './event_evidence';
import { entityName } from './source_scope';
import { detectionSkills } from './detection_skills';
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
const outcomeInput = lazySchema(() =>
  z.object({ condition: text, failedField: text, healthyField: text })
);
const eventInput = lazySchema(() =>
  z.object({
    action: z.enum(['index', 'read', 'upsert', 'review']),
    includeInactive: z.boolean().default(false),
    eventId: text.optional(),
    eventIds: z.array(text).max(25).default([]),
    issueKey: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .max(180)
      .optional(),
    sourceIds: z.array(text).max(50).default([]),
    signalRefs: z.array(text).max(25).default([]),
    outcome: outcomeInput.optional(),
    outcomes: z
      .array(outcomeInput.extend({ evidenceRef: text }))
      .max(50)
      .optional(),
    evidenceRefs: z.array(text).max(50).default([]),
    featureIds: z.array(text).max(50).default([]),
    queryIds: z.array(text).max(25).default([]),
    ruleIds: z.array(text).max(10).default([]),
    causalFeatureIds: z.array(text).max(50).default([]),
    title: z.string().min(1).max(255).optional(),
    summary: z.string().min(1).max(4000).optional(),
    assessmentNote: z.string().min(1).max(900).optional(),
    hypothesis: z.string().max(2000).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    confidence: z.number().min(0).max(1).optional(),
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
  esql_guide: {
    ...explorationTools.esql_guide,
    description:
      'Read syntax and worked examples for an ES|QL topic, including sampling, CATEGORIZE, change points, latency and counting.',
  },
  detection_sources: {
    ...explorationTools.detection_sources,
    description:
      'List configured sources in this space with IDs, enabled state and view metadata. Page with offset/limit. Use source_esql volume for current throughput.',
  },
  source_esql: {
    ...explorationTools.source_esql,
    description:
      'Query enabled views by exact source ID or catalog slug in sourceIds. Prefer short slugs for reads. Start with volume and scoped inventory/schema. Use samples with sampleKind=outcomes to inspect operation labels. Use profile with fieldSearch to find populated mapped fields. Use custom after FROM with observed names and first_seen/last_seen aliases. Scope by serviceNames and serviceNamespace. compareEndOffsetMinutes adds a matched earlier window. Inspect sampling, truncation, status and row refs. Use esql_guide for syntax.',
  },
  kibana_information: {
    ...explorationTools.kibana_information,
    description:
      'Find read-only Kibana capabilities for additional context. Catalog, describe the selected tool, then execute with its documented parameters. Scope results to this space and selected sources.',
  },
  knowledge_indicators: {
    ...explorationTools.knowledge_indicators,
    description:
      'Index, read and upsert source-local knowledge indicators and reusable queries. countOnly gives totals; use kind, sourceId, query and cursor to narrow indexes, and ids for details. Send one upsert per source with its exact top-level sourceId. Ground features in its evidence_refs. KI confidence uses 0–100. For event-linked lessons use maintain-coverage.',
  },
  rule_change_points: {
    ...discoveryTools.rule_change_points,
    description:
      'Analyze a native rule series for statistically unusual changes. Use signalRef or ruleId and sourceId; request the series only when needed. Compare the underlying operation before assigning impact.',
  },
  monitoring_inventory: {
    ...monitoringTools.monitoring_inventory,
    description:
      'List native managed rules, linked source queries, parameters and service capacity. Use ruleIds for exact definitions and includeOtherRules to inspect existing external coverage.',
  },
  monitoring_rules: {
    ...monitoringTools.monitoring_rules,
    description:
      'Baseline, validate or maintain a native owned rule on one source. Baseline takes a pipeline. Installed count predicates use only WHERE; inline JSON_EXTRACT in WHERE or use metric mode for derived fields. Candidate validate needs both pipeline and source-local featureIds. Validate an installed rule by ruleId. For a validated new candidate, upsert with its validationRef, sourceId, slug, title, description and reason. Otherwise supply the pipeline and source-local featureIds. Inspect returned values and rule ID. Use maintain-coverage for predicate construction, positive examples and rule linking.',
  },
  fired_rules: {
    ...discoveryTools.fired_rules,
    description:
      'Index recent source-attributed rule evidence, then read by signalRefs. Follow nextOffset with the same references. Metric series describe observations; a native firing has its own reference. Confirm current impact in the source.',
  },
  load_skill: {
    description:
      'Load a read-only procedure once per run, alongside discovery or evidence queries. Its instructions remain in this run’s conversation.',
    schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: detectionSkills.map((skill) => skill.name),
          description: detectionSkills
            .map((skill) => `${skill.name}: ${skill.description}`)
            .join(' '),
        },
      },
      required: ['name'],
    },
  },
  events: {
    ...discoveryTools.events,
    description:
      'Index active/recovering events or use includeInactive with sourceIds and affected featureIds for recurrence lookup. Read by eventIds. Upsert with current evidenceRefs, affected featureIds, status and assessmentNote; new incidents also need issueKey, title, summary, severity and confidence. Reuse a matching eventId. Attach real ruleIds or signalRefs. Load manage-events for rating and recovery.',
    schema: {
      type: 'object',
      required: ['action'],
      properties: {
        ...discoveryTools.events.schema?.properties,
        action: { type: 'string', enum: ['index', 'read', 'upsert', 'review'] },
        outcomes: {
          type: 'array',
          description: 'Per-row outcome overrides for events with several conditions.',
          items: {
            type: 'object',
            required: ['evidenceRef', 'condition', 'failedField', 'healthyField'],
            properties: {
              evidenceRef: boundedText(255),
              condition: boundedText(255),
              failedField: boundedText(255),
              healthyField: boundedText(255),
            },
          },
        },
        outcome: {
          type: 'object',
          required: ['condition', 'failedField', 'healthyField'],
          properties: {
            condition: boundedText(255),
            failedField: boundedText(255),
            healthyField: boundedText(255),
          },
        },
        includeInactive: {
          type: 'boolean',
          description:
            'Index only: defaults to false. Include closed history only for a fresh candidate’s recurrence/identity check, not routine reinspection.',
        },
        issueKey: {
          ...boundedText(180),
          description:
            'Stable operation and symptom slug, e.g. checkout-payment-timeout. Omit dates and run IDs. Letters are normalized to lowercase.',
        },
        assessmentNote: boundedText(900),
        summary: boundedText(4000),
        confidence: eventConfidence,
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description:
            'Rate verified operational impact. Use the severity contract in manage-events; recovery retains episode severity.',
        },
        queryIds: { type: 'array', items: boundedText(255) },
        ruleIds: { type: 'array', items: boundedText(255) },
      },
    },
  },
  finish_exploration: {
    ...discoveryTools.finish_exploration,
    description:
      'Finish with a current summary, outcome, coverageComplete and remainingGaps. Report general data gaps separately from eventMonitoringBlockers, which identify the specific event and its monitoring obstacle. If finished is false, act on the returned nextAction.',
    schema: {
      ...discoveryTools.finish_exploration.schema,
      required: [...(discoveryTools.finish_exploration.schema?.required ?? []), 'candidateStatus'],
      type: 'object',
      properties: {
        ...discoveryTools.finish_exploration.schema?.properties,
        candidateStatus: {
          type: 'string',
          enum: ['assessed', 'needs_check', 'blocked'],
          description:
            'Status of current incident candidates. assessed = no credible unresolved candidate remains. needs_check = current evidence suggests harm and a feasible source query could decide. blocked = an actual access, telemetry or execution limitation prevents that check.',
        },
        candidateNote: boundedText(500),
        summary: boundedText(2000),
        remainingGaps: boundedTexts(20, 500),
        monitoringBlocker: boundedText(500),
        eventMonitoringBlockers: {
          type: 'array',
          description:
            'Up to 25 events. Give the concrete reason a native rule for each event cannot be established, based on its own evidence source and symptom.',
          items: {
            type: 'object',
            required: ['eventId', 'reason'],
            properties: { eventId: boundedText(255), reason: boundedText(500) },
          },
        },
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
  private monitoredFeatures = new Set<string>();
  private attemptedRuleSources = new Set<string>();
  private promptedRuleAttempts = new Set<string>();
  private observedEmitters = new Map<
    string,
    { sourceId: string; name: string; namespace: string; evidenceRef: string; checkedAt: number }
  >();
  private knowledgeWriteBlocked = false;
  private offeredPeerReview = false;
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
  private incompleteAggregates = new Map<string, { sourceId: string; nextOffset: number | null }>();
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
      if (!this.sources.some((source) => source.enabled)) return;
      const search = await this.clients.getEventSearchClient();
      for (let page = 1; page <= 10; page++) {
        const result = await search.findLatestByCurrentStatePaginated({
          eventIdPrefix: PROBLEM_EVENT_PREFIX,
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
        eventIdPrefix: PROBLEM_EVENT_PREFIX,
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
    if (name === 'load_skill') {
      const skill = detectionSkills.find(
        (entry) => 'name' in parameters && entry.name === parameters.name
      );
      if (!skill)
        return {
          error: 'Unknown Detection Agent skill',
          available: detectionSkills.map((entry) => entry.name),
        };
      return { name: skill.name, content: skill.content };
    }
    if (name === 'detection_sources') return this.reads.execute(name, parameters);
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
          if (read && typeof read === 'object' && typeof read.sourceId === 'string') {
            if (read.status === 'unavailable') {
              this.unavailableSources.set(
                read.sourceId,
                typeof read.nextAction === 'string'
                  ? read.nextAction.slice(0, 500)
                  : 'Source probe reported unavailable coverage.'
              );
            } else if (
              typeof read.error === 'string' &&
              /forbidden|unauthorized|not authorized|unavailable|timed out|timeout|Unknown index/i.test(
                read.error
              )
            ) {
              this.unavailableSources.set(read.sourceId, read.error.slice(0, 500));
            }
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
              if (('truncated' in read && read.truncated) || ('hasMore' in read && read.hasMore)) {
                this.incompleteAggregates.set(key, {
                  sourceId: read.sourceId,
                  nextOffset:
                    'nextOffset' in read && typeof read.nextOffset === 'number'
                      ? read.nextOffset
                      : null,
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
          candidateStatus: z.enum(['assessed', 'needs_check', 'blocked']).optional(),
          candidateNote: z.string().trim().min(1).max(500).optional(),
          summary: z.string().min(1).max(2000),
          coverageComplete: z.boolean(),
          remainingGaps: z.array(z.string().min(1).max(500)).max(20),
          monitoringBlocker: z.string().min(1).max(500).optional(),
          eventMonitoringBlockers: z
            .array(z.object({ eventId: text, reason: z.string().trim().min(1).max(500) }))
            .max(25)
            .default([]),
        })
        .parse(parameters);
      if (args.candidateStatus === 'needs_check') {
        if (this.continuePendingWork('current incident confirmation', 'pending'))
          return {
            finished: false,
            status: 'continue',
            nextAction:
              'Investigate the strongest current candidate now. Run a short exact source_esql query that counts terminal outcomes and groups by minute, affected operation and reason, then check a comparable healthy window. If repeated independently corroborated terminal failures already show a blocked path, write the scoped event promptly and state the unknown reach. Lack of a denominator you can still query is unfinished work.',
          };
        args.coverageComplete = false;
      }
      if (args.candidateStatus === 'blocked') {
        if (
          !args.candidateNote &&
          this.continuePendingWork('unverified candidate blocker', 'missing note')
        )
          return {
            finished: false,
            status: 'continue',
            nextAction:
              'Use candidateNote to identify the current candidate, the attempted check and the actual data, access or execution obstacle.',
          };
        args.coverageComplete = false;
        args.remainingGaps.unshift(
          args.candidateNote ??
            'The current candidate could not be verified and the blocker was not specified.'
        );
      }
      const unchecked = [...this.initialActive].filter((id) => !this.reviewed.has(id));
      if ((unchecked.length || !this.inventoryComplete) && args.outcome !== 'partial') {
        return {
          status: 'continue',
          finished: false,
          nextAction:
            'Recheck all existing active problems before completing, or finish partial with the unresolved work.',
          uncheckedEventIds: unchecked,
          inventoryComplete: this.inventoryComplete,
        };
      }
      if (
        this.run.learningFocus?.mode === 'initial_learning' &&
        (this.reads.emittingServices.length || this.observedEmitters.size) &&
        !this.knowledgeWriteBlocked
      ) {
        const emitters = [...this.reads.emittingServices, ...this.observedEmitters.values()];
        const sourceIds = [...new Set(emitters.map((entity) => entity.sourceId))];
        try {
          const pending = new Map(
            emitters.map(
              (entity) =>
                [JSON.stringify([entity.sourceId, entity.name, entity.namespace]), entity] as const
            )
          );
          for await (const feature of this.currentFeatures(sourceIds, 'entity')) {
            pending.delete(
              JSON.stringify([
                feature.source_id,
                entityName(feature),
                feature.properties.service_namespace ?? feature.properties.namespace ?? '',
              ])
            );
            if (!pending.size) break;
          }
          const gaps = [...pending.values()];
          if (
            gaps.length &&
            this.continuePendingWork('source-local entity persistence', JSON.stringify(gaps))
          )
            return {
              status: 'continue',
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
      const monitoredLessons = new Set<string>();
      if (
        this.run.learningFocus?.mode === 'initial_learning' &&
        !this.knowledgeWriteBlocked &&
        !this.offeredPeerReview &&
        this.reads.observedPeerLinks.size
      ) {
        this.offeredPeerReview = true;
        const pending = new Map(this.reads.observedPeerLinks);
        const sources = [...new Set([...pending.values()].map((peer) => peer.sourceId))];
        try {
          for await (const feature of this.currentFeatures(sources, 'dependency')) {
            const p = feature.properties;
            pending.delete(
              JSON.stringify([
                feature.source_id,
                p.source,
                p.source_namespace ?? '',
                p.target,
                p.target_namespace ?? '',
              ])
            );
          }
        } catch {
          pending.clear();
          args.remainingGaps.push(
            'Existing directed knowledge could not be checked against the observed outgoing peers.'
          );
        }
        if (pending.size)
          return {
            status: 'continue',
            finished: false,
            observedPeers: [...pending.values()].slice(0, 20),
            nextAction:
              'Review these observed outbound links. Each contains a source-local evidenceRef, an explicitly named target and an independently observed emitter. Save verified caller-to-target dependency KIs in a batch per source, with properties.source, target and their observed namespaces. Omit an ambiguous alias or a configuration-only address without evidence of use; explain its uncertainty. These links do not prove a cause of an incident.',
          };
      }
      if (this.eventLearningCandidates.size && !this.knowledgeWriteBlocked) {
        const pending = new Map(this.eventLearningCandidates);
        const sources = [
          ...new Set([...pending.values()].flatMap((candidate) => candidate.sourceIds)),
        ];
        for await (const feature of this.currentFeatures(sources, 'schema')) {
          const eventId = feature.properties.event_id;
          if (
            feature.properties.kind === 'detection_learning' &&
            typeof eventId === 'string' &&
            pending.get(eventId)?.sourceIds.includes(feature.source_id)
          ) {
            if (this.monitoredFeatures.has(JSON.stringify([feature.source_id, feature.id])))
              monitoredLessons.add(eventId);
            pending.delete(eventId);
          }
          if (!pending.size) break;
        }
        const missing = [...pending.values()];
        if (
          missing.length &&
          this.continuePendingWork('event learning persistence', JSON.stringify(missing))
        )
          return {
            status: 'continue',
            finished: false,
            eventLearningGaps: missing,
            nextAction:
              'These event transitions are persisted but their reusable detection/recovery lessons are absent from native knowledge. Save a source-local KI with type="schema", subtype="custom", properties.kind="detection_learning" and properties.event_id set to the exact event ID above. Put the supplied refs in evidence_refs. Retain proven failure/recovery measurements, benign lookalikes and unknowns, plus real query/rule IDs where available. Never invent a cause. Reuse/update a stable lesson; no need to repeat unchanged known facts.',
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
      const uncoveredEventIds = [...this.eventLearningCandidates.keys()].filter((id) => {
        const event = this.knownEvents.get(id);
        return (
          !event?.monitoring_references?.some((ref) => ref.ruleId) &&
          !(event?.status === 'inactive' && monitoredLessons.has(id))
        );
      });
      if (uncoveredEventIds.length) args.coverageComplete = false;
      const unresolvedEventIds = uncoveredEventIds.filter(
        (id) => !args.eventMonitoringBlockers.some((blocker) => blocker.eventId === id)
      );
      const untried = uncoveredEventIds.flatMap((id) => {
        const event = this.eventLearningCandidates.get(id);
        return event &&
          !unresolvedEventIds.includes(id) &&
          !this.promptedRuleAttempts.has(id) &&
          !event.sourceIds.some((source) => this.attemptedRuleSources.has(source))
          ? [event]
          : [];
      });
      if (budgetRemaining && untried.length && !this.reads.blocked) {
        for (const event of untried) this.promptedRuleAttempts.add(event.eventId);
        return {
          status: 'continue',
          finished: false,
          untriedEventMonitors: untried,
          nextAction:
            'No candidate rule has been tested on the source for these events. Use the executed query behind the supplied evidenceRefs to build a source-scoped pipeline. Reuse the exact operation, outcome and cohort, drop the source and time predicates, and compare ordinary and affected buckets. Call monitoring_rules baseline or validate with that pipeline, then upsert useful coverage. A missing pipeline, an unattempted validation or an unrelated silent source is not a data blocker. If the event was a false positive or the evidence genuinely cannot support a meaningful rule, explain why in eventMonitoringBlockers and finish.',
        };
      }
      if (unresolvedEventIds.length) {
        if (
          budgetRemaining &&
          this.continuePendingWork('event monitoring coverage', JSON.stringify(unresolvedEventIds))
        ) {
          return {
            status: 'continue',
            finished: false,
            uncoveredEventIds: unresolvedEventIds,
            nextAction:
              'Check coverage for the specific symptom of each event listed here, including an incident that just recovered. Compare the candidate rule with onset and ordinary traffic. For an active event, link a matching native rule to the event. After recovery, upsert a justified native rule with the event’s detection_learning KI among its featureIds, so the saved rule points to the lesson without rewriting the closure. A rule for a different outcome on the same service does not cover it. For a corrected false positive or a genuine obstacle, supply eventMonitoringBlockers with the eventId and a specific reason. Evaluate coverage on the actual evidence source even when other sources are unavailable. The event transition is already saved.',
          };
        }
        args.remainingGaps.push(
          `Native monitoring coverage remains unverified for ${unresolvedEventIds.join(', ')}`
        );
      }
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
          status: 'continue',
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
          status: 'continue',
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
          const payloads = new Set<string>();
          const latencyContracts = new Set<string>();
          for await (const feature of this.currentFeatures(logSourceIds, 'schema')) {
            const props = feature.properties;
            const services = Array.isArray(props.services) ? props.services : [];
            const serviceNames =
              typeof props.service_name === 'string'
                ? props.service_name.split(',').map((name) => name.trim())
                : [];
            for (const name of [...services, props.service_name]) {
              payloads.add(JSON.stringify([feature.source_id, name, props.service_namespace]));
            }
            if (
              props.kind !== 'detection_learning' &&
              /(?:duration|latency|elapsed|p(?:50|95|99)_?ms)/i.test(
                `${feature.description} ${JSON.stringify(props)}`
              )
            ) {
              for (const name of [...services, ...serviceNames]) {
                latencyContracts.add(
                  JSON.stringify([
                    feature.source_id,
                    name,
                    props.service_namespace ?? props.namespace,
                  ])
                );
              }
            }
          }
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
              !payloads.has(currentKey(entity))
          );
          if (
            unparsed.length &&
            this.continuePendingWork('unfamiliar payload checks', pendingSourceSignature(unparsed))
          ) {
            return {
              status: 'continue',
              finished: false,
              unparsedLogEmitters: unparsed.slice(0, 25).map((entry) => this.labelSource(entry)),
              nextAction:
                'A broad marker aggregate or entity inventory does not explain the operation contracts of these emitting services. Inspect small representative payload/category samples for unfamiliar emitters, stratified by source AND namespace/service; use sampleProbability when throughput warrants it. Start with rare/unfamiliar emitters and inspect both normal and abnormal categories, not only an error-keyword filter. Keep service AND namespace with the samples. Then validate actual outcome/progress/correctness conditions, persist useful source-local payload KIs/measurements, and assess fresh problems. Do not infer health from zero generic markers or HTTP success alone. This is a real coverage gap, not an artifact-count target.',
            };
          }
          const latencyGaps = this.reads.emittingServices.flatMap((entity) => {
            const key = JSON.stringify([entity.sourceId, entity.name, entity.namespace]);
            if (
              this.unavailableSources.has(entity.sourceId) ||
              this.checkedWithoutRows.has(key) ||
              !latencyContracts.has(key)
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
              status: 'continue',
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
          status: 'continue',
          finished: false,
          pendingAggregatePages: [...this.incompleteAggregates.values()].slice(0, 10),
          monitoringNotEvaluated: !this.monitoringAssessed,
          nextAction:
            'There is still usable telemetry and execution budget. Narrow truncated aggregates by service, operation or time and inspect omitted cohorts. Reassess the observed operation contracts, not only broad HTTP/error markers. An ambiguous instrument in one service does not block useful measurements in other emitting services. Validate/persist a useful reusable measurement and evaluate justified native coverage, or establish a concrete access/data/validation blocker. Do not manufacture rules or keep scanning the same ambiguous series. Finish partial only with the actual remaining constraint and completed useful progress.',
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
          status: 'continue',
          finished: false,
          nextAction:
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
      this.run.summary = args.summary;
      this.run.coverageComplete =
        args.coverageComplete &&
        !unchecked.length &&
        this.inventoryComplete &&
        !unassessed.length &&
        !this.unavailableSources.size &&
        !unreadSources.length &&
        !this.checkedWithoutRows.size;
      this.run.outcome = this.run.coverageComplete ? args.outcome : 'partial';
      this.run.remainingGaps = [
        ...unchecked.map((id) => `Recheck active problem ${id}`),
        ...(!this.inventoryComplete ? ['Active problem inventory is incomplete.'] : []),
        ...unreadSources.map((source) => `Source ${source.id} has no current operation check.`),
        ...[...this.unavailableSources.entries()].map(
          ([sourceId, error]) => `Source ${sourceId} unavailable: ${error.slice(0, 350)}`
        ),
        ...(this.checkedWithoutRows.size
          ? [
              `Scoped current reads returned no matching rows for ${
                this.checkedWithoutRows.size
              } previously observed source/service identities: ${[
                ...this.checkedWithoutRows.values(),
              ]
                .slice(0, 8)
                .map((entity) => `${entity.sourceId}/${entity.namespace}/${entity.name}`)
                .join(
                  ', '
                )}. This is an explicit data gap, not proof of health or telemetry absence.`,
            ]
          : []),
        ...(unassessed.length
          ? [
              `Current outcomes remain unassessed for ${
                unassessed.length
              } observed source/service identities: ${unassessed
                .slice(0, 8)
                .map((entity) => `${entity.sourceId}/${entity.namespace}/${entity.name}`)
                .join(', ')}.`,
            ]
          : []),
        ...args.eventMonitoringBlockers
          .filter((b) => uncoveredEventIds.includes(b.eventId))
          .map((b) => `Monitoring for ${b.eventId}: ${b.reason}`),
        ...(args.monitoringBlocker ? [`Monitoring: ${args.monitoringBlocker}`] : []),
        ...args.remainingGaps,
      ].slice(0, 20);
      this.finished = true;
      return {
        ...args,
        status: 'finished',
        finished: true,
        outcome: this.run.outcome,
        coverageComplete: this.run.coverageComplete,
        remainingGaps: this.run.remainingGaps,
        uncheckedEventIds: unchecked,
      };
    }
    if (name === 'monitoring_rules') {
      if (
        'action' in parameters &&
        ['baseline', 'validate', 'upsert'].includes(String(parameters.action)) &&
        'sourceId' in parameters &&
        typeof parameters.sourceId === 'string' &&
        (('pipeline' in parameters &&
          typeof parameters.pipeline === 'string' &&
          parameters.pipeline.trim()) ||
          (parameters.action === 'validate' && 'ruleId' in parameters && parameters.ruleId))
      ) {
        this.attemptedRuleSources.add(parameters.sourceId);
      }
      const result = await this.monitoring.execute(name, parameters);
      if (
        (result.native === true || result.unchanged === true) &&
        'featureIds' in parameters &&
        Array.isArray(parameters.featureIds) &&
        'sourceId' in parameters
      ) {
        for (const id of parameters.featureIds) {
          this.monitoredFeatures.add(JSON.stringify([parameters.sourceId, id]));
        }
      }
      if (
        !result.error &&
        (result.evidenceValidated === true ||
          (typeof result.totalGroups === 'number' && result.totalGroups > 0) ||
          (Array.isArray(result.saved) && result.saved.length > 0) ||
          (result.unchanged === true && typeof result.ruleId === 'string'))
      )
        this.monitoringAssessed = true;
      return result;
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
      if (result.monitoringAssessed === true) this.monitoringAssessed = true;
      return result;
    }
    if (name === 'fired_rules' || name === 'rule_change_points')
      return this.discovery.execute(name, parameters);
    return this.reads.execute(name, parameters);
  }

  private async *currentFeatures(sourceIds: string[], type: string): AsyncGenerator<Feature> {
    const ki = await this.clients.getKnowledgeIndicatorClient();
    const asOf = new Date().toISOString();
    let after: Parameters<typeof ki.getTopologyFeaturesPage>[0]['after'];
    do {
      const page = await ki.getTopologyFeaturesPage({
        sourceIds,
        featureTypes: [type],
        asOf,
        after,
        size: 500,
      });
      yield* page.hits;
      after = page.nextCursor;
    } while (after);
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
      const indexSources = args.sourceIds.length
        ? args.sourceIds.filter((id) => enabled.has(id))
        : [...enabled];
      if (!indexSources.length)
        return {
          events: [],
          total: 0,
          hasMore: false,
          nextOffset: null,
          activeProblemsToReview: [],
        };
      const result = await search.findLatestByCurrentStatePaginated({
        eventIdPrefix: PROBLEM_EVENT_PREFIX,
        sourceIds: indexSources,
        ...(args.featureIds.length ? { topologyFeatureIds: args.featureIds } : {}),
        status: args.includeInactive ? undefined : ['active', 'recovering'],
        offset: args.offset,
        perPage: args.limit,
      });
      const episodeIds = result.hits.flatMap((event) =>
        event.episode_id && event.status !== 'inactive' ? [event.episode_id] : []
      );
      const openings = episodeIds.length ? await search.findEpisodeOpenings(episodeIds) : undefined;
      for (const event of result.hits)
        if (event.event_id.startsWith(PROBLEM_EVENT_PREFIX))
          this.knownEvents.set(event.event_id, event);
      return {
        events: result.hits
          .filter((event) => event.event_id.startsWith(PROBLEM_EVENT_PREFIX))
          .map((event) => {
            const opening = event.episode_id ? openings?.get(event.episode_id) : undefined;
            return {
              eventId: event.event_id,
              issueKey: problemIdentity(event.event_id).slice(PROBLEM_EVENT_PREFIX.length),
              status: event.status,
              severity: event.severity,
              confidence: event.confidence,
              lastAssessedAt: event['@timestamp'],
              openingCondition: opening?.summary,
              openedAt: opening?.['@timestamp'] ?? event.created_at,
              preOpeningEndOffsetMinutes: opening
                ? Math.max(1, Math.ceil((Date.now() - Date.parse(opening['@timestamp'])) / 60000))
                : undefined,
              outcomeChecks: event.outcome_checks,
              title: event.title,
              summary: event.summary?.slice(0, 320),
              sourceIds: event.source_ids,
              affectedEntities: event.blast_radius ?? [],
              causalFeatures: event.causal_features ?? [],
            };
          }),
        total: result.total,
        hasMore: args.offset + args.limit < result.total,
        nextOffset: args.offset + args.limit,
        assessmentGuidance: result.hits.some((event) => event.status !== 'inactive')
          ? 'For each active event, measure the exact operation and failure mechanism in openingCondition. If the opening excess cleared and new attempts succeed, mark that event inactive. When residual downstream failures have long durations, use source_esql to measure their start times and newer successful starts before attributing ongoing impact. Do not broaden the event to another operation. See manage-events.'
          : 'No active episode needs a recovery write. When fresh measurements establish a candidate, use includeInactive with its sourceIds and affected featureIds to compare recent occurrences.',
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
    const key = args.issueKey;
    let id =
      args.eventId ??
      (key && (key.startsWith(PROBLEM_EVENT_PREFIX) ? key : PROBLEM_EVENT_PREFIX + key));
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
    const checks: EventEvidenceCheck[] = sourceIds.flatMap((sourceId) =>
      args.evidenceRefs.flatMap((ref) => {
        try {
          return this.reads
            .getEvidenceChecks(sourceId, [ref])
            .map((entry) => ({ ...entry, sourceId, ref, scope: eventRowScope(entry) }));
        } catch {
          return [];
        }
      })
    );
    if (args.evidenceRefs.some((ref) => !checks.some((check) => check.ref === ref)))
      throw new Error('Evidence refs must be actual rows from this run and selected sources.');
    if (sourceIds.some((sourceId) => !checks.some((check) => check.sourceId === sourceId)))
      throw new Error('Cite an executed evidence row for each selected source.');
    const reviewing = args.action === 'review';
    if (reviewing && !prior) throw new Error('Review an existing event.');
    if (
      !reviewing &&
      (!args.assessmentNote || !args.status || (!prior && (!args.title || !args.summary)))
    )
      throw new Error(
        'Upsert requires status and assessmentNote. New events also require title and summary.'
      );
    if (!prior && args.status === 'inactive')
      return { ignored: true, reason: 'Healthy or refuted candidates do not create events.' };
    const ki = await this.clients.getKnowledgeIndicatorClient();
    const known: Feature[] = [];
    const ids = args.featureIds.length
      ? args.featureIds
      : (prior?.blast_radius ?? []).flatMap((entry) =>
          entry.type === 'entity' ? [entry.feature_id] : []
        );
    if (ids.length) {
      const matches = await ki.getFeatures(sourceIds, {
        featureIds: ids,
        limit: ids.length * sourceIds.length,
      });
      known.push(...matches.hits);
    }
    if (!ids.length || (prior?.status === 'inactive' && !args.featureIds.length)) {
      const observedNames = new Set(checks.map((check) => check.scope?.name));
      for await (const feature of this.currentFeatures(sourceIds, 'entity')) {
        const name = entityName(feature);
        if (
          name &&
          observedNames.has(name) &&
          !known.some((f) => f.source_id === feature.source_id && f.id === feature.id)
        )
          known.push(feature);
      }
    }
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
    const entityIds = features
      .filter((feature) => feature.type === 'entity')
      .map((feature) => feature.id);
    if (!selectedIds.length && entityIds.length > 1)
      throw new Error(
        `Cited rows include multiple entities. Select the affected featureIds from ${JSON.stringify(
          entityIds
        )}. Before choosing a new issueKey, use events action=index with includeInactive=true, these sourceIds and the affected featureIds. If the same operation and failure mechanism recurred, pass the returned eventId. Broad inventory rows alone do not establish blast radius.`
      );
    if (args.featureIds.some((featureId) => !features.some((feature) => feature.id === featureId)))
      throw new Error('Use actual logical KI IDs in these sources.');
    if (!features.some((feature) => feature.type === 'entity'))
      throw new Error(
        'Identify at least one actually affected entity: pass its source-local featureIds, or cite rows with its service name and namespace. Save a verified entity KI first if it is not known.'
      );
    const extraCausalIds = args.causalFeatureIds.filter(
      (featureId) => !features.some((feature) => feature.id === featureId)
    );
    const causalCandidates = extraCausalIds.length
      ? [
          ...features,
          ...(
            await ki.getFeatures(sourceIds, {
              featureIds: extraCausalIds,
              limit: extraCausalIds.length * sourceIds.length,
            })
          ).hits,
        ]
      : features;
    const causalFeatures = causalCandidates.filter((feature) =>
      args.causalFeatureIds.includes(feature.id)
    );
    const status = reviewing ? prior?.status : args.status;
    if (!prior && (args.severity === undefined || args.confidence === undefined))
      throw new Error(
        'Set severity and confidence explicitly for a new occurrence and explain both in assessmentNote.'
      );
    const measurements = collectEventOutcomes({
      checks,
      features,
      prior,
      outcome: args.outcome,
      outcomes: args.outcomes,
    });
    const affected = features.filter((feature) => feature.type === 'entity');
    const references: NonNullable<SignificantEvent['monitoring_references']> = [];
    const priorQueryIds = (prior?.signals ?? []).flatMap((signal) =>
      'query_id' in signal.metadata && signal.metadata.query_id ? [signal.metadata.query_id] : []
    );
    const priorRuleIds = (prior?.signals ?? []).flatMap((signal) =>
      signal.metadata.rule_uuid ? [signal.metadata.rule_uuid] : []
    );
    if (
      prior?.monitoring_references?.length ||
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
              prior?.monitoring_references?.some(
                (ref) => ref.sourceId === link.source_id && ref.queryId === link.query.id
              ) ||
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
                prior.assessment_note ?? ''
              );
              break;
            }
          }
        } catch {
          // A cleared/truncated run cannot supply historical proof; fresh attached evidence remains available.
        }
      }
    }
    const querySignals = buildEventQuerySignals(
      checks,
      args.assessmentNote ?? prior?.assessment_note ?? '',
      features
    );
    const firings = new Map(
      (prior?.firing_references ?? []).map((f) => [JSON.stringify([f.index, f.documentId]), f])
    );
    for (const ref of args.signalRefs) {
      const firing = this.discovery.resolveFiring(ref, sourceIds, features);
      firings.set(JSON.stringify([firing.index, firing.documentId]), firing);
    }
    const event: SignificantEvent = significantEventSchema.parse({
      ...(prior ?? {}),
      event_id: id,
      '@timestamp': new Date().toISOString(),
      source_ids: sourceIds,
      title: reviewing ? prior?.title : args.title ?? prior?.title,
      summary: reviewing ? prior?.summary : args.summary ?? prior?.summary,
      status,
      outcome_checks: measurements,
      monitoring_references: references,
      firing_references: [...firings.values()],
      severity:
        (reviewing || status === 'inactive') && prior
          ? prior.severity
          : args.severity ?? prior?.severity,
      confidence: reviewing ? prior?.confidence : args.confidence ?? prior?.confidence,
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
      blast_radius: affected.map((feature) => ({
        type: 'entity',
        feature_id: feature.id,
        subtype: feature.subtype,
        name: entityName(feature) || feature.title || feature.id,
        source_id: feature.source_id,
      })),
      causal_features:
        reviewing && !args.causalFeatureIds.length
          ? prior?.causal_features
          : causalFeatures.map((feature) => ({
              feature_id: feature.id,
              type: feature.type,
              subtype: feature.subtype,
              name:
                (feature.type === 'entity' && entityName(feature)) || feature.title || feature.id,
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
      monitoringReferences: references,
      firingReferences: [...firings.values()],
      affectedEntities: affected.map((feature) => feature.id),
      omittedCausalFeatureIds: args.causalFeatureIds.filter(
        (id) => !causalFeatures.some((f) => f.id === id)
      ),
      monitoringNextAction:
        status === 'active' && !references.some((reference) => reference.ruleId)
          ? 'Use monitoring_inventory and monitoring_rules to validate or create native coverage for this event and its measured failure condition. Update this event with actual ruleIds/queryIds. If coverage is blocked, give the concrete monitoringBlocker at finish; the current query signals remain inspectable.'
          : undefined,
      evidence: checks,
    };
  }
}
