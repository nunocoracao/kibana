/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import type { ToolDefinition } from '@kbn/inference-common';

const recipes = {
  volume:
    'Choose explicit lookbackMinutes. Probe template=volume in a short interval, then compare earlier intervals with endOffsetMinutes. Capped counts/rates are lower bounds; do not extrapolate a complete day from a hot or quiet minute. Narrow dense/slow remote queries; widen sparse reads progressively. LIMIT after STATS bounds output only. LIMIT before STATS bounds aggregation input but biases results and does not guarantee cheap source-view execution. Keep exact counts/baselines separate from exploratory samples.',
  schema:
    'Use template=schema with fieldSearch and paging, then template=profile for actual scoped non-null counts. Mapped columns are authoritative; JSON keys inside message are not columns. Before KEEP/LIMIT examples, filter the observed instrument/field IS NOT NULL; arbitrary wide metric rows may belong to another instrument. Inspect a few non-null values before choosing parsing, units or instrument types. Use KEEP of observed fields with a small LIMIT for metrics/traces. Preserve service and namespace. No raw-index FROM or joins: custom pipelines are appended to the configured source view.',
  patterns:
    'Use targeted sampleKind or scoped custom pipelines for log categories. In STATS BY, CATEGORIZE must be the first grouping expression. Example after observing message and service.name: STATS count=COUNT(*), example=SAMPLE(message, 1) BY category=CATEGORIZE(message), service.name | SORT count DESC | LIMIT 20. Categories can hide distinct dependency targets; inspect variants or enumerate structured targets. SAMPLE aggregation selects examples, not a probabilistic scan reduction. Scope time and service before categorizing.',
  change_points:
    'For log-pattern shifts, first bound the configured source and use its observed message field. Example custom pipeline: STATS count=COUNT(*) BY pattern=CATEGORIZE(message), bucket=BUCKET(@timestamp, 1 hour) | SORT pattern, bucket | CHANGE_POINT count ON bucket BY pattern | WHERE type IS NOT NULL | KEEP pattern, bucket, count, type, pvalue | SORT pvalue ASC. CATEGORIZE must be the first STATS grouping. CHANGE_POINT needs at least 22 values per group; sparse categories and missing buckets can make a series inadequate. Lower pvalue means a more statistically extreme shift, not higher impact or severity. Use changed categories to choose targeted samples and validate the actual failure/outcome before saving knowledge, rules, or events.',
  relationships:
    'Use COALESCE of mapped message/body.text fields for mixed log sources rather than silently ignoring populated OTel bodies. Inspect trace parent/span identity, client/server kind, peer/destination/database/queue fields, and explicit target fields in logs. Query observed fields only. For JSON messages: EVAL target=JSON_EXTRACT(TO_STRING(message), "$.observed_target_key") | WHERE target IS NOT NULL | STATS calls=COUNT(*) BY service.name, service.namespace, target | LIMIT 30. Replace field/key placeholders from actual samples. Shared IDs/co-occurrence alone do not establish direction. Named remote components may emit no telemetry; state uncertainty.',
  metrics:
    'Inspect actual non-null instrument values, types, units and dimensions first. Distinguish gauges from cumulative counters; AVG/SUM of cumulative counters is not an event rate. Preserve numerator and denominator: use 1.0 * failures / total, not integer division. Group by actual service/namespace and complete time buckets. Inspect duration units and successful/failed outcomes. Sampling is exploratory, not an exact baseline or outage denominator. TS capabilities depend on source/view and server support.',
  errors:
    'Read the actual error and mapped schema, then correct the query; a failed query does not mean absent data. Alias aggregates explicitly: STATS count=COUNT(*) | SORT count DESC; COUNT is not COUNT(). CATEGORIZE goes first in STATS BY. LIKE uses * and ?, not SQL %. GROK and DISSECT are pipeline commands. Cast JSON_EXTRACT strings before arithmetic. Timeouts need narrower time/service scopes or bounded sampling, not the identical wide retry. Unsupported functions require a compatible alternative, not invented syntax.',
} as const;
const topics = [
  'volume',
  'schema',
  'patterns',
  'change_points',
  'relationships',
  'metrics',
  'errors',
] as const;
const guideSchema = z.object({ topic: z.enum(topics) });

export const esqlGuideTool: ToolDefinition = {
  description:
    'Read a concise ES|QL strategy/syntax reference on demand. Use volume for time-window planning, schema, patterns, change_points, relationships, metrics, or errors. No queries or model calls are executed. Recipes require actual mapped fields and compatible server capabilities; this is not a validator.',
  schema: {
    type: 'object',
    properties: { topic: { type: 'string', enum: [...topics] } },
    required: ['topic'],
  },
};

export const readEsqlGuide = (parameters: object): Record<string, string> => {
  const { topic } = guideSchema.parse(parameters);
  return {
    topic,
    guidance: recipes[topic],
    reference: 'https://www.elastic.co/docs/reference/query-languages/esql',
    limitsReference: 'https://www.elastic.co/docs/reference/query-languages/esql/commands/limit',
    warning:
      'Check observed schema and server support. Validate small queries before saving monitoring rules; reference guidance guarantees neither correctness nor cost.',
  };
};
