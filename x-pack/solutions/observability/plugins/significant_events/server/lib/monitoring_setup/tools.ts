/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { createHash } from 'node:crypto';
import { Parser, BasicPrettyPrinter } from '@elastic/esql';
import { z } from '@kbn/zod/v4';
import type { KibanaRequest } from '@kbn/core/server';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import type { ToolDefinition } from '@kbn/inference-common';
import type { ExplorationRun, ExplorationCheckpoint } from '../../../common/knowledge_exploration';
import type { SignificantEventsServer } from '../../types';
import type { RouteHandlerScopedClients } from '../../routes/types';
import { explorationTools, ExplorationToolSession } from '../knowledge_exploration/tools';
import {
  MAX_MANAGED_RULES_PER_SERVICE,
  monitoredServices,
  serviceOwnershipTags,
  serviceRuleUsage,
  assertServiceRuleCapacity,
} from './guardrails';
import { BASELINE_EVIDENCE_PREFIX, summarizeBaseline } from './baseline';
import { compileMatchCountBreachQuery } from '../significant_events/rules/match_count_query_compiler';
import {
  changePointToolDefinition,
  inspectRuleChangePoints,
} from '../event_discovery/rule_change_points';
import { canCompileMatchMetric } from '../significant_events/rules/can_compile_match_metric';
import { hasForbiddenMonitoringOperations } from './source_pipeline';
import {
  toSourceTag,
  sourceIdFromOwnershipTag,
} from '../knowledge_indicators/knowledge_indicator_client/rules/rules_management_client';

export const MONITORING_OWNER_TAG = 'nightshift:agent:v2-monitoring-setup';
export const MONITORING_RULE_PREFIX = 'nightshift-v2-monitor-';
const canonicalQuery = (query: string): string => {
  const parsed = Parser.parse(query);
  return parsed.errors.length ? query : BasicPrettyPrinter.query(parsed.root);
};
const metricDimensions = (query: string): string[] => {
  const parsed = Parser.parse(query);
  const stats = parsed.root.commands.find((command) => command.name === 'stats');
  const groups = stats?.args.find(
    (argument) => !Array.isArray(argument) && argument.type === 'option' && argument.name === 'by'
  );
  if (!groups || Array.isArray(groups) || groups.type !== 'option') return [];
  return groups.args.flatMap((argument) => {
    if (Array.isArray(argument)) return [];
    if (argument.type === 'column') return [argument.name];
    const alias =
      argument.type === 'function' && argument.name === '=' ? argument.args[0] : undefined;
    return alias && !Array.isArray(alias) && alias.type === 'column' ? [alias.name] : [];
  });
};
const text = z.string().min(1).max(255);
const ruleSchema = z.object({
  action: z.enum(['baseline', 'validate', 'upsert', 'enable', 'disable', 'delete']),
  sourceId: text,
  ruleId: text.optional(),
  slug: text.optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2000).optional(),
  reason: z.string().min(1).max(1000),
  mode: z.enum(['count', 'metric']).default('count'),
  pipeline: z.string().min(1).max(10000).optional(),
  featureIds: z.array(text).max(25).optional(),
  positiveEvidenceRefs: z.array(text).max(5).default([]),
  preventiveReason: z.string().max(1000).optional(),
  groupBy: z.array(text).max(5).default([]),
  everyMinutes: z.number().int().min(1).max(1440).default(5),
  lookbackMinutes: z.number().int().min(2).max(10080).default(15),
});
const coverageSchema = z
  .array(
    z.object({
      sourceId: text,
      entity: text,
      concern: z.string().min(1).max(500),
      state: z.enum(['covered', 'partial', 'blind_spot', 'unobservable']),
      ruleIds: z.array(text).max(25).default([]),
      evidence: z.string().min(1).max(2000),
      priority: z.enum(['high', 'medium', 'low']),
      priorityReason: z.string().min(1).max(500),
    })
  )
  .max(500);
