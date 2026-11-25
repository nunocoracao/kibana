/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { Parser } from '@elastic/esql';
import { errors, type estypes } from '@elastic/elasticsearch';
import type { KibanaRequest } from '@kbn/core/server';
import type { ToolDefinition } from '@kbn/inference-common';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import { z } from '@kbn/zod/v4';
import type { RouteHandlerScopedClients } from '../../routes/types';
import { sourceIdFromOwnershipTag } from '../knowledge_indicators/knowledge_indicator_client/rules/rules_management_client';

export const changePointToolDefinition: ToolDefinition = {
  description:
    'Investigate a statistical change in one native rule measurement series. Use a signalRef from fired_rules in this run, or an explicit ruleId, sourceId and exact emitted group. Default 60 completed minutes. At least 22 usable minutes are needed. Missing measurements are unknown. Set includeSeries for minute values. Confirm operational impact or recovery using fresh source evidence.',
  schema: {
    type: 'object',
    properties: {
      signalRef: { type: 'string' },
      includeSeries: { type: 'boolean' },
      ruleId: { type: 'string' },
      sourceId: { type: 'string' },
      lookbackMinutes: { type: 'number', description: '20 to 120 minutes; default 60' },
      groupFiltersJson: { type: 'string' },
    },
    required: [],
  },
};
interface SignalSeries {
  ruleId: string;
  kind: 'signal' | 'alert';
  sourceIds: string[];
  dimensions: Record<string, string | number | boolean | null>;
}
const MINIMUM_BUCKETS = 22;
const MINUTE = 60000;

