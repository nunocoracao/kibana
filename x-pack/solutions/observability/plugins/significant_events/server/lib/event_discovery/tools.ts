/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { KibanaRequest } from '@kbn/core/server';
import type { ToolDefinition } from '@kbn/inference-common';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import type { Feature } from '@kbn/significant-events-schema';
import { SIGNIFICANT_EVENTS_ALERT_SOURCE } from '@kbn/significant-events-schema';
import { lazySchema, z } from '@kbn/zod/v4';
import type { ExplorationCheckpoint, ExplorationRun } from '../../../common/knowledge_exploration';
import type { RouteHandlerScopedClients } from '../../routes/types';
import type { SignificantEventsServer } from '../../types';
import { explorationTools, ExplorationToolSession } from '../knowledge_exploration/tools';
import { sourceIdFromOwnershipTag } from '../knowledge_indicators/knowledge_indicator_client/rules/rules_management_client';
import { BASELINE_EVIDENCE_PREFIX, summarizeBaseline } from '../monitoring_setup/baseline';
import { MONITORING_OWNER_TAG, monitoringTools } from '../monitoring_setup/tools';
import { changePointToolDefinition, inspectRuleChangePoints } from './rule_change_points';
import { detectSeriesShift } from './signal_shift';

export const DISCOVERY_EVENT_PREFIX = 'nightshift-v2-event-';
const str = { type: 'string' as const };
const number = (minimum: number, maximum: number) => ({
  type: 'number' as const,
  minimum,
  maximum,
});
const text = lazySchema(() => z.string().min(1).max(255));
const tool = (
  description: string,
  properties: Record<string, import('@kbn/inference-common').ToolSchemaType>,
  required: string[] = []
): ToolDefinition => ({
  description,
  schema: { type: 'object', properties, required },
});
export const discoveryTools: Record<string, ToolDefinition> = {
  detection_sources: explorationTools.detection_sources,
  source_esql: explorationTools.source_esql,
  esql_guide: explorationTools.esql_guide,
  kibana_information: explorationTools.kibana_information,
  knowledge_indicators: monitoringTools.knowledge_indicators,
  rule_change_points: changePointToolDefinition,
  fired_rules: tool(
    'Read native managed/user rule firings in the last 30 minutes, scoped to enabled configured sources and this space. Native metric series are measurements, not alerts. Groups retain service/namespace and emitted dimensions; overlapping buckets are deduplicated. action=index returns at most 25 compact groups per page (follow hasMore/nextOffset), with signalRefs and descriptive older/newer baseline statistics with gap warnings; action=read returns at most three selected signals per detail page, with points, setupBaseline details and exact source metadata. Follow hasMore/nextOffset with the SAME signalRefs list to obtain all requested details; large histories can shorten the page further. Index exposes setupBaselineAvailable without repeating full setup histories for every group. Investigate each independent shifted/error family by namespace; a global error-count rise can contain several unrelated problems. Existing historical change-point detections are optional context. Follow hasMore/nextOffset. Unattributable user alerts are excluded and counted; never assume global alerts belong to a source.',
    {
      action: { type: 'string', enum: ['index', 'read'] },
      signalRefs: { type: 'array', items: str },
      offset: number(0, 10000),
      limit: number(1, 25),
    }
  ),
  events: tool(
    'Index/read/upsert only this agent’s native significant-event assessments. Both active and inactive are persisted and visible in Detection Events. upsert requires stable issueKey, sourceIds, signalRefs from fired_rules, title, summary, assessmentNote, active/inactive status, severity, confidence, and featureIds (can be empty). evidenceRefs are run-local source_esql rows. Reuse issueKey and eventId for continuing correlated issues, including an inactive uncertain candidate whose new evidence now confirms the same problem. New signal types or a broader affected path do not by themselves mean a new issue. Inspect prior notes and affectedEntities/causalFeatures; honor operator dismissal. featureIds use the exact logical id from knowledge_indicators, never a storage UUID, and identify relevant context/affected entities. causalFeatureIds is a subset supported by directed failure evidence, never all related KIs by default. Leave it empty when the cause is unresolved. No hypothetical root cause or invented IDs. Native rule signals are stored separately from legacy change-point detections; no fake detections. At least one actual scoped signal is required. Active relevance requires a concrete failure/degradation/exposure assessment rather than a baseline firing alone. Active writes must cite a current source check with lookbackMinutes<=3 or an actual active alert from the last five minutes; older samples establish history, not current state. Severity follows verified impact: a modest approximately 10 percent delay without harmful outcomes is low at most; verified service/path outage is high; critical needs widespread impact or security exposure. Confidence is 0 to 1 and must not substitute for impact evidence.',
    {
      action: { type: 'string', enum: ['index', 'read', 'upsert'] },
      eventId: str,
      eventIds: { type: 'array', items: str },
      issueKey: str,
      sourceIds: { type: 'array', items: str },
      signalRefs: { type: 'array', items: str },
      featureIds: { type: 'array', items: str },
      causalFeatureIds: { type: 'array', items: str },
      evidenceRefs: { type: 'array', items: str },
      title: str,
      summary: str,
      assessmentNote: str,
      hypothesis: str,
      status: { type: 'string', enum: ['active', 'inactive'] },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      confidence: number(0, 1),
      offset: number(0, 10000),
      limit: number(1, 100),
    },
    ['action']
  ),
  finish_exploration: tool(
    'Finish with assessed, nothing_new or partial. assessed means useful native active/inactive assessments saved; nothing_new means no new material assessment needed; partial records genuine essential blockers. Report actual coverageComplete and concrete remainingGaps. Do not fabricate an event merely to finish.',
    {
      outcome: { type: 'string', enum: ['assessed', 'nothing_new', 'partial'] },
      summary: str,
      coverageComplete: { type: 'boolean' },
      remainingGaps: { type: 'array', items: str },
    },
    ['outcome', 'summary', 'coverageComplete', 'remainingGaps']
  ),
};

