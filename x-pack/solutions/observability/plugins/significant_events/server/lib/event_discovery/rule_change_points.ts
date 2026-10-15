/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { z } from '@kbn/zod/v4';
import type { estypes } from '@elastic/elasticsearch';
import type { KibanaRequest } from '@kbn/core/server';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import type { ToolDefinition } from '@kbn/inference-common';
import type { RouteHandlerScopedClients } from '../../routes/types';
import { sourceIdFromOwnershipTag } from '../knowledge_indicators/knowledge_indicator_client/rules/rules_management_client';

export const changePointToolDefinition: ToolDefinition = {
  description:
    'OPTIONAL statistical investigation for one source-scoped native rule/group. Not a mandatory monitoring or discovery step. ruleId comes from inventory, sourceId from configured sources; groupFiltersJson contains actual emitted dimensions (without bucket). Reads at most 120 minutes. Returns Elasticsearch change-point evidence and history size; fewer than 22 observed complete buckets or gapped series may be indeterminable, and a change never establishes an incident. Use source checks, user thresholds and observed outcomes too.',
  schema: {
    type: 'object',
    properties: {
      ruleId: { type: 'string' },
      sourceId: { type: 'string' },
      lookbackMinutes: { type: 'number', description: '20 to 120 minutes; default 60' },
      groupFiltersJson: { type: 'string' },
    },
    required: ['ruleId', 'sourceId'],
  },
};
export const inspectRuleChangePoints = async (
  clients: RouteHandlerScopedClients,
  request: KibanaRequest,
  sources: NightshiftSource[],
  parameters: object,
  signal: AbortSignal
): Promise<Record<string, unknown>> => {
  const args = z
    .object({
      ruleId: z.string().min(1).max(255),
      sourceId: z.string().min(1).max(255),
      lookbackMinutes: z.number().int().min(20).max(120).default(60),
      groupFiltersJson: z.string().max(4000).default('{}'),
    })
    .parse(parameters);
  const source = sources.find((item) => item.id === args.sourceId && item.enabled);
  if (!source) throw new Error('Use an enabled configured source');
  const { alertingV2RulesClient } = await clients.getSignificantEventsAlertingContext();
  const rule = await alertingV2RulesClient.getRule({ id: args.ruleId });
  if (
    !(rule.metadata.tags ?? []).some((tag) => sourceIdFromOwnershipTag(tag) === source.id) &&
    !rule.query.base.includes(source.view_name)
  )
    throw new Error('Rule query/ownership must establish the configured source');
  const groups = z
    .record(z.string().max(255), z.union([z.string().max(1000), z.number(), z.boolean()]))
    .parse(JSON.parse(args.groupFiltersJson.trim() || '{}'));
  const dimensions = (rule.grouping?.fields ?? []).filter((field) => field !== 'bucket');
  if (dimensions.some((field) => groups[field] === undefined))
    throw new Error(
      'Specify every emitted grouping dimension to analyze one series; do not pool services or namespaces.'
    );
  for (const key of Object.keys(groups))
    if (key === 'bucket' || !rule.grouping?.fields.includes(key))
      throw new Error('groupFiltersJson uses actual rule dimensions, excluding bucket');
  const response = await clients.scopedClusterClient.asCurrentUser.search(
    {
      index: '.rule-events',
      ignore_unavailable: true,
      size: 0,
      query: {
        bool: {
          filter: [
            { term: { space_id: request.spaceId } },
            { term: { type: 'signal' } },
            { term: { 'rule.id': args.ruleId } },
            { range: { '@timestamp': { gte: `now-${args.lookbackMinutes}m` } } },
            { range: { discovery_bucket: { gte: `now-${args.lookbackMinutes}m`, lt: 'now/m' } } },
            ...Object.entries(groups).map(([key, value]) => ({ term: { ['data.' + key]: value } })),
          ],
        },
      },
      runtime_mappings: {
        discovery_bucket: {
          type: 'date',
          script: {
            source:
              'if(params._source.data!=null && params._source.data.bucket!=null) emit(Long.parseLong(params._source.data.bucket.toString()));',
          },
        },
        discovery_value: {
          type: 'double',
          script: {
            source:
              'if(params._source.data!=null && params._source.data.metric_value!=null) emit(Double.parseDouble(params._source.data.metric_value.toString()));',
          },
        },
      },
      aggs: {
        over_time: {
          date_histogram: { field: 'discovery_bucket', fixed_interval: '1m' },
          aggs: {
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
  );
  const histogram = response.aggregations?.over_time as
    | estypes.AggregationsDateHistogramAggregate
    | undefined;
  const buckets = Array.isArray(histogram?.buckets) ? histogram.buckets : [];
  const observedBuckets = buckets.filter((bucket) => bucket.doc_count > 0);
  return {
    history: {
      observedBuckets: observedBuckets.length,
      missingBuckets: buckets.length - observedBuckets.length,
      minimumForChangePoint: 22,
      revisions: 'latest per bucket',
    },
    ruleId: args.ruleId,
    sourceId: args.sourceId,
    lookbackMinutes: args.lookbackMinutes,
    groups,
    analysis: response.aggregations,
    warning:
      'Statistical evidence only; no root cause, relevance or recovery verdict. Missing history may be indeterminable.',
  };
};