const definition = (
  description: string,
  properties: Record<string, import('@kbn/inference-common').ToolSchemaType>,
  required: string[]
): ToolDefinition => ({ description, schema: { type: 'object', properties, required } });
const string = { type: 'string' as const };
const number = (min: number, max: number) => ({
  type: 'number' as const,
  minimum: min,
  maximum: max,
  multipleOf: 1,
});
export const monitoringTools: Record<string, ToolDefinition> = {
  detection_sources: explorationTools.detection_sources,
  rule_change_points: changePointToolDefinition,
  source_esql: explorationTools.source_esql,
  esql_guide: explorationTools.esql_guide,
  kibana_information: explorationTools.kibana_information,
  knowledge_indicators: definition(
    'Read compact KI index/details only. action=index/read; writes are forbidden. Source IDs are opaque. Read details for relevant feature IDs before proposing monitors.',
    {
      action: { type: 'string', enum: ['index', 'read'] },
      sourceId: string,
      ids: { type: 'array', items: string },
      query: string,
      includeProvenance: { type: 'boolean' },
      offset: number(0, 10000),
      limit: number(1, 100),
    },
    ['action']
  ),
  monitoring_inventory: definition(
    'Read native Kibana rules, including user rules and existing detection signal rules. Returns compact native IDs, metadata, enabled state and query scope. Count monitors include needsValidation and their editable queryReference; validate their current predicate before claiming covered. Default list shows agent-owned rules; includeOtherRules=true provides bounded context for overlap checks. ruleIds fetch targeted details. Only configured-source coverage counts. Rules created by this agent are the only mutable ones.',
    {
      includeOtherRules: { type: 'boolean' },
      offset: number(0, 10000),
      limit: number(1, 100),
      ruleIds: { type: 'array', items: string },
    },
    []
  ),
  monitoring_rules: definition(
    'Validate or maintain a native managed Kibana signal rule for one configured source. Actions baseline/validate/upsert/enable/disable/delete. baseline describes complete-minute candidate history before installing: per-group median, p95, spread, older/newer mean, sample count and gaps; no thresholds are inferred. Start with a small lookbackMinutes; baseline caps at 24 hours and returns at most 20 groups. Missing count buckets remain unknown, not zero. reason required. upsert requires slug,title,description,pipeline,featureIds. count mode: WHERE-only pipeline, source-wide aggregation grouped ONLY by bucket (groupBy cannot add service dimensions). Use metric mode with CASE/SUM and explicit service/namespace STATS BY for grouped counts, healthy zeroes or ratios. metric mode: STATS emitting datetime bucket and numeric metric_value, optional groupBy columns. No FROM/JOIN/ENRICH/FORK/comments; server supplies source view and time filter. Count mode uses native 5m cadence and 7m lookback; metric mode accepts everyMinutes. LookbackMinutes bounds validation. At most seven active managed rules per service and namespace across sources; grouped rules consume one slot for each service they cover. Inventory guardrails include zero-link services. Prioritize investigating namespaces with no useful managed or verified external coverage before adding redundant intents elsewhere. Inspect inventory guardrails and existing user coverage; a limit is not a target. Reuse or disable lower-priority owned rules when at capacity. Native metadata allows 20 tags including four reserved ownership tags and emitting-service tags: partition broad intents into bounded namespace/cohort rules (prefer at most 15 services each) after a tag-limit failure. Keep a compact rule set; consolidate equivalent intents. Every featureId must belong to this source, with source-local emitting service anchors; read the source-filtered KI index. Do not SUM/AVG cumulative counter types as counts/rates; use available gauges or log/span outcomes when source views cannot support TS. Metric upserts require at least one observed non-null numeric value; an empty/null series is not validated coverage. ES|QL LIKE uses * and ? wildcards, not SQL %. Count rules test positiveEvidenceRefs against the predicate. If no recent rows match, supply positiveEvidenceRefs or a justified preventiveReason. Do not use preventiveReason to bypass a failed observed example. JSON key order is not stable: prefer independent predicates or JSON_EXTRACT. Preventive zero-match monitors need KI grounding. Only exact agent-owned rules can be changed. Stable slug identifies an intent; reuse it to update. An equivalent parsed query for the same source reuses the existing rule even if the requested slug differs. Native grouping includes the emitted metric dimensions. Empty featureIds are allowed for enable/disable/delete; validate/upsert require KI grounding. Native Kibana executes rules; never creates SLOs, anomaly jobs, KIs or notifications.',
    {
      action: {
        type: 'string',
        enum: ['baseline', 'validate', 'upsert', 'enable', 'disable', 'delete'],
      },
      sourceId: string,
      ruleId: {
        type: 'string',
        description:
          'Existing owned native rule ID only. Omit or empty for new rules. Never invent an ID.',
      },
      slug: string,
      title: string,
      description: string,
      reason: string,
      mode: {
        type: 'string',
        enum: ['count', 'metric'],
        description:
          'count for WHERE-only filters; metric for an aggregation emitting date bucket and numeric metric_value. Filter-only pipelines are normalized to count.',
      },
      pipeline: string,
      featureIds: { type: 'array', items: string },
      positiveEvidenceRefs: {
        type: 'array',
        items: string,
        description:
          'Run-local source_esql positive raw/sample log rows with every field used by the predicate; up to five. Schema rows and count/level-only aggregates cannot validate a message predicate. An unknown column in a ROW witness may mean the selected evidence omitted it, not a missing source field.',
      },
      preventiveReason: {
        type: 'string',
        description:
          'Only for a genuinely not-yet-observed preventive condition, with supporting KI/field evidence. Zero matches never prove a regex is correct.',
      },
      groupBy: { type: 'array', items: string },
      everyMinutes: number(1, 1440),
      lookbackMinutes: number(2, 10080),
    },
    ['action', 'sourceId', 'reason']
  ),
  finish_exploration: definition(
    'Complete the monitoring run with actual outcome and a source-scoped coverage report. coverageJson is a JSON array of {sourceId,entity,concern,state,ruleIds,evidence}. State: covered/partial/blind_spot/unobservable. Include priority (high/medium/low) and priorityReason explaining criticality and the actual use-case gap; baselines alone do not cover failures. A rule count is not a coverage score. Explain existing SLO/user-rule/anomaly coverage in evidence. Before finishing, investigate every discovered blind_spot/partial concern using relevant KI details, source schema and targeted logs/traces/metrics plus applicable existing Kibana coverage. Continue exploration and candidate baseline/validation while useful untried checks remain within run limits; a coverage report alone does not close a gap. Each unresolved concern needs evidence of what was checked and a concrete telemetry, capacity, cost or execution limitation. Rule limits constrain creation, not investigation. Set coverageComplete=false and remainingGaps for unresolved actionable gaps; use partial when a blocker or actual run limit prevented required exploration. Never loop indefinitely or continue after cancellation.',
    {
      outcome: { type: 'string', enum: ['configured', 'unchanged', 'partial'] },
      summary: string,
      coverageComplete: { type: 'boolean' },
      remainingGaps: { type: 'array', items: string },
      coverageJson: {
        type: 'string',
        description:
          'JSON array. Every entry requires sourceId, entity, concern, state (covered/partial/blind_spot/unobservable), ruleIds, evidence, priority (high/medium/low), and priorityReason (explain impact and verified existing coverage). Maximum 64000 characters.',
      },
    },
    ['outcome', 'summary', 'coverageComplete', 'remainingGaps', 'coverageJson']
  ),
};