interface NativeDocument {
  '@timestamp': string;
  type?: string;
  source?: string;
  space_id?: string;
  rule?: { id?: string };
  alert?: { status?: string };
  group_hash?: string;
  data?: Record<string, string | number | boolean | null>;
}
interface LegacyDocument {
  service?: { name?: string; namespace?: string };
  '@timestamp': string;
  'kibana.alert.rule.uuid'?: string;
  'kibana.alert.rule.name'?: string;
  'kibana.alert.status'?: string;
  'service.name'?: string;
  'service.namespace'?: string;
}
interface SignalPoint {
  timestamp: string;
  value: number | null;
  alertId: string;
}
interface FiredSignal {
  signalRef: string;
  ruleId: string;
  ruleName: string;
  origin: 'managed' | 'user';
  kind: 'signal' | 'alert';
  sourceIds: string[];
  dimensions: Record<string, string | number | boolean | null>;
  points: SignalPoint[];
  query: string;
  latestStatus?: string;
  setupBaseline?: string;
}
const property = (feature: Feature, name: string): string =>
  typeof feature.properties[name] === 'string' ? String(feature.properties[name]) : '';
const normalize = (name: string): string => name.toLowerCase().replaceAll('_', '-');
const ownedFilter = (space: string) => ({
  bool: {
    filter: [
      { term: { space_id: space } },
      { term: { type: 'alert' } },
      { term: { source: SIGNIFICANT_EVENTS_ALERT_SOURCE } },
      { wildcard: { 'data.event_id': 'nightshift-problem-*' } },
    ],
  },
});
export const countDiscoveryEvents = async (clients: RouteHandlerScopedClients): Promise<number> => {
  const response = await clients.scopedClusterClient.asCurrentUser.search({
    index: '.rule-events',
    ignore_unavailable: true,
    size: 0,
    query: ownedFilter(clients.space),
    aggs: { series: { cardinality: { field: 'group_hash', precision_threshold: 40000 } } },
  });
  const agg = response.aggregations?.series as { value?: number } | undefined;
  return agg?.value ?? 0;
};
export const resetDiscoveryEvents = async (
  clients: RouteHandlerScopedClients
): Promise<{ features: number }> => {
  const count = await countDiscoveryEvents(clients);
  await clients.scopedClusterClient.asCurrentUser.deleteByQuery({
    index: '.rule-events',
    ignore_unavailable: true,
    conflicts: 'proceed',
    refresh: true,
    query: ownedFilter(clients.space),
  });
  return { features: count };
};

