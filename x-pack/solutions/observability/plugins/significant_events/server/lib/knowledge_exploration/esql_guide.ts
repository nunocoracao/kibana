/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ToolDefinition } from '@kbn/inference-common';
import { lazySchema, z } from '@kbn/zod/v4';

const recipes = {
  volume:
    'Choose explicit lookbackMinutes. Probe template=volume in a short interval, then compare earlier intervals with endOffsetMinutes. Capped counts/rates are lower bounds; do not extrapolate a complete day from a hot or quiet minute. Narrow dense/slow remote queries; widen sparse reads progressively. LIMIT after STATS bounds output only. LIMIT before STATS bounds aggregation input but biases results and does not guarantee cheap source-view execution. For high volume, use sampleProbability on scoped custom/samples/relationships reads; this emits ES|QL SAMPLE before parsing/CATEGORIZE. Stratify by service/namespace/time so rare components are not erased. Sample counts and absence are approximate; confirm incident numerators/denominators and recovery with targeted unsampled queries. CATEGORIZE compresses output but does not alone bound scanning. Keep exact counts/baselines separate from exploratory samples.',
  schema:
    'Use template=schema with fieldSearch and paging, then template=profile for actual scoped non-null counts. Mapped columns are authoritative; JSON keys inside message are not columns. JSON_EXTRACT uses JSONPath: a literal dotted key needs bracket notation, for example JSON_EXTRACT(message, "[\'error.message\']"); "error.message" navigates nested objects. JSON_EXTRACT returns a keyword: compare an extracted flag to "true" or "false", or convert it with TO_BOOLEAN before a boolean comparison. Inspect actual non-null parsed values before using them to classify failures or count request IDs. Before KEEP/LIMIT examples, filter the observed instrument/field IS NOT NULL; arbitrary wide metric rows may belong to another instrument. Inspect a few non-null values before choosing parsing, units or instrument types. Use KEEP of observed fields with a small LIMIT for metrics/traces. Preserve service and namespace. No raw-index FROM or joins: custom pipelines are appended to the configured source view.',
  patterns:
    'Scope time and service before categorizing. CATEGORIZE must be the first STATS BY expression and appear only once. Example after observing message and service.name: STATS count=COUNT(*), example=SAMPLE(message, 1) BY category=CATEGORIZE(message), service.name | SORT count DESC | LIMIT 20. Inspect representative raw examples and structured dependency targets: one category can merge different mechanisms or targets. Where supported, output_format=tokens produces readable categories; regex is the default. similarity_threshold ranges from 1 to 100 (default 70): higher values split messages more finely and use more memory; lower values can merge unlike failures. Compare scoped examples before tuning. A custom analyzer is optional; use only a known available analyzer and inspect the resulting groups. Check server/version and license support before optional settings; fall back to bounded structured grouping or targeted samples when unsupported. SAMPLE(message, n) collects examples, while the SAMPLE command/sampleProbability controls exploratory row sampling. Neither categorization nor an output LIMIT guarantees a bounded scan. Sampled category counts are approximate and may omit rare failures; confirm candidates with exact scoped outcomes.',
  change_points:
    'For log-pattern shifts, first bound the configured source and use its observed message field. Example custom pipeline: STATS count=COUNT(*) BY pattern=CATEGORIZE(message), bucket=BUCKET(@timestamp, 1 hour) | SORT pattern, bucket | CHANGE_POINT count ON bucket BY pattern | WHERE type IS NOT NULL | KEEP pattern, bucket, count, type, pvalue | SORT pvalue ASC. CATEGORIZE must be the first STATS grouping. CHANGE_POINT needs at least 22 values per group; sparse categories and missing buckets can make a series inadequate. Lower pvalue means a more statistically extreme shift, not higher impact or severity. Use changed categories to choose targeted samples and validate the actual failure/outcome before saving knowledge, rules, or events.',
  latency:
    'Inspect actual populated duration fields, JSON/logfmt keys, units, and operation identity before choosing a query. For dense exploration, apply a justified sampleProbability and compare scoped service/operation percentile distributions in recent and earlier windows; these are approximate leads. Confirm any candidate using unsampled small windows and the identical filters/grouping. Check baseline provenance: an immediately preceding window may already contain the same degradation. For a new/unverified measurement, deliberately sample multiple earlier offsets or bounded bucketed history, retain actual sample times and units, and identify the prior operating range/onset before concluding unchanged means normal. When a nearby earlier window is similar but not verified healthy, expand geometrically instead of accepting it: a scoped sampled hour of minute buckets is a useful initial exploration, then expand within retention if needed. Locate temporal steps in successful-operation latency even when no error marker exists, then exactly confirm a small earlier/current population. Save those baseline windows with the reusable measurement. For observed millisecond-valued durations, the pipeline shape is EVAL duration_value=TO_DOUBLE(the_observed_duration) | STATS observations=COUNT(*), p50=PERCENTILE(duration_value,50), p95=PERCENTILE(duration_value,95), latest=MAX(@timestamp) BY service.name, service.namespace, observed_operation, bucket=BUCKET(@timestamp,1 minute). Replace every placeholder with observed source fields/parsing and preserve units. Retain outcome populations and check successful operations too. Do not assume a successful HTTP response or absence of a slow marker rules out a latency regression. Compare the measured magnitude, persistence and scope; do not invent an SLO or declare all nonzero latency unhealthy.',
  relationships:
    'Use COALESCE of mapped message/body.text fields for mixed log sources rather than silently ignoring populated OTel bodies. Inspect trace parent/span identity, client/server kind, peer/destination/database/queue fields, and explicit target fields in logs. Query observed fields only. For JSON messages: EVAL target=JSON_EXTRACT(TO_STRING(message), "$.observed_target_key") | WHERE target IS NOT NULL | STATS calls=COUNT(*) BY service.name, service.namespace, target | LIMIT 30. Replace field/key placeholders from actual samples. Shared IDs/co-occurrence alone do not establish direction. Named remote components may emit no telemetry; state uncertainty.',
  metrics:
    'Inspect actual non-null instrument values, types, units and dimensions first. Distinguish gauges from cumulative counters; AVG/SUM of cumulative counters is not an event rate. Preserve numerator and denominator: use 1.0 * failures / total, not integer division. Group by actual service/namespace and complete time buckets. monitoring_rules metric pipelines must emit bucket and metric_value, including for baseline: STATS metric_value=SUM(CASE(observed_failure_condition,1,0)) BY bucket=BUCKET(@timestamp,1 minute), service.name, service.namespace. Replace service fields and condition with observed schema. bucket=BUCKET(...) is a grouping expression after BY, not an aggregate before BY; omitting bucket also fails because native monitoring filters complete minutes. Inspect duration units and successful/failed outcomes. Sampling is exploratory, not an exact baseline or outage denominator. TS capabilities depend on source/view and server support.',
  counting:
    'Define the measurement unit before counting: log records, attempts, terminal operation outcomes, client/server spans and logical requests are different populations. Build the denominator from the same service/namespace/operation/window before filtering failures. Retain successes, failures, expected rejections and unknown outcomes separately; report observed counts when a trustworthy denominator is unavailable. COUNT(*) counts rows; COUNT(field) counts non-null values. COUNT(condition) also counts false values, so use COUNT(*) WHERE observed_failure_condition or SUM(CASE(observed_failure_condition,1,0)) to count true matches. WHERE drops null conditions; use IS NULL/IS NOT NULL and keep missing or unparsed outcomes explicit. Do not coalesce unknown outcomes to success or zero. Deduplicate only with an observed stable identity and explicit attempt/terminal semantics; do not count retries and client/server spans as separate customers. COUNT_DISTINCT is approximate and must be labelled as such; sampled distinct counts cannot be blindly extrapolated to unique requests. Snapshot gauges and invariant counts repeat state: use latest observed state and timestamps rather than summing snapshots into affected-record counts. A zero denominator produces an unknown rate.',
  time_windows:
    'Preserve event-time window, collection time, timezone, filters and units for every comparison. For a completion timestamp and verified elapsed milliseconds, EVAL started=TO_DATETIME(TO_LONG(@timestamp)-TO_LONG(elapsed_ms)); group terminal outcomes by their start cohort or correlate operation IDs. Late timeouts of earlier work do not establish current failures on new attempts. NOW() moves between calls; repeatable comparisons need recorded fixed bounds. Use aligned intervals for the same service/namespace/operation population. Distinguish a partial current bucket from complete historical buckets; do not compare their raw counts as equal-duration rates. A partial current minute can expose a new failure: qualify its coverage and confirm using fresh scoped outcomes rather than discarding it until a bucket closes. Inspect newest event time and ingestion lag when ingestion timestamps are actually mapped; otherwise state that lag is unknown. Late arrivals can change an earlier bucket on reread. Empty rows or missing buckets are not zero traffic, healthy operation or recovery. Examine query warnings, is_partial and tool truncation/pagination; incomplete or failed scans cannot establish complete absence. Follow remaining pages or narrow omitted cohorts. A completed tool call is not proof that every service or time bucket was observed. Baseline windows must predate the suspected onset; an adjacent window may already be degraded.',
  cardinality:
    'Estimate the population and grouping dimensions before an aggregate. Start with bounded time/service/namespace/operation scopes; do not group an entire estate by request ID, trace ID, raw URL, free text or every attribute. Drill into a specific route/cohort only after finding a useful lead, retaining low-volume cohorts with targeted reads. LIMIT after STATS/SORT restricts output, not the number of groups computed or source rows scanned; an input LIMIT can bias which groups appear. VALUES(field) collects every distinct value and can exhaust aggregation memory or trip a circuit breaker. Prefer small SAMPLE(field,n) examples and scoped grouped counts; use a labelled COUNT_DISTINCT estimate when only approximate cardinality is needed. A document sample can erase rare groups, so sampled absence is not proof of no failures. Follow truncation/pagination signals and inspect omitted services separately; top groups do not establish estate-wide coverage. On timeout or circuit-breaker feedback, reduce time, dimensions and source scope before retrying; do not repeat the same broad query or treat resource failure as no data.',
  errors:
    'Read the actual error and mapped schema, then correct the query; a failed query does not mean absent data. Use descriptive aliases such as first_seen/last_seen; unquoted first/last are reserved. Alias aggregates explicitly: STATS count=COUNT(*) | SORT count DESC; COUNT is not COUNT(). CATEGORIZE goes first in STATS BY. LIKE uses * and ?, not SQL %. GROK and DISSECT are pipeline commands. Cast JSON_EXTRACT strings before arithmetic. Timeouts need narrower time/service scopes or bounded sampling, not the identical wide retry. COUNT_IF is unsupported: use SUM(CASE(condition, 1, 0)) or COUNT(*) WHERE condition for conditional counts. Unsupported functions require a compatible alternative, not invented syntax.',
} as const;
const topics = [
  'volume',
  'schema',
  'patterns',
  'change_points',
  'latency',
  'relationships',
  'metrics',
  'counting',
  'time_windows',
  'cardinality',
  'errors',
] as const;
const topicReferences: Partial<Record<(typeof topics)[number], string>> = {
  patterns:
    'https://www.elastic.co/docs/reference/query-languages/esql/functions-operators/grouping-functions/categorize',
  counting: 'https://www.elastic.co/docs/reference/query-languages/esql/esql-null-values',
  time_windows: 'https://www.elastic.co/docs/reference/query-languages/esql/esql-rest',
  cardinality:
    'https://www.elastic.co/docs/reference/query-languages/esql/functions-operators/aggregation-functions/values',
};
const guideSchema = lazySchema(() => z.object({ topic: z.enum(topics) }));

export const esqlGuideTool: ToolDefinition = {
  description:
    'Read a concise ES|QL strategy/syntax reference on demand. Topics: volume (throughput/sampling), schema (mapped fields/parsing), patterns (CATEGORIZE controls), change_points, latency (units/baselines), relationships, metrics, counting (denominators/nulls/deduplication), time_windows (freshness/late/incomplete data), cardinality (grouping/memory), and errors (query repair). No queries or model calls are executed. Recipes require observed fields and compatible server capabilities; this is not a validator.',
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
    reference:
      topicReferences[topic] ?? 'https://www.elastic.co/docs/reference/query-languages/esql',
    limitsReference: 'https://www.elastic.co/docs/reference/query-languages/esql/commands/limit',
    warning:
      'Check observed schema and server support. Validate small queries before saving monitoring rules; reference guidance guarantees neither correctness nor cost.',
  };
};