export const ownedMonitoringRules = async (clients: RouteHandlerScopedClients) => {
  const { alertingV2RulesClient } = await clients.getSignificantEventsAlertingContext();
  const rules = [];
  for (let page = 1; page <= 100; page++) {
    const response = await alertingV2RulesClient.findRules({
      filter: `metadata.tags: "${MONITORING_OWNER_TAG}"`,
      page,
      perPage: 100,
    });
    rules.push(...response.items);
    if (!response.items.length || rules.length >= response.total) break;
  }
  return rules;
};
export const countMonitoringRules = async (clients: RouteHandlerScopedClients): Promise<number> =>
  (await ownedMonitoringRules(clients)).length;
export const resetMonitoringRules = async (
  clients: RouteHandlerScopedClients
): Promise<{ features: number }> => {
  const rules = await ownedMonitoringRules(clients);
  const { alertingV2RulesClient } = await clients.getSignificantEventsAlertingContext();
  const ki = await clients.getKnowledgeIndicatorClient();
  let removed = 0;
  for (const rule of rules) {
    const result = await alertingV2RulesClient.bulkDeleteManagedRules({ ids: [rule.id] });
    if (result.errors.length)
      throw new Error(result.errors.map((error) => error.error.message).join('; '));
    const sourceId = (rule.metadata.tags ?? []).map(sourceIdFromOwnershipTag).find(Boolean);
    if (sourceId) await ki.bulk(sourceId, [{ delete: { type: 'query', id: rule.id } }]);
    removed++;
  }
  return { features: removed };
};