export class EventDiscoveryToolSession {
  private reads: ExplorationToolSession;
  private signals = new Map<string, FiredSignal>();
  private loaded = false;
  private loadIncomplete = false;
  finished = false;
  constructor(
    private server: SignificantEventsServer,
    private clients: RouteHandlerScopedClients,
    private request: KibanaRequest,
    private run: ExplorationRun,
    private sources: NightshiftSource[],
    checkpoints: Record<string, ExplorationCheckpoint>,
    private signal: AbortSignal,
    reads?: ExplorationToolSession
  ) {
    this.reads =
      reads ??
      new ExplorationToolSession(server, clients, request, run, sources, checkpoints, signal);
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

  private resolveSources(
    dimensions: Record<string, string | number | boolean | null>,
    features: Feature[]
  ): string[] {
    const name = String(
      dimensions['service.name'] ??
        dimensions['resource.attributes.service.name'] ??
        dimensions.service_name ??
        ''
    );
    const namespace = String(
      dimensions['service.namespace'] ??
        dimensions['resource.attributes.service.namespace'] ??
        dimensions.service_namespace ??
        ''
    );
    if (!name) return [];
    const matches = features.filter(
      (feature) =>
        feature.type === 'entity' &&
        normalize(property(feature, 'name')) === normalize(name) &&
        (!namespace ||
          (property(feature, 'service_namespace') || property(feature, 'namespace')) === namespace)
    );
    const namespaces = new Set(
      matches.map(
        (feature) => property(feature, 'service_namespace') || property(feature, 'namespace')
      )
    );
    if (!namespace && namespaces.size > 1) return [];
    return [...new Set(matches.map((feature) => feature.source_id))];
  }

  private async loadSignals(): Promise<void> {
    if (this.loaded) return;
    const enabled = this.sources.filter((source) => source.enabled);
    const sourceIds = new Set(enabled.map((source) => source.id));
    const ki = await this.clients.getKnowledgeIndicatorClient();
    const features = (await ki.getFeatures([...sourceIds], { limit: 10000 })).hits;
    const { alertingV2RulesClient } = await this.clients.getSignificantEventsAlertingContext();
    const rules = [];
    for (let page = 1; page <= 20; page++) {
      const result = await alertingV2RulesClient.findRules({ page, perPage: 100 });
      rules.push(...result.items);
      if (rules.length >= result.total || !result.items.length) break;
      if (page === 20) this.loadIncomplete = true;
    }
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    const links = Object.values(await ki.getSourceToQueryLinksMap([...sourceIds])).flat();
    const currentRules = new Set(rules.map((rule) => rule.id));
    const es = this.clients.scopedClusterClient.asCurrentUser;
    let after: Array<string | number> | undefined;
    const pit = await es.openPointInTime({
      index: '.rule-events',
      keep_alive: '2m',
      ignore_unavailable: true,
    });
    let excluded = 0;
    try {
      for (let page = 0; page < 10; page++) {
        this.signal.throwIfAborted();
        const response = await es.search<NativeDocument>(
          {
            pit: { id: pit.id, keep_alive: '2m' },
            size: 1000,
            query: {
              bool: {
                filter: [
                  { term: { space_id: this.request.spaceId } },
                  { range: { '@timestamp': { gte: 'now-30m' } } },
                  { terms: { type: ['signal', 'alert'] } },
                ],
                must_not: [{ term: { source: SIGNIFICANT_EVENTS_ALERT_SOURCE } }],
              },
            },
            sort: [{ '@timestamp': 'asc' }, { _shard_doc: 'asc' }],
            search_after: after,
          },
          { signal: this.signal, requestTimeout: 30000 }
        );
        for (const hit of response.hits.hits) {
          const doc = hit._source;
          const ruleId = doc?.rule?.id;
          if (!doc || !ruleId || !currentRules.has(ruleId)) continue;
          const rule = byId.get(ruleId);
          if (!rule) continue;
          const dimensionKeys = new Set([
            ...(rule.grouping?.fields ?? []).filter((key) => key !== 'bucket'),
            ...[
              'service.name',
              'service.namespace',
              'resource.attributes.service.name',
              'resource.attributes.service.namespace',
              'service_name',
              'service_namespace',
            ].filter((key) => doc.data?.[key] !== undefined),
          ]);
          const dimensions = Object.fromEntries(
            [...dimensionKeys].map((key) => [key, doc.data?.[key] ?? null])
          );
          const tagged = (rule.metadata.tags ?? [])
            .map(sourceIdFromOwnershipTag)
            .filter((id): id is string => Boolean(id) && sourceIds.has(String(id)));
          const querySources = enabled
            .filter((source) => rule.query.base.includes(source.view_name))
            .map((source) => source.id);
          const referenceSources = links
            .filter((link) => link.rule_id === ruleId)
            .map((link) => link.source_id);
          const attributed = this.resolveSources(dimensions, features);
          const scoped = [
            ...new Set([...tagged, ...querySources, ...referenceSources, ...attributed]),
          ].filter((id) => sourceIds.has(id));
          if (!scoped.length) {
            excluded++;
            continue;
          }
          const key = JSON.stringify([
            ruleId,
            Object.entries(dimensions).sort(([a], [b]) => a.localeCompare(b)),
          ]);
          let entry = [...this.signals.values()].find(
            (item) =>
              JSON.stringify([
                item.ruleId,
                Object.entries(item.dimensions).sort(([a], [b]) => a.localeCompare(b)),
              ]) === key
          );
          if (!entry) {
            const ref = 'signal-' + (this.signals.size + 1);
            entry = {
              signalRef: ref,
              ruleId,
              ruleName: rule.metadata.name,
              origin: (rule.metadata.tags ?? []).includes(MONITORING_OWNER_TAG)
                ? 'managed'
                : 'user',
              kind: doc.type === 'alert' ? 'alert' : 'signal',
              sourceIds: scoped,
              dimensions,
              points: [],
              query: rule.query.base,
            };
            this.signals.set(ref, entry);
          }
          const raw = doc.data?.metric_value;
          const value = raw === undefined || raw === null ? null : Number(raw);
          const bucket = doc.data?.bucket;
          const timestamp =
            bucket !== undefined && Number.isFinite(Number(bucket))
              ? new Date(Number(bucket)).toISOString()
              : doc['@timestamp'];
          const point = {
            timestamp,
            value: Number.isFinite(value) ? value : null,
            alertId: hit._id ?? '',
          };
          const previous = entry.points.findIndex((item) => item.timestamp === timestamp);
          if (previous >= 0) entry.points[previous] = point;
          else entry.points.push(point);
          entry.latestStatus = doc.alert?.status;
        }
        if (response.hits.hits.length < 1000) break;
        after = response.hits.hits.at(-1)?.sort as Array<string | number> | undefined;
        if (page === 9) this.loadIncomplete = true;
      }
    } finally {
      await es.closePointInTime({ id: pit.id });
    }
    try {
      const legacy = await es.search<LegacyDocument>(
        {
          index: '.alerts-observability.*',
          ignore_unavailable: true,
          allow_no_indices: true,
          size: 500,
          query: {
            bool: {
              filter: [
                { term: { 'kibana.space_ids': this.request.spaceId } },
                { range: { '@timestamp': { gte: 'now-30m' } } },
              ],
            },
          },
          sort: [{ '@timestamp': 'desc' }],
        },
        { signal: this.signal, requestTimeout: 30000 }
      );
      for (const hit of legacy.hits.hits) {
        const doc = hit._source;
        const ruleId = doc?.['kibana.alert.rule.uuid'];
        if (!doc || !ruleId) continue;
        const dimensions = {
          'service.name': doc['service.name'] ?? doc.service?.name ?? '',
          'service.namespace': doc['service.namespace'] ?? doc.service?.namespace ?? '',
        };
        const scoped = this.resolveSources(dimensions, features).filter((id) => sourceIds.has(id));
        if (!scoped.length) {
          excluded++;
          continue;
        }
        const ref = 'signal-' + (this.signals.size + 1);
        this.signals.set(ref, {
          signalRef: ref,
          ruleId,
          ruleName: doc['kibana.alert.rule.name'] ?? ruleId,
          origin: 'user',
          kind: 'alert',
          sourceIds: scoped,
          dimensions,
          points: [{ timestamp: doc['@timestamp'], value: null, alertId: hit._id ?? '' }],
          query: '',
          latestStatus: doc['kibana.alert.status'],
        });
      }
      if (legacy.hits.hits.length === 500) this.loadIncomplete = true;
    } catch (error) {
      this.signal.throwIfAborted();
      this.server.logger.debug(`Legacy user alert read unavailable: ${String(error)}`);
      this.loadIncomplete = true;
    }
    for (const item of this.signals.values())
      item.points.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (const item of this.signals.values()) {
      item.setupBaseline = links
        .find((link) => link.rule_id === item.ruleId)
        ?.query.evidence?.find((entry) => entry.startsWith(BASELINE_EVIDENCE_PREFIX))
        ?.slice(BASELINE_EVIDENCE_PREFIX.length);
    }
    this.loaded = true;
    this.run.discovery = {
      signalCount: this.signals.size,
      active: 0,
      inactive: 0,
      excludedUnattributed: excluded,
    };
  }

  async execute(name: string, parameters: object): Promise<Record<string, unknown>> {
    this.signal.throwIfAborted();
    if (name === 'knowledge_indicators') {
      const action = z.object({ action: z.enum(['index', 'read']) }).parse(parameters).action;
      return this.reads.execute(name, { ...parameters, action });
    }
    if (name === 'rule_change_points')
      return inspectRuleChangePoints(
        this.clients,
        this.request,
        this.sources,
        parameters,
        this.signal
      );
    if (name === 'fired_rules') {
      const args = z
        .object({
          action: z.enum(['index', 'read']).default('index'),
          signalRefs: z.array(text).max(25).default([]),
          offset: z.number().int().min(0).max(10000).default(0),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(25)
            .transform((limit) => Math.min(limit, 25)),
        })
        .parse(parameters);
      await this.loadSignals();
      if (args.action === 'read') {
        const signals = args.signalRefs
          .slice(args.offset, args.offset + Math.min(args.limit, 3))
          .map((ref) => {
            const item = this.signals.get(ref);
            if (!item) throw new Error('Use a signalRef from this run');
            return item;
          });
        while (signals.length > 1 && JSON.stringify(signals).length > 48000) signals.pop();
        const nextOffset = args.offset + signals.length;
        return {
          signals,
          total: args.signalRefs.length,
          hasMore: nextOffset < args.signalRefs.length,
          nextOffset: nextOffset < args.signalRefs.length ? nextOffset : null,
        };
      }
      const all = [...this.signals.values()];
      const latestOf = (item: FiredSignal) => Date.parse(item.points.at(-1)?.timestamp ?? '');
      const newestByRule = new Map<string, number>();
      for (const item of all) {
        const latest = latestOf(item);
        if (Number.isFinite(latest))
          newestByRule.set(item.ruleId, Math.max(newestByRule.get(item.ruleId) ?? latest, latest));
      }
      const minutesBehind = (item: FiredSignal) => {
        const latest = latestOf(item);
        const newest = newestByRule.get(item.ruleId);
        return Number.isFinite(latest) && newest !== undefined
          ? Math.floor((newest - latest) / 60000)
          : 0;
      };
      const stopped = all.filter((item) => item.kind === 'signal' && minutesBehind(item) >= 2);
      const shiftOf = (item: FiredSignal) =>
        item.kind === 'signal'
          ? detectSeriesShift(
              item.points
                .map((point) => point.value)
                .filter((value): value is number => value !== null)
            )
          : undefined;
      const shifted = all.filter((item) => shiftOf(item));
      return {
        lookbackMinutes: 30,
        ...(shifted.length
          ? {
              shifted: shifted.map((item) => ({
                signalRef: item.signalRef,
                dimensions: item.dimensions,
                ...shiftOf(item),
              })),
            }
          : {}),
        ...(stopped.length
          ? {
              stoppedReporting: stopped.map((item) => ({
                signalRef: item.signalRef,
                dimensions: item.dimensions,
                minutesBehindRule: minutesBehind(item),
              })),
            }
          : {}),
        signals: all.slice(args.offset, args.offset + args.limit).map((item) => {
          const values = item.points
            .map((point) => point.value)
            .filter((value): value is number => value !== null);
          return {
            ...item,
            query: undefined,
            points: undefined,
            setupBaseline: undefined,
            setupBaselineAvailable: Boolean(item.setupBaseline),
            first: item.points[0],
            latest: item.points.at(-1),
            pointCount: item.points.length,
            baseline:
              item.kind === 'signal'
                ? summarizeBaseline({
                    columns: [
                      { name: 'bucket', type: 'date' },
                      { name: 'metric_value', type: 'double' },
                    ],
                    values: item.points
                      .filter((point) => point.value !== null)
                      .map((point) => [point.timestamp, point.value]),
                  })
                : undefined,
            min: values.length ? Math.min(...values) : null,
            max: values.length ? Math.max(...values) : null,
            ...(shiftOf(item) ? { shift: shiftOf(item) } : {}),
            ...(item.kind === 'signal' && minutesBehind(item) >= 2
              ? {
                  stoppedReporting: {
                    minutesBehindRule: minutesBehind(item),
                    note: 'No measurement in the newest buckets while the same rule still measures other groups. Missing rows are not zeros: the component may have stopped working, stopped logging or lost its input.',
                  },
                }
              : {}),
          };
        }),
        total: all.length,
        hasMore: args.offset + args.limit < all.length,
        nextOffset: args.offset + args.limit,
        coverageComplete: !this.loadIncomplete,
        excludedUnattributed: this.run.discovery?.excludedUnattributed ?? 0,
      };
    }
    if (name === 'events') throw new Error('Use the unified problem event tool');
    if (name === 'finish_exploration') {
      const args = z
        .object({
          outcome: z.enum(['assessed', 'nothing_new', 'partial']),
          summary: z.string().min(1).max(2000),
          coverageComplete: z.boolean(),
          remainingGaps: z.array(z.string().max(500)).max(20),
        })
        .parse(parameters);
      if (args.outcome === 'nothing_new' && this.run.written)
        throw new Error('Assessments changed; finish assessed');
      this.run.outcome = args.outcome;
      this.run.summary = args.summary;
      this.run.coverageComplete = args.coverageComplete && !this.loadIncomplete;
      this.run.remainingGaps = args.remainingGaps;
      if (this.loadIncomplete)
        this.run.remainingGaps.push(
          'A signal read was partial; excluded or unavailable signals are not proof of inactivity.'
        );
      this.finished = true;
      return { finished: true, ...args, discovery: this.run.discovery };
    }
    return this.reads.execute(name, parameters);
  }
}