export const inspectRuleChangePoints = async (
  clients: RouteHandlerScopedClients,
  request: KibanaRequest,
  sources: NightshiftSource[],
  parameters: object,
  signal: AbortSignal,
  resolveSignal?: (ref: string) => SignalSeries | undefined
): Promise<Record<string, unknown>> => {
  const args = z
    .object({
      ruleId: z.string().min(1).max(255).optional(),
      signalRef: z.string().min(1).max(255).optional(),
      includeSeries: z.boolean().default(false),
      sourceId: z.string().min(1).max(255).optional(),
      lookbackMinutes: z.number().int().min(20).max(120).default(60),
      groupFiltersJson: z.string().max(4000).optional(),
    })
    .parse(parameters);
  const selected = args.signalRef ? resolveSignal?.(args.signalRef) : undefined;
  if (args.signalRef && (!selected || selected.kind !== 'signal'))
    throw new Error(
      'Select a native measurement signalRef from fired_rules in this run, or supply ruleId and sourceId.'
    );
  if (
    selected &&
    ((args.ruleId && args.ruleId !== selected.ruleId) || args.groupFiltersJson !== undefined)
  )
    throw new Error(
      'A signalRef supplies its rule and group. Omit conflicting explicit selectors.'
    );
  const ruleId = selected?.ruleId ?? args.ruleId;
  const sourceId =
    args.sourceId ?? (selected?.sourceIds.length === 1 ? selected.sourceIds[0] : undefined);
  const source = sources.find((item) => item.enabled && item.id === sourceId);
  if (!ruleId || !source || (selected && !selected.sourceIds.includes(source.id)))
    throw new Error('Select one enabled sourceId belonging to the measurement and its ruleId.');
  const { alertingV2RulesClient } = await clients.getSignificantEventsAlertingContext();
  const rule = await alertingV2RulesClient.getRule({ id: ruleId });
  const ownedSources = (rule.metadata.tags ?? []).map(sourceIdFromOwnershipTag).filter(Boolean);
  if (
    ownedSources.length
      ? !ownedSources.every((id) => id === source.id)
      : !readsOnlyView(rule.query.base, source.view_name)
  )
    throw new Error(
      'Rule ownership or an exact FROM source must establish this configured source.'
    );
  const dimensions = (rule.grouping?.fields ?? []).filter((field) => field !== 'bucket');
  const groups = selected
    ? selected.dimensions
    : z
        .record(
          z.string().max(255),
          z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])
        )
        .parse(JSON.parse(args.groupFiltersJson?.trim() || '{}'));
  if (
    dimensions.some((field) => !Object.hasOwn(groups, field)) ||
    (!selected && Object.keys(groups).some((field) => !dimensions.includes(field)))
  )
    return {
      status: 'indeterminable',
      ruleId,
      sourceId,
      requiredDimensions: dimensions,
      reason: `Select one series using exactly these dimensions: ${JSON.stringify(dimensions)}.`,
    };
  const context = { ruleId, sourceId: source.id, groups, lookbackMinutes: args.lookbackMinutes };
  if (args.lookbackMinutes < MINIMUM_BUCKETS)
    return {
      ...context,
      status: 'indeterminable',
      reason: 'Select at least 22 complete minutes for change-point analysis.',
    };
  const end = Math.floor(Date.now() / MINUTE) * MINUTE;
  const start = end - args.lookbackMinutes * MINUTE;
  const response = await clients.scopedClusterClient.asCurrentUser
    .search(
      {
        index: '.rule-events',
        ignore_unavailable: true,
        size: 0,
        query: {
          bool: {
            filter: [
              { term: { space_id: request.spaceId } },
              { term: { type: 'signal' } },
              { term: { 'rule.id': ruleId } },
              { range: { '@timestamp': { gte: start } } },
              { range: { discovery_bucket: { gte: start, lt: end } } },
              ...Object.entries(groups).map(([key, value]) =>
                value === null
                  ? { bool: { must_not: [{ exists: { field: 'data.' + key } }] } }
                  : { term: { ['data.' + key]: value } }
              ),
            ],
          },
        },
        runtime_mappings: {
          discovery_bucket: {
            type: 'date',
            script: {
              source:
                'if(params._source.data!=null && params._source.data.bucket!=null) {try { emit(Long.parseLong(params._source.data.bucket.toString())); } catch (NumberFormatException ignored) {}}',
            },
          },
          discovery_value: {
            type: 'double',
            script: {
              source:
                'if(params._source.data!=null && params._source.data.metric_value!=null) {try {double v=Double.parseDouble(params._source.data.metric_value.toString()); if(Double.isFinite(v)) emit(v);} catch (NumberFormatException ignored) {}}',
            },
          },
        },
        aggs: {
          over_time: {
            date_histogram: { field: 'discovery_bucket', fixed_interval: '1m' },
            aggs: {
              last_write: { max: { field: '@timestamp' } },
              latest: {
                top_metrics: {
                  metrics: { field: 'discovery_value' },
                  sort: { '@timestamp': 'desc' },
                  size: 1,
                },
              },
            },
          },
          change_points: { change_point: { buckets_path: 'over_time>latest[discovery_value]' } },
        },
      },
      { signal, requestTimeout: 30000 }
    )
    .catch((error: unknown) => {
      signal.throwIfAborted();
      if (
        error instanceof errors.ResponseError &&
        z
          .object({ error: z.object({ 'license.expired.feature': z.literal('change-point-agg') }) })
          .safeParse(error.meta.body).success
      )
        return 'unlicensed' as const;
      if (error instanceof Error && error.name === 'TimeoutError') return undefined;
      throw error;
    });
  if (response === 'unlicensed')
    return {
      ...context,
      status: 'indeterminable',
      reason:
        'The Elasticsearch license does not include change-point analysis. Inspect the measurements with fired_rules or source_esql.',
    };
  if (
    !response ||
    response.terminated_early ||
    response.timed_out ||
    response._shards.failed ||
    response._clusters?.partial ||
    response._clusters?.failed ||
    response._clusters?.skipped
  )
    return {
      ...context,
      status: 'indeterminable',
      reason:
        'The rule-history search timed out or returned partial results. Retry before interpreting this series.',
    };

  const histogram = response.aggregations?.over_time as
    | estypes.AggregationsDateHistogramAggregate
    | undefined;
  const buckets = Array.isArray(histogram?.buckets) ? histogram.buckets : [];
  const values = new Map<number, number>();
  let invalidRevision = false;
  for (const bucket of buckets) {
    const top = (bucket.latest as estypes.AggregationsTopMetricsAggregate | undefined)?.top[0];
    const value = top?.metrics.discovery_value;
    const sort = top?.sort[0];
    const revision = typeof sort === 'string' ? Date.parse(sort) : sort;
    const latestWrite = (bucket.last_write as estypes.AggregationsMaxAggregate | undefined)?.value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (revision === latestWrite) values.set(Number(bucket.key), value);
      else invalidRevision = true;
    }
  }
  const series = Array.from({ length: args.lookbackMinutes }, (_, i) => ({
    timestamp: new Date(start + i * MINUTE).toISOString(),
    value: values.get(start + i * MINUTE) ?? null,
  }));
  const first = series.findIndex((point) => point.value !== null);
  const last = series.findLastIndex((point) => point.value !== null);
  const missingBuckets = series.length - values.size;
  const internal = first === -1 ? 0 : last - first + 1 - values.size;
  const history = {
    from: new Date(start).toISOString(),
    toExclusive: new Date(end).toISOString(),
    observedBuckets: values.size,
    missingBuckets,
    leadingMissingMinutes: first === -1 ? null : first,
    internalMissingMinutes: internal,
    trailingMissingMinutes: last === -1 ? null : series.length - last - 1,
    lastMeasurementAt: series[last]?.timestamp ?? null,
    minimumForChangePoint: MINIMUM_BUCKETS,
  };
  const result = { ...context, history, ...(args.includeSeries ? { series } : {}) };
  if (values.size < MINIMUM_BUCKETS || invalidRevision || internal)
    return {
      ...result,
      status: 'indeterminable',
      reason: invalidRevision
        ? 'A newer revision has no usable metric value.'
        : values.size < MINIMUM_BUCKETS
        ? 'Fewer than 22 complete minutes contain usable measurements.'
        : 'The measured interval contains gaps. Inspect the series or select a continuous interval.',
    };
  const analysis = response.aggregations?.change_points as
    | estypes.AggregationsChangePointAggregate
    | undefined;
  const type = Object.keys(analysis?.type ?? {})[0];
  if (type === 'stationary') return { ...result, status: 'no_change_detected' };
  if (!analysis || !type || type === 'indeterminable')
    return {
      ...result,
      status: 'indeterminable',
      reason:
        analysis?.type?.indeterminable?.reason ?? 'Elasticsearch returned no change-point verdict.',
    };
  const key = analysis.bucket?.key;
  const time = typeof key === 'number' ? key : typeof key === 'string' ? Date.parse(key) : NaN;
  const trend = analysis.type?.non_stationary?.trend;
  let direction = type === 'spike' ? 'up' : type === 'dip' ? 'down' : trend;
  let level;
  if (type === 'step_change' && values.has(time)) {
    const before: number[] = [];
    const after: number[] = [];
    for (const [minute, value] of values) (minute < time ? before : after).push(value);
    if (before.length && after.length) {
      const mean = (samples: number[]) =>
        samples.reduce((sum, value) => sum + value, 0) / samples.length;
      const beforeMean = mean(before),
        afterMean = mean(after);
      level = { beforeMean, afterMean };
      if (beforeMean !== afterMean) direction = afterMean > beforeMean ? 'up' : 'down';
    }
  }
  return {
    ...result,
    status: 'change_detected',
    changeType: type,
    ...(level ? { level } : {}),
    ...(Number.isFinite(time) ? { changedAt: new Date(time).toISOString() } : {}),
    ...(direction ? { direction } : {}),
  };
};

function readsOnlyView(query: string, view: string) {
  const { root, errors } = Parser.parse(query);
  const from = root.commands[0];
  if (
    errors.length ||
    from?.name !== 'from' ||
    root.commands.some((cmd) => ['lookup', 'join', 'fork', 'enrich'].includes(cmd.name))
  )
    return false;
  const inputs = from.args.filter((arg) => !Array.isArray(arg) && arg.type === 'source');
  return (
    inputs.length === 1 &&
    inputs.every(
      (arg) => !Array.isArray(arg) && arg.type === 'source' && !arg.prefix && arg.name === view
    )
  );
}