export class MonitoringToolSession {
  private reads: ExplorationToolSession;
  private validatedRules = new Set<string>();
  private baselines = new Map<
    string,
    { checkedAt: string; query: string; summary: ReturnType<typeof summarizeBaseline> }
  >();
  finished = false;
  constructor(
    server: SignificantEventsServer,
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
  private source(id: string) {
    const source = this.sources.find((item) => item.id === id && item.enabled);
    if (!source) throw new Error('Select an enabled configured source in this space');
    return source;
  }
  async execute(name: string, parameters: object): Promise<Record<string, unknown>> {
    this.signal.throwIfAborted();
    if (name === 'knowledge_indicators') {
      const action = z.object({ action: z.enum(['index', 'read']) }).parse(parameters).action;
      return this.reads.execute(name, { ...parameters, action });
    }
    if (name === 'monitoring_inventory') {
      const args = z
        .object({
          includeOtherRules: z.boolean().default(false),
          offset: z.number().int().min(0).max(10000).default(0),
          limit: z.number().int().min(1).max(100).default(50),
          ruleIds: z.array(text).max(25).optional(),
        })
        .parse(parameters);
      const { alertingV2RulesClient: rules } =
        await this.clients.getSignificantEventsAlertingContext();
      const ki = await this.clients.getKnowledgeIndicatorClient();
      const queryLinks = Object.values(
        await ki.getSourceToQueryLinksMap(this.sources.map((source) => source.id))
      ).flat();
      const allFeatures = (
        await ki.getFeatures(
          this.sources.map((source) => source.id),
          {
            limit: 10000,
          }
        )
      ).hits;
      const serviceFeatureIds = new Set(
        allFeatures
          .filter((feature) => feature.type === 'entity')
          .map((feature) => `${feature.source_id}:${feature.id}`)
      );
      const usage = await this.usage();
      const guardrails = {
        maxActiveManagedRulesPerService: MAX_MANAGED_RULES_PER_SERVICE,
        scope: 'Per service and namespace across configured sources in this space',
        serviceUsage: [...new Set([...monitoredServices(allFeatures), ...usage.keys()])].map(
          (service) => {
            const ids = usage.get(service) ?? new Set<string>();
            return {
              service,
              activeManagedRules: ids.size,
              ruleIds: [...ids],
              remainingSlots: Math.max(0, MAX_MANAGED_RULES_PER_SERVICE - ids.size),
            };
          }
        ),
        inventoryNote:
          'Zero managed-rule links require investigation of observable concerns and relevant user/SLO coverage; rule counts alone never establish monitoring quality.',

        priority:
          'A ceiling, not a target; prefer critical uncovered use cases over equal service quotas',
      };
      const inventory = args.ruleIds?.length
        ? await Promise.all(args.ruleIds.map((id) => rules.getRule({ id })))
        : undefined;
      const describe = (rule: Awaited<ReturnType<typeof rules.getRule>>) => ({
        id: rule.id,
        kind: rule.kind,
        enabled: rule.enabled,
        metadata: rule.metadata,
        schedule: rule.schedule,
        query: rule.query,
        owned: (rule.metadata.tags ?? []).includes(MONITORING_OWNER_TAG),
        needsGroupingRepair: metricDimensions(rule.query.base).some(
          (field) => !rule.grouping?.fields.includes(field)
        ),
        needsValidation:
          (rule.metadata.tags ?? []).includes('nightshift:monitor:count') &&
          !this.validatedRules.has(rule.id),
        queryReference: queryLinks
          .filter((query) => query.rule_id === rule.id)
          .map((query) => ({
            sourceId: query.source_id,
            pipeline: query.query.esql.query.slice(query.query.esql.query.indexOf('|')),
            setupBaseline: query.query.evidence
              ?.find((entry) => entry.startsWith(BASELINE_EVIDENCE_PREFIX))
              ?.slice(BASELINE_EVIDENCE_PREFIX.length),
            featureIds: query.query.features?.map((feature) => feature.id) ?? [],
            groupBy: rule.grouping?.fields.filter((field) => field !== 'bucket') ?? [],
            needsServiceLinkRepair:
              (rule.grouping?.fields ?? []).some((field) =>
                ['service.name', 'resource.attributes.service.name'].includes(field)
              ) &&
              !(query.query.features ?? []).some((feature) =>
                serviceFeatureIds.has(`${query.source_id}:${feature.id}`)
              ),
          })),
      });
      if (inventory) return { rules: inventory.map(describe), guardrails };
      const response = await rules.findRules({
        filter: args.includeOtherRules ? undefined : `metadata.tags: "${MONITORING_OWNER_TAG}"`,
        page: Math.floor(args.offset / args.limit) + 1,
        perPage: args.limit,
      });
      return {
        rules: response.items.map(describe),
        guardrails,
        total: response.total,
        hasMore: args.offset + response.items.length < response.total,
        nextOffset: args.offset + response.items.length,
      };
    }
    if (name === 'rule_change_points')
      return inspectRuleChangePoints(
        this.clients,
        this.request,
        this.sources,
        parameters,
        this.signal
      );
    if (name === 'monitoring_rules') return this.rule(parameters);
    if (name === 'finish_exploration') {
      const args = z
        .object({
          outcome: z.enum(['configured', 'unchanged', 'partial']),
          summary: z.string().min(1).max(2000),
          coverageComplete: z.boolean(),
          remainingGaps: z.array(z.string().max(500)).max(20),
          coverageJson: z.string().max(64000),
        })
        .parse(parameters);
      const coverage = coverageSchema.parse(JSON.parse(args.coverageJson));
      const { alertingV2RulesClient: rules } =
        await this.clients.getSignificantEventsAlertingContext();
      for (const cell of coverage) {
        this.source(cell.sourceId);
        for (const id of cell.ruleIds) {
          const rule = await rules.getRule({ id });
          if (cell.state === 'covered' && !rule.enabled)
            throw new Error(`Disabled rule ${id} does not provide coverage`);
          if (
            cell.state === 'covered' &&
            (rule.metadata.tags ?? []).includes(MONITORING_OWNER_TAG) &&
            (rule.metadata.tags ?? []).includes('nightshift:monitor:count') &&
            !this.validatedRules.has(id)
          )
            throw new Error(
              `Validate the existing count predicate for ${id} before claiming coverage: use its inventory queryReference with monitoring_rules action=validate, inspect positive source samples if zero matches, and repair a broken predicate in place. A saved/enabled rule alone does not prove coverage.`
            );
        }
      }
      if (args.outcome === 'unchanged' && this.run.written)
        throw new Error('Rules changed; finish as configured');
      this.run.coverage = coverage;
      this.run.outcome = args.outcome;
      this.run.summary = args.summary;
      this.run.coverageComplete = args.coverageComplete && args.outcome !== 'partial';
      this.run.remainingGaps = args.remainingGaps;
      this.finished = true;
      return { finished: true, outcome: args.outcome, coverage, changedRules: this.run.written };
    }
    return this.reads.execute(name, parameters);
  }
  private async usage() {
    const ki = await this.clients.getKnowledgeIndicatorClient();
    const sourceIds = this.sources.map((source) => source.id);
    const [rules, features, queries] = await Promise.all([
      ownedMonitoringRules(this.clients),
      ki.getFeatures(sourceIds, { limit: 10000, includeExpired: true, includeExcluded: true }),
      ki.getSourceToQueryLinksMap(sourceIds, { includeExpired: true }),
    ]);
    return serviceRuleUsage(rules, features.hits, Object.values(queries).flat());
  }

  private async baseline(
    source: NightshiftSource,
    pipeline: string,
    mode: 'count' | 'metric',
    lookbackMinutes: number
  ) {
    if (lookbackMinutes > 1440)
      throw new Error(
        'Baseline is bounded to 24 hours; start small and narrow scope before widening'
      );
    const key = JSON.stringify([source.id, canonicalQuery(pipeline), mode]);
    const aggregation =
      mode === 'count'
        ? `${pipeline} | STATS metric_value=COUNT(*) BY bucket=BUCKET(@timestamp, 1 minute)`
        : pipeline;
    const query = `FROM ${
      source.view_name
    } | WHERE \`@timestamp\` >= NOW() - ${lookbackMinutes} minutes | ${aggregation} | WHERE bucket < DATE_TRUNC(1 minute, NOW()) AND bucket >= DATE_TRUNC(1 minute, NOW()) - ${
      lookbackMinutes - 1
    } minutes | SORT bucket DESC | LIMIT 1001`;
    const response = await this.clients.streamDataEsClient.esql.query(
      { query },
      { signal: this.signal, requestTimeout: 30000 }
    );
    const result = {
      checkedAt: new Date().toISOString(),
      query,
      summary: summarizeBaseline(response),
    };
    this.baselines.set(key, result);
    this.examined.add(source.id);
    return { sourceId: source.id, query, lookbackMinutes, mode, ...result.summary };
  }

  private async rule(parameters: object): Promise<Record<string, unknown>> {
    const args = ruleSchema.parse(
      Object.fromEntries(
        Object.entries(parameters).filter(([, value]) => value !== '' && value !== null)
      )
    );
    const source = this.source(args.sourceId);
    const { alertingV2RulesClient: rules } =
      await this.clients.getSignificantEventsAlertingContext();
    const ki = await this.clients.getKnowledgeIndicatorClient(source);
    let id =
      args.ruleId ??
      (args.slug
        ? MONITORING_RULE_PREFIX +
          createHash('sha256')
            .update(JSON.stringify([this.request.spaceId, source.id, args.slug]))
            .digest('hex')
            .slice(0, 24)
        : undefined);
    if (!['upsert', 'validate', 'baseline'].includes(args.action)) {
      if (!id) throw new Error('ruleId is required');
      const existing = await rules.getRule({ id });
      if (
        !(existing.metadata.tags ?? []).includes(MONITORING_OWNER_TAG) ||
        !(existing.metadata.tags ?? []).includes(toSourceTag(source.id))
      )
        throw new Error('Only this agent’s rules for this source may be changed');
      if (args.action === 'enable') {
        const references = await ki.bulkGetQueriesByIds(source.id, [id], { includeExpired: true });
        const featureIds = references.flatMap(
          (query) => query.query.features?.map((feature) => feature.id) ?? []
        );
        const features = (
          await ki.getFeatures(source.id, {
            limit: 10000,
            includeExpired: true,
            includeExcluded: true,
          })
        ).hits.filter(
          (feature) => featureIds.includes(feature.id) || featureIds.includes(feature.uuid)
        );
        assertServiceRuleCapacity(monitoredServices(features), await this.usage(), id);
      }
      this.signal.throwIfAborted();
      const result =
        args.action === 'delete'
          ? await rules.bulkDeleteManagedRules({ ids: [id] })
          : args.action === 'disable'
          ? await rules.bulkDisableManagedRules({ ids: [id] })
          : await rules.bulkEnableManagedRules({ ids: [id] });
      if (result.errors.length)
        throw new Error(result.errors.map((error) => error.error.message).join('; '));
      if (args.action === 'delete') await ki.bulk(source.id, [{ delete: { type: 'query', id } }]);
      this.run.written++;
      return { ruleId: id, action: args.action, reason: args.reason };
    }
    if (!args.pipeline || !args.featureIds?.length)
      throw new Error('pipeline and featureIds are required');
    if (hasForbiddenMonitoringOperations(args.pipeline))
      throw new Error(
        'Use only a source-scoped pipeline; FROM, joins, comments and external operations are forbidden'
      );
    const allFeatures = (await ki.getFeatures(source.id, { limit: 10000 })).hits;
    const features = allFeatures.filter((feature) => args.featureIds?.includes(feature.id));
    if (features.length !== new Set(args.featureIds).size)
      throw new Error('Every featureId must be a current KI belonging to the source');
    const prefix = `FROM ${source.view_name}`;
    const pipeline = args.pipeline.replace(/^\s*\|/, '').trim();
    const base = `${prefix} | ${pipeline}`;
    if (canCompileMatchMetric(base)) args.mode = 'count';
    const nativeQuery =
      args.mode === 'count'
        ? compileMatchCountBreachQuery(base, '@timestamp')
        : `${prefix} | WHERE \`@timestamp\` >= NOW() - ${
            args.everyMinutes + 2
          } minutes | ${pipeline} | WHERE bucket < DATE_TRUNC(1 minute, NOW()) AND bucket >= DATE_TRUNC(1 minute, NOW()) - ${
            args.everyMinutes + 1
          } minutes`;
    if (args.action === 'baseline')
      return this.baseline(source, pipeline, args.mode, args.lookbackMinutes);
    const probe = `${prefix} | WHERE \`@timestamp\` >= NOW() - ${
      args.lookbackMinutes
    } minutes | ${pipeline} | ${
      args.mode === 'count' ? 'STATS sample_matches=COUNT(*)' : 'LIMIT 1000'
    }`;
    const response = await this.clients.streamDataEsClient.esql.query(
      { query: probe },
      { signal: this.signal, requestTimeout: 30000 }
    );
    let sampleMatches =
      args.mode === 'count' ? Number(response.values[0]?.[0] ?? 0) : response.values.length;
    let positiveExamplesMatched = 0;
    if (args.mode === 'count') {
      for (const observed of this.reads.getEvidenceRows(source.id, args.positiveEvidenceRefs)) {
        const row = { ...observed };
        if (!row.message && row.sample) row.message = row.sample;
        const assignments = Object.entries(row)
          .filter(([name]) => name === '@timestamp' || /^[a-zA-Z0-9_.]+$/.test(name))
          .map(
            ([name, value]) =>
              `\`${name}\`=${
                name === '@timestamp'
                  ? `TO_DATETIME(${JSON.stringify(value)})`
                  : JSON.stringify(value)
              }`
          );
        if (!assignments.length)
          throw new Error('Choose a positive raw log row with service fields and message');
        const result = await this.clients.streamDataEsClient.esql.query(
          { query: `ROW ${assignments.join(', ')} | ${pipeline} | STATS matched=COUNT(*)` },
          { signal: this.signal, requestTimeout: 10000 }
        );
        if (!Number(result.values[0]?.[0]))
          throw new Error(
            'Predicate does not match its positive evidence row. Check JSON key order, field names and boolean/value matching. Use independent conditions or JSON_EXTRACT; do not relabel an observed failure as preventive.'
          );
        positiveExamplesMatched++;
      }
      if (
        args.action === 'upsert' &&
        !sampleMatches &&
        !positiveExamplesMatched &&
        !args.preventiveReason?.trim()
      )
        throw new Error(
          'Zero matches are not sufficient validation. Supply positiveEvidenceRefs or explain a genuinely preventive condition with preventiveReason.'
        );
    }
    if (args.mode === 'metric') {
      const bucket = response.columns.find((column) => column.name === 'bucket');
      const value = response.columns.find((column) => column.name === 'metric_value');
      if (
        bucket?.type !== 'date' ||
        !value ||
        ![
          'long',
          'integer',
          'double',
          'float',
          'unsigned_long',
          'counter_long',
          'counter_double',
        ].includes(value.type)
      )
        throw new Error('Metric rules must emit date bucket and numeric metric_value');
      const valueColumn = response.columns.findIndex((column) => column.name === 'metric_value');
      const observedValues = response.values.filter(
        (row) =>
          row[valueColumn] !== null &&
          row[valueColumn] !== undefined &&
          Number.isFinite(Number(row[valueColumn]))
      );
      sampleMatches = observedValues.length;
      if (args.action === 'upsert' && !observedValues.length)
        throw new Error(
          'No non-null metric values were observed; a syntactically valid empty/null query is not validated monitoring. Inspect actual sample fields and filters, then validate again. ES|QL LIKE uses * and ? wildcards, not SQL %. For a preventive error ratio/count, aggregate observed operations with CASE/COUNT so healthy buckets can emit a genuine zero rather than disappear.'
        );
      if (args.groupBy.some((field) => !response.columns.some((column) => column.name === field)))
        throw new Error('groupBy must reference emitted columns');
    }
    // Grouped service metrics are linked to emitting services actually observed in the probe.
    if (args.mode === 'metric') {
      const serviceColumns = ['service.name', 'resource.attributes.service.name'];
      const namespaceColumns = ['service.namespace', 'resource.attributes.service.namespace'];
      const serviceColumn = response.columns.findIndex((column) =>
        serviceColumns.includes(column.name)
      );
      const namespaceColumn = response.columns.findIndex((column) =>
        namespaceColumns.includes(column.name)
      );
      if (serviceColumn >= 0 && namespaceColumn >= 0) {
        const observed = new Set(
          response.values.map((row) => JSON.stringify([row[serviceColumn], row[namespaceColumn]]))
        );
        for (const feature of allFeatures) {
          if (feature.type !== 'entity') continue;
          const name = feature.properties.name;
          const namespace = feature.properties.service_namespace ?? feature.properties.namespace;
          if (
            observed.has(JSON.stringify([name, namespace])) &&
            !features.some((current) => current.id === feature.id)
          )
            features.push(feature);
        }
      }
    }
    this.examined.add(source.id);
    if (id && args.action === 'validate') {
      const existing = (await ownedMonitoringRules(this.clients)).find((rule) => rule.id === id);
      if (
        existing?.query.base === nativeQuery &&
        (sampleMatches > 0 || positiveExamplesMatched > 0 || args.preventiveReason?.trim())
      )
        this.validatedRules.add(id);
    }
    if (args.action === 'validate')
      return {
        valid: true,
        mode: args.mode,
        query: nativeQuery,
        columns: response.columns,
        groupBy: response.columns
          .filter((column) => !['bucket', 'metric_value', 'sample_matches'].includes(column.name))
          .map((column) => column.name),
        featureIds: features.map((feature) => feature.id),
        rows: response.values.slice(0, 5),
        sampleMatches,
        positiveExamplesMatched,
        evidenceValidated: sampleMatches > 0 || positiveExamplesMatched > 0,
        needsPositiveEvidence:
          args.mode === 'count' && sampleMatches === 0 && positiveExamplesMatched === 0,
        lookbackMinutes: args.lookbackMinutes,
        preventive: sampleMatches === 0,
      };
    const ownedRules = await ownedMonitoringRules(this.clients);
    if (!args.ruleId) {
      const equivalent = ownedRules.find(
        (rule) =>
          (rule.metadata.tags ?? []).includes(toSourceTag(source.id)) &&
          canonicalQuery(rule.query.base) === canonicalQuery(nativeQuery)
      );
      if (equivalent) id = equivalent.id;
    }
    if (!id || !args.title || !args.description)
      throw new Error('upsert needs slug or owned ruleId, title and description');
    if (!id.startsWith(MONITORING_RULE_PREFIX))
      throw new Error('Owned monitoring rule IDs use the agent prefix');
    const existing = ownedRules.find((rule) => rule.id === id);
    if (existing && !(existing.metadata.tags ?? []).includes(toSourceTag(source.id)))
      throw new Error('An existing monitor cannot be moved to another source');
    const services = monitoredServices(features);
    if (!existing || existing.enabled) assertServiceRuleCapacity(services, await this.usage(), id);
    const serviceTags = serviceOwnershipTags(services);
    const data = {
      metadata: {
        name: args.title,
        description: args.description,
        tags: [
          MONITORING_OWNER_TAG,
          ...serviceTags,
          toSourceTag(source.id),
          `nightshift:run:${this.run.id}`,
          `nightshift:monitor:${args.mode}`,
        ],
      },
      time_field: '@timestamp',
      schedule: {
        every: `${args.mode === 'count' ? 5 : args.everyMinutes}m`,
        lookback: `${args.mode === 'count' ? 7 : args.everyMinutes + 2}m`,
      },
      grouping: {
        fields:
          args.mode === 'metric'
            ? response.columns
                .filter((column) => column.name !== 'metric_value')
                .map((column) => column.name)
            : ['bucket'],
      },
      query: { base: nativeQuery },
    };
    const nativeUnchanged =
      existing &&
      existing.query.base === nativeQuery &&
      serviceTags.every((tag) => existing.metadata.tags?.includes(tag)) &&
      existing.metadata.name === args.title &&
      existing.metadata.description === args.description &&
      existing.schedule.every === data.schedule.every &&
      JSON.stringify(existing.grouping?.fields) === JSON.stringify(data.grouping.fields);
    if (nativeUnchanged) {
      if (args.mode === 'count') this.validatedRules.add(id);
      const references = await ki.bulkGetQueriesByIds(source.id, [id]);
      const previousIds = new Set(
        references[0]?.query.features?.map((feature) => feature.id) ?? []
      );
      if (
        previousIds.size === features.length &&
        features.every((feature) => previousIds.has(feature.id)) &&
        references[0]?.query.evidence?.some((entry) => entry.startsWith(BASELINE_EVIDENCE_PREFIX))
      )
        return { unchanged: true, ruleId: id };
    }
    const previousReferences = await ki.bulkGetQueriesByIds(source.id, [id]);
    const priorBaseline =
      existing?.query.base === nativeQuery
        ? previousReferences[0]?.query.evidence?.find((entry) =>
            entry.startsWith(BASELINE_EVIDENCE_PREFIX)
          )
        : undefined;
    const baselineKey = JSON.stringify([source.id, canonicalQuery(pipeline), args.mode]);
    if (!priorBaseline && !this.baselines.has(baselineKey))
      await this.baseline(source, pipeline, args.mode, Math.min(args.lookbackMinutes, 60));
    const snapshot = this.baselines.get(baselineKey);
    let baselineEvidence = priorBaseline;
    if (!baselineEvidence && snapshot) {
      const stored = {
        ...snapshot,
        context: 'Observed setup state; not proof of normality',
        summary: { ...snapshot.summary, groups: snapshot.summary.groups.slice() },
      };
      while (stored.summary.groups.length > 1 && JSON.stringify(stored).length > 8000) {
        stored.summary.groups.pop();
        stored.summary.truncated = true;
      }
      if (JSON.stringify(stored).length <= 8000)
        baselineEvidence = BASELINE_EVIDENCE_PREFIX + JSON.stringify(stored);
    }
    this.signal.throwIfAborted();
    const currentSource = (await this.clients.sourcesClient.get(source.id)).source;
    if (!currentSource.enabled || currentSource.esql_updated_at !== source.esql_updated_at)
      throw new Error('Source changed or disabled; start a fresh run');
    const rule = existing
      ? nativeUnchanged
        ? existing
        : await rules.updateManagedRule({ id, data })
      : await rules.createManagedRule({ data: { kind: 'signal', ...data }, options: { id } });
    try {
      this.signal.throwIfAborted();
      const result = await ki.bulk(source.id, [
        {
          index: {
            query: {
              id,
              title: args.title,
              description: args.description,
              type: args.mode === 'count' ? 'match' : 'stats',
              esql: { query: base },
              evidence: [args.reason, ...(baselineEvidence ? [baselineEvidence] : [])],
              features: features.map((feature) => ({
                id: feature.id,
                run_id:
                  typeof feature.meta?.exploration_run_id === 'string'
                    ? feature.meta.exploration_run_id
                    : typeof feature.meta?.extraction_run_id === 'string'
                    ? feature.meta.extraction_run_id
                    : this.run.id,
              })),
              rule_backed: true,
              rule_id: id,
            },
          },
        },
      ]);
      if (result.applied !== 1) throw new Error('Query reference was not persisted');
    } catch (error) {
      if (!existing) await rules.bulkDeleteManagedRules({ ids: [id] });
      throw error;
    }
    this.run.written++;
    this.validatedRules.add(id);
    return {
      saved: [{ ruleId: rule.id, sourceId: source.id }],
      action: existing ? 'updated' : 'created',
      reason: args.reason,
      native: true,
    };
  }
}
