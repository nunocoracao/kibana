/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'node:crypto';
import { z } from '@kbn/zod/v4';
import { deriveQueryType } from '@kbn/streams-schema';
import type { ToolDefinition } from '@kbn/inference-common';
type ToolResponseStructured = Record<string, unknown>;
type ToolDefinitions = Record<string, ToolDefinition>;
import { getEsqlColumnSchema, getSigEventsLogPatternsEsql } from '@kbn/ai-tools';
import { createTracedEsClient } from '@kbn/traced-es-client';
import {
  hasSameFingerprint,
  identifiedFeatureSchema,
  mergeFeature,
  normalizeFeatureSlug,
} from '@kbn/significant-events-schema';
import type { BaseFeature, StreamQuery } from '@kbn/significant-events-schema';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import type { KibanaRequest } from '@kbn/core/server';
import type { ObservedEntity } from './dependency_evidence';
import { dependencyCandidates, rowIdentity } from './dependency_evidence';
import {
  buildServiceScopeFilter,
  sourceLogExpression,
  sourceIdentityColumns,
} from './source_scope';
import {
  explorationWindowSchema,
  sourceTimeWindow,
  volumeQuery,
  summarizeVolume,
} from './source_volume';
import { esqlGuideTool, readEsqlGuide } from './esql_guide';
import { pageSourceFields } from './source_paging';
import { summarizeNamespaceInventory } from './namespace_inventory';
import type { ExplorationRun, ExplorationCheckpoint } from '../../../common/knowledge_exploration';
import type { SignificantEventsServer } from '../../types';
import type { RouteHandlerScopedClients } from '../../routes/types';
import { validateEsqlQueryForSourceOrThrow } from '../significant_events/validate_esql_query';

const stringSchema = z.string().max(255);
const sourceIdsSchema = z.array(stringSchema).min(1).max(100);
const sourceQuerySchema = z.object({
  sourceIds: sourceIdsSchema,
  template: z.enum([
    'volume',
    'profile',
    'novelty',
    'schema',
    'inventory',
    'patterns',
    'relationships',
    'infrastructure',
    'technology',
    'peers',
    'trace_links',
    'custom',
    'samples',
  ]),
  pipeline: z.string().max(10000).optional(),
  serviceNames: z.array(stringSchema).max(25).optional(),
  serviceNamespace: stringSchema.optional().transform((value) => value || undefined),
  checkpointKey: z.string().max(100).optional(),
  maxRows: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(25)
    .transform((value) => Math.min(value, 100)),
  offset: z.number().int().min(0).max(10000).default(0),
  fieldSearch: z.string().max(200).optional(),
  sampleKind: z
    .enum(['representative', 'dependencies', 'errors', 'startup'])
    .default('representative'),
  lookbackHours: z.number().int().min(1).max(87600).optional(),
  ...explorationWindowSchema.shape,
});
const queryKiInputSchema = z.object({
  id: z.string().min(1).max(255),
  title: z.string().min(1).max(255),
  description: z.string().max(2000),
  esql: z.object({ query: z.string().min(1).max(10000) }),
  severity_score: z.number().min(0).max(100).optional(),
  evidence: z.array(z.string().max(2000)).max(5).optional(),
  features: z
    .array(z.object({ id: z.string().max(255) }))
    .max(25)
    .optional(),
});
const knowledgeSchema = z.object({
  action: z.enum(['index', 'read', 'upsert']),
  sourceId: stringSchema.optional(),
  ids: z.array(stringSchema).max(25).optional(),
  query: z.string().max(500).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(50),
  includeProvenance: z.boolean().default(false),
  queryOffset: z.number().int().min(0).max(10000).default(0),
  queryLimit: z.number().int().min(1).max(100).default(50),
  featuresJson: z.string().max(64000).optional(),
  queriesJson: z.string().max(64000).optional(),
  features: z
    .array(
      identifiedFeatureSchema.and(
        z.object({ evidence_refs: z.array(z.string().max(30)).max(25).optional() })
      )
    )
    .max(25)
    .optional(),
});
const kibanaSchema = z.object({
  action: z.enum(['catalog', 'describe', 'execute']),
  toolId: stringSchema.optional(),
  parameters: z.record(z.string().max(100), z.json()).optional(),
  parametersJson: z.string().max(10000).optional(),
  query: z.string().max(200).optional(),
  checkpointKey: z.string().max(100).optional(),
});
const KNOWLEDGE_DIMENSIONS = [
  'entities',
  'dependencies',
  'infrastructure',
  'technologies',
  'schema',
] as const;
const DIMENSION_STATUSES = ['learned', 'already_known', 'unobservable', 'unexplored'] as const;
const MAX_REMAINING_GAPS = 20;
const finishSchema = z.object({
  outcome: z.enum(['learned', 'nothing_new', 'partial']),
  summary: z.string().min(1).max(2000),
  coverageComplete: z.boolean(),
  remainingGaps: z.array(z.string().min(1).max(500)).max(MAX_REMAINING_GAPS),
  dimensionReview: z
    .array(
      z.object({
        namespace: z.string().min(1).max(255),
        dimension: z.enum(KNOWLEDGE_DIMENSIONS),
        status: z.enum(DIMENSION_STATUSES),
        basis: z.string().min(1).max(300),
      })
    )
    .min(1)
    .max(100),
});

/** Unexplored dimensions become carried-over gaps so the next run resumes them. */
export const mergeUnexploredDimensions = (
  remainingGaps: string[],
  review: Array<{ namespace: string; dimension: string; status: string; basis: string }>
): string[] => {
  const unexplored = review
    .filter((item) => item.status === 'unexplored')
    .map((item) => `${item.namespace}: ${item.dimension} unexplored (${item.basis})`.slice(0, 500));
  return [...new Set([...remainingGaps, ...unexplored])].slice(0, MAX_REMAINING_GAPS);
};

const boundedNumber = (minimum: number, maximum: number) => ({
  type: 'number' as const,
  minimum,
  maximum,
  multipleOf: 1,
});
const boundedString = (maxLength: number) => ({ type: 'string' as const, maxLength });

export const explorationTools: ToolDefinitions = {
  esql_guide: esqlGuideTool,
  detection_sources: {
    description:
      'List enabled detection sources in this space and their short KI/checkpoint inventories. Call first. Sources are paged and never contain raw logs.',
    schema: {
      type: 'object',
      properties: {
        offset: boundedNumber(0, 10000),
        limit: boundedNumber(1, 100),
      },
    },
  },
  source_esql: {
    description:
      'Read enabled logs, metrics and traces using bounded source-scoped ES|QL. Batch sourceIds. IMPORTANT: samples, patterns and relationships inspect LOG MESSAGES only. For metrics/traces use schema then template=custom with KEEP of observed fields and LIMIT, or compact STATS. A log-template unavailable result does not mean missing metric/span data. For traces, inspect actual kind, peer and duration rows; for metrics, inspect actual instrument values, types and units. novelty compares compact schema, service/deployment/version and categorized-pattern inventories against the previous successful run; unchanged counts do not cause novelty. Other templates: profile, schema, inventory, patterns, relationships, infrastructure, samples, custom. Use esql_guide topic=change_points for bounded CATEGORIZE + CHANGE_POINT recipes. profile requires fieldSearch (pipe-separated keywords), applies service/namespace scope and counts actual non-null observations for up to 12 mapped fields per page. Use it before interpreting sparse metric rows; schema presence is not populated data. samples provides bounded categorized excerpts per selected service, with sampleKind representative/dependencies/errors/startup; no custom ES|QL needed. Every call REQUIRES explicit lookbackMinutes; there is no default. First use template=volume with an agent-chosen short interval to measure capped document count, docs/sec and latency without schema or pattern scans. Choose subsequent windows based on that result. Use endOffsetMinutes to sample earlier hours/minutes across a day; zero means now. Volume is source-wide, not service-filtered. A capped count is a lower bound, not an exact rate. On remote clusters avoid broad aggregates until probes justify them. Use esql_guide for query strategies and common syntax errors. Widen time for sparse services, startup evidence or unresolved connections; a quiet recent window is not proof of absence. LIMIT bounds output, not scanned data: always bound time and target fields/services before aggregating. Try targeted samples when aggregates omit a needed operation. infrastructure inventories actual non-null Kubernetes clusters/namespaces/nodes/workloads/pods, hosts/hostnames/IPs, containers and cloud resource fields together with service identity. Use fieldSearch for focused resource subsets (e.g. k8s.pod|k8s.node or host.name|host.ip), offset/maxRows to page. Do not group every mapped infrastructure field across a dense estate at once. Empty results mean absent metadata, never invent infrastructure. technology groups every emitting service and namespace by its populated SDK, runtime and language fields (telemetry.sdk.*, telemetry.distro.*, process.runtime.*, service.language.*) in one compact STATS; use it once per source and window to ground technology KIs per service. peers groups every emitting service by the populated peer, destination and provider fields its own logs carry (peer.service, server.address, db.system, messaging.*, rpc.*, feature_flag.provider.name, url.domain); a caller naming a component there is direct dependency evidence. trace_links lists sets of two to four services that log under the same trace IDs, with trace counts: undirected candidates to confirm with samples before saving. relationships returns categorized representative dependency log clues grouped by service, with exact evidence references. Use it after the service inventory. candidates offers optional relationship hints from a few recognized formats; it is incomplete and never validates or gates KI writes. Inspect rows and structured payloads yourself even when candidates is empty. Use JSON_EXTRACT for JSON messages, FIELD_EXTRACT for mapped flattened objects, and DISSECT/GROK for plaintext. Schema columns are authoritative: never guess top-level fields; JSON keys inside message are not columns. Novelty/schema results have paging metadata; use offset/maxRows and schema fieldSearch (pipe-separated keywords) to request missing details. Views do not expose _id; use rowRefs, never fabricated document IDs. Include service.name and message for dependencies. For ratios, use floating-point arithmetic (1.0 * failures / total or TO_DOUBLE(failures) / total); integer division can silently turn a real partial failure rate into zero. Retain numerator and denominator while checking the result. CATEGORIZE must be first in STATS BY. Alias aggregates explicitly: STATS count=COUNT(*) BY service.name | SORT count DESC; COUNT is not the column name of an unaliased COUNT(). infrastructure, samples, relationships and custom automatically apply serviceNames and serviceNamespace BEFORE the pipeline; these filters do not scope the source-wide schema/pattern catalog. Use samples for per-service log categories. relationships supports targeted endpoint exploration and offset/maxRows for paging. Empty optional filters mean no filter. Custom pipeline is appended to FROM the selected source view; no FROM/JOIN/ENRICH/FORK allowed. Use KEEP, STATS, CATEGORIZE and small LIMIT. For category shifts, STATS count=COUNT(*) BY pattern=CATEGORIZE(observed_message_field), bucket=BUCKET(@timestamp, 1 hour) | SORT pattern,bucket | CHANGE_POINT count ON bucket BY pattern | WHERE type IS NOT NULL; use at least 22 values per pattern, and treat pvalue as statistical evidence rather than severity. Logs templates do not replace metric/trace exploration: inspect actual populated instruments/span attributes using schema plus bounded custom queries. Preserve service and namespace. Returns compact changed rows first, truncation and query provenance.',
    schema: {
      type: 'object',
      properties: {
        sourceIds: { type: 'array', items: { type: 'string' } },
        template: {
          type: 'string',
          enum: [
            'volume',
            'profile',
            'novelty',
            'schema',
            'inventory',
            'patterns',
            'relationships',
            'infrastructure',
            'technology',
            'peers',
            'trace_links',
            'custom',
            'samples',
          ],
        },
        pipeline: { type: 'string' },
        serviceNames: { type: 'array', items: boundedString(255) },
        serviceNamespace: boundedString(255),
        checkpointKey: { type: 'string' },
        maxRows: boundedNumber(1, 100),
        offset: boundedNumber(0, 10000),
        fieldSearch: boundedString(200),
        sampleKind: {
          type: 'string',
          enum: ['representative', 'dependencies', 'errors', 'startup'],
        },
        endOffsetMinutes: {
          ...boundedNumber(0, 5256000),
          description:
            'End the interval this many minutes ago to sample older periods. Omit or use zero for now.',
        },
        lookbackMinutes: {
          ...boundedNumber(1, 5256000),
          description:
            'Required, no default. Choose from a volume probe and the question being investigated; do not blindly scan 24 hours.',
        },
      },
      required: ['sourceIds', 'template', 'lookbackMinutes'],
    },
  },
  kibana_information: {
    description:
      'Inspect Kibana through available read-only tools: rules, alerts, SLOs, APM services, infrastructure, dashboards and related metadata. action=catalog lists compact tool IDs and descriptions, optionally filtered by query; action=describe returns the selected tool input schema; action=execute invokes a catalogued read-only tool with parameters. Results are bounded. checkpointKey compares an inventory with its previous successful-run snapshot. Pass execute arguments as parametersJson, a JSON-encoded object matching the described schema, for example {"serviceName":"gateway","start":"now-24h","end":"now"}. This supports dynamic Kibana tool inputs on models with fixed object schemas. Validation failures return the actual input schema; correct the missing fields rather than repeating an empty object.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['catalog', 'describe', 'execute'] },
        toolId: { type: 'string' },
        parameters: { type: 'object', properties: {} },
        parametersJson: boundedString(10000),
        query: { type: 'string' },
        checkpointKey: { type: 'string' },
      },
      required: ['action'],
    },
  },
  knowledge_indicators: {
    description:
      'Read/write existing-schema feature KIs and non-rule-backed stats query KIs. The first unfiltered index page includes namespaceInventory with deduplicated KI counts and relationshipInvestigationNeeded hints. Use this to prioritize service-only namespaces; counts are stored knowledge, not completeness or observability scores. index returns the canonical logical id to use for KI reads, featureIds and causalFeatureIds; storage UUIDs are not agent references. It otherwise returns only identity/title/type/confidence/namespace: page with offset/limit (AT MOST 100 per page; follow hasMore/nextOffset) and optional sourceId/query (query matches any whitespace/pipe/comma-separated keyword). index also returns compact queryRecords (reusable source-scoped query KIs), paged independently with queryOffset/queryLimit. read fetches selected feature/query IDs (max 25) across enabled sources or one sourceId, details later. read defaults to compact semantic details and bounded exact evidence; keep includeProvenance=false for ordinary monitoring/investigation; includeProvenance=true requests the stored extraction history. Follow hasMore/nextOffset for detail pages. upsert batches schema-valid features for one enabled source (featuresJson accepts up to 100 and is split into batches of 25 server-side; features accepts 25). queriesJson accepts up to 25 query KIs with stable id/title/description/esql.query and optional evidence/features; only stats queries are accepted, so extraction never creates alert rules. Reuse IDs; prefer evidence_refs from source_esql rowRefs/entityGaps/patterns with evidence=[] so the server copies exact evidence; only observed document IDs. The tool checks schema and ID/type collisions, not the quality or interpretation of evidence. Writes are merged and provenance is recorded. Each observing source needs its own service entity anchor for downstream native-rule associations: an entity saved on logs is not a source-local entity on metrics/traces. Reuse logical IDs across sources, deduplicate within each source. needsDetails means evidence was not delivered: narrow to one namespace with maxRows=5 before judging completeness. Write dependencies with properties.source/target as actual service names and properties.source_namespace/target_namespace, not top-level fields or KI IDs. Use evidence_refs for exact observed log rows. Infrastructure KIs use type=infrastructure and subtype=kubernetes_cluster/kubernetes_namespace/kubernetes_node/kubernetes_workload/kubernetes_pod/host/container/cloud_resource/network_endpoint. Properties are extensible; use name plus actual cluster/node/pod/workload/host_name/host_id/hostname/ip/ips/container_id/image/provider/region/zone/service_name/service_namespace as observed. Reuse identities and link only services observed on that resource. Also persist observed technology, infrastructure and schema KIs, including log formats (schema/log_format with properties.format and properties.services naming every emitting service that uses it) and recurring operational patterns as schema/log_pattern. Never infer languages from log formatting alone. Omit sourceId for an index/read across all enabled sources. Upsert requires one exact sourceId; send one write call at a time per source and retry a source-write-in-progress error only after its current write finishes. Prefer featuresJson for upsert: a compact JSON-encoded array using only needed property keys, avoiding fixed-schema placeholder fields. The same KI schema and 25-item limit apply; features remains supported. Valid evidence_refs are authoritative: the server copies real evidence, so omit redundant literal evidence. Upsert responses echo sourceId and non-blocking warnings for evidence references from another source or unknown handles; inspect them and correct ownership rather than ignoring a successful-but-misattributed batch. Never combine metric and trace contracts under one sourceId. Save useful discoveries immediately in small coherent batches as evidence is established; do not hold all KIs until the end of exploration. Each dependency has one actual caller and one actual target, never a pipe-joined endpoint family. This tool does not generate alert rules.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['index', 'read', 'upsert'] },
        sourceId: { type: 'string' },
        ids: { type: 'array', items: { type: 'string' } },
        query: { type: 'string' },
        offset: boundedNumber(0, 10000),
        limit: boundedNumber(1, 100),
        queryOffset: boundedNumber(0, 10000),
        queryLimit: boundedNumber(1, 100),
        includeProvenance: { type: 'boolean' },
        featuresJson: boundedString(64000),
        queriesJson: boundedString(64000),
        features: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: {
                type: 'string',
                enum: ['entity', 'dependency', 'infrastructure', 'technology', 'schema'],
              },
              subtype: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              properties: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  service_namespace: { type: 'string' },
                  source: {
                    type: 'string',
                    description: 'Exact observed caller SERVICE NAME, never a KI ID',
                  },
                  target: {
                    type: 'string',
                    description: 'Exact observed downstream SERVICE NAME, never a KI ID',
                  },
                  source_namespace: { type: 'string' },
                  target_namespace: { type: 'string' },
                  protocol: { type: 'string' },
                  version: { type: 'string' },
                  service_name: { type: 'string' },
                  cluster: { type: 'string' },
                  namespace: { type: 'string' },
                  node: { type: 'string' },
                  workload: { type: 'string' },
                  pod: { type: 'string' },
                  pod_uid: { type: 'string' },
                  host_name: { type: 'string' },
                  host_id: { type: 'string' },
                  hostname: { type: 'string' },
                  ip: { type: 'string' },
                  ips: { type: 'array', items: { type: 'string' } },
                  container_id: { type: 'string' },
                  image: { type: 'string' },
                  provider: { type: 'string' },
                  region: { type: 'string' },
                  zone: { type: 'string' },
                },
              },
              confidence: { type: 'number' },
              evidence: { type: 'array', items: { type: 'string' } },
              evidence_refs: { type: 'array', items: { type: 'string' } },
              evidence_doc_ids: { type: 'array', items: { type: 'string' } },
              tags: { type: 'array', items: { type: 'string' } },
              meta: { type: 'object', properties: {} },
            },
            required: [
              'id',
              'type',
              'subtype',
              'title',
              'description',
              'properties',
              'confidence',
              'evidence',
              'tags',
            ],
          },
        },
      },
      required: ['action'],
    },
  },
  finish_exploration: {
    description:
      'End this run after complete novelty checks and relevant exploration. nothing_new requires healthy untruncated coverage; learned reports validated knowledge added/updated; partial preserves gaps for the next run. Report coverageComplete and remainingGaps for the evidence needed by this run. Representative aggregates and targeted samples are sufficient; do not exhaust every log or schema page. Optional deeper exploration and unavailable metadata are not mandatory gaps. Partial means a genuine blocker, an essential unresolved question, or an actual resource limit. Give a concise evidence-based summary.',
    schema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['learned', 'nothing_new', 'partial'] },
        summary: { type: 'string' },
        coverageComplete: { type: 'boolean' },
        remainingGaps: { type: 'array', items: { type: 'string' } },
        dimensionReview: {
          type: 'array',
          description:
            'One entry per observed namespace and knowledge dimension (entities, dependencies, infrastructure, technologies, schema). status: learned (saved this run), already_known (stored KIs already cover it), unobservable (checked the relevant signals and fields; say which), unexplored (not investigated). unexplored entries are carried over as gaps and make the run partial.',
          items: {
            type: 'object',
            properties: {
              namespace: boundedString(255),
              dimension: { type: 'string', enum: [...KNOWLEDGE_DIMENSIONS] },
              status: { type: 'string', enum: [...DIMENSION_STATUSES] },
              basis: boundedString(300),
            },
            required: ['namespace', 'dimension', 'status', 'basis'],
          },
        },
      },
      required: ['outcome', 'summary', 'coverageComplete', 'remainingGaps', 'dimensionReview'],
    },
  },
};

const signature = (value: object): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const field = (name: string): string => '`' + name.replaceAll('`', '``') + '`';
const compact = (value: object, maxCharacters = 12000): ToolResponseStructured => {
  const text = JSON.stringify(value);
  return text.length <= maxCharacters
    ? (value as ToolResponseStructured)
    : { truncated: true, totalCharacters: text.length, preview: text.slice(0, maxCharacters) };
};
const identityFields = [
  'service.name',
  'resource.attributes.service.name',
  'service_name',
  'service.namespace',
  'resource.attributes.service.namespace',
  'namespace',
  'service.version',
  'resource.attributes.service.version',
  'deployment.environment.name',
  'resource.attributes.deployment.environment.name',
  'deployment.environment',
  'resource.attributes.deployment.environment',
  'kubernetes.namespace',
  'resource.attributes.k8s.namespace.name',
];

const infrastructureField = (name: string): boolean =>
  /(^|\.)(k8s|kubernetes|host|cloud|container)(\.|_)/.test(name)
    ? /(^|[._])(name|id|uid|ip|ips|address|hostname|namespace|arch|architecture|version|provider|platform|region|zone|type|full)$|\.image(\.|$)|container_(id|name)$/.test(
        name
      )
    : /(^|[._])(hostname|host_id|host_name|server_ip|client_ip|source_ip|destination_ip)$|(^|\.)(server|client|source|destination|network|net|service)\.(ip|address|local\.ip|peer\.ip)$/.test(
        name
      );

export const technologyField = (name: string): boolean =>
  /(^|\.)(telemetry\.(sdk|distro|auto)\.(name|language|version)|process\.runtime\.(name|version|description)|service\.language\.(name|version)|webengine\.(name|version))$/.test(
    name
  );

export const peerField = (name: string): boolean =>
  /(^|\.)(peer\.service|server\.address|net\.peer\.name|network\.peer\.address|db\.system(\.name)?|db\.namespace|messaging\.system|messaging\.destination\.name|rpc\.system|rpc\.service|feature_flag\.provider\.name|feature_flag\.provider_name|url\.domain|http\.host|upstream\.(host|addr|address))$/.test(
    name
  );

/** Saved KIs that are persisted but still thin: no evidence, or an emitting service without a filter. */
export const followUpForSavedFeatures = (
  saved: Array<Pick<BaseFeature, 'id' | 'type' | 'subtype' | 'evidence' | 'filter'>>
) => {
  const withoutEvidence = saved.filter((item) => !item.evidence?.length).map((item) => item.id);
  const servicesWithoutFilter = saved
    .filter((item) => item.type === 'entity' && item.subtype === 'service' && !item.filter)
    .map((item) => item.id);
  if (!withoutEvidence.length && !servicesWithoutFilter.length) return undefined;
  return {
    withoutEvidence,
    servicesWithoutFilter,
    nextAction:
      'These records are saved. Refine them in a later upsert: pass evidence_refs from the rows that support each record (the tool copies the observed evidence), and give each emitting service a filter of equalities on the actual service name and namespace columns with the observed values, e.g. {"and":[{"field":"resource.attributes.service.name","eq":"cart"},{"field":"resource.attributes.service.namespace","eq":"shop"}]}. Silent or inferred components keep no filter.',
  };
};

const SERVICE_NAME_COLUMNS = ['resource.attributes.service.name', 'service.name', 'service_name'];
const TRACE_ID_COLUMNS = ['trace.id', 'trace_id', 'attributes.trace_id', 'traceId'];

/** Services that log under the same trace, as sorted sets of two to four services. */
export const traceLinksQuery = (
  sourceView: string,
  columns: readonly string[],
  window: string,
  scope: string
): string | undefined => {
  const services = SERVICE_NAME_COLUMNS.filter((name) => columns.includes(name));
  const trace = TRACE_ID_COLUMNS.find((name) => columns.includes(name));
  if (!services.length || !trace) return undefined;
  const service =
    services.length > 1 ? `COALESCE(${services.map(field).join(', ')})` : field(services[0]);
  return `FROM ${sourceView} | ${window} | ${scope}WHERE ${field(
    trace
  )} IS NOT NULL | EVAL trace_service = ${service} | WHERE trace_service IS NOT NULL | STATS services = VALUES(trace_service) BY trace_key = ${field(
    trace
  )} | EVAL size = MV_COUNT(services) | WHERE size >= 2 AND size <= 4 | EVAL link = MV_CONCAT(MV_SORT(services), " + ") | STATS traces = COUNT(*) BY link, size | SORT traces DESC | LIMIT 50`;
};

const compactResourceRow = (row: Record<string, string>): Record<string, string> => {
  const seen = new Set<string>();
  const rank = (key: string) =>
    key.startsWith('resource.attributes.') ? 0 : key.startsWith('attributes.') ? 1 : 2;
  return Object.fromEntries(
    Object.entries(row)
      .filter(([, value]) => value !== '')
      .sort(([left], [right]) => rank(left) - rank(right))
      .filter(([key, value]) => {
        const identity =
          key
            .replace(/^(resource\.attributes\.|attributes\.)/, '')
            .replace(/^container_(id|name)$/, 'container.$1') +
          '=' +
          value;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      })
  );
};

const categorizeFirst = (pipeline: string): string =>
  pipeline.replace(
    /(\bSTATS\s+[^|]*?\bBY\s+)([^|]+)/gi,
    (statement, prefix: string, grouping: string) => {
      const items: string[] = [];
      let depth = 0;
      let quoted = '';
      let start = 0;
      for (let index = 0; index < grouping.length; index++) {
        const char = grouping[index];
        if (quoted) {
          if (char === quoted && grouping[index - 1] !== '\\') quoted = '';
        } else if (['"', "'", '`'].includes(char)) quoted = char;
        else if (char === '(') depth++;
        else if (char === ')') depth--;
        else if (char === ',' && depth === 0) {
          items.push(grouping.slice(start, index).trim());
          start = index + 1;
        }
      }
      items.push(grouping.slice(start).trim());
      const category = items.findIndex((item) => /^(?:[\w]+\s*=\s*)?CATEGORIZE\s*\(/i.test(item));
      if (category <= 0) return statement;
      return `${prefix}${[items[category], ...items.filter((_, index) => index !== category)].join(
        ', '
      )} `;
    }
  );

export class ExplorationToolSession {
  readonly pendingCheckpoints: Record<string, ExplorationCheckpoint> = {};
  readonly examined = new Set<string>();
  private observations = new Map<string, Array<Record<string, string>>>();
  private references = new Map<
    string,
    { sourceId: string; row: Record<string, string>; query: string }
  >();
  private infrastructureInventories = new Map<
    string,
    {
      fields: string[];
      rows: Array<Record<string, string>>;
      rowRefs: string[];
      query: string;
      truncated: boolean;
    }
  >();
  private patternInventories = new Map<
    string,
    Awaited<ReturnType<typeof getSigEventsLogPatternsEsql>>
  >();
  private sourceSchemas = new Map<string, Awaited<ReturnType<typeof getEsqlColumnSchema>>>();
  private documentIds = new Map<string, Set<string>>();
  private evidenceQueries = new Map<string, Set<string>>();
  private unhealthy = new Set<string>();
  private failures = new Map<string, number>();
  blocked = false;
  needsServiceEntities = false;
  finished = false;

  constructor(
    private server: SignificantEventsServer,
    private clients: RouteHandlerScopedClients,
    private request: KibanaRequest,
    private run: ExplorationRun,
    private sources: NightshiftSource[],
    private checkpoints: Record<string, ExplorationCheckpoint>,
    private signal: AbortSignal
  ) {}

  private source(id: string): NightshiftSource {
    const source = this.sources.find((item) => item.id === id && item.enabled);
    if (!source)
      throw new Error(
        `Source ${id} is not enabled for detection in this space. Enabled source IDs: ${this.sources
          .filter((item) => item.enabled)
          .map((item) => item.id)
          .join(', ')}`
      );
    return source;
  }

  public getEvidenceChecks(
    sourceId: string,
    refs: string[]
  ): Array<{ query: string; row: Record<string, string> }> {
    return refs.map((id) => {
      const entry = this.references.get(id);
      if (!entry || entry.sourceId !== sourceId)
        throw new Error('Evidence reference must belong to this source and run');
      return { query: entry.query, row: entry.row };
    });
  }

  public getEvidenceRows(sourceId: string, refs: string[]): Array<Record<string, string>> {
    return refs.map((id) => {
      const entry = this.references.get(id);
      if (!entry || entry.sourceId !== sourceId)
        throw new Error('Evidence reference must belong to this source and run');
      return entry.row;
    });
  }

  private record(sourceId: string, rows: Array<Record<string, string>>, query: string): string[] {
    this.observations.set(
      sourceId,
      [...(this.observations.get(sourceId) ?? []), ...rows].slice(-5000)
    );
    const ids = this.documentIds.get(sourceId) ?? new Set<string>();
    for (const row of rows) if (row._id) ids.add(row._id);
    this.documentIds.set(sourceId, ids);
    const queries = this.evidenceQueries.get(sourceId) ?? new Set<string>();
    queries.add(query);
    this.evidenceQueries.set(sourceId, queries);
    return rows.map((row) => {
      const id = `r${this.references.size + 1}`;
      this.references.set(id, { sourceId, row, query });
      return id;
    });
  }

  private observedEntities(): ObservedEntity[] {
    return [...this.observations.values()]
      .flat()
      .map(rowIdentity)
      .filter((entity) => entity.name !== '')
      .filter(
        (entity, index, all) =>
          all.findIndex(
            (item) => item.name === entity.name && item.namespace === entity.namespace
          ) === index
      );
  }

  private containerServices(containerId: string): string[] {
    return [
      ...new Set(
        [...this.observations.values()]
          .flat()
          .filter((row) =>
            [
              row['attributes.container_id'],
              row.container_id,
              row['container.id'],
              row['resource.attributes.container.id'],
            ].includes(containerId)
          )
          .map(rowIdentity)
          .filter((entity) => entity.name)
          .map((entity) => `${entity.namespace}/${entity.name}`)
      ),
    ];
  }

  private async infrastructureInventory(
    source: NightshiftSource,
    columns: string[],
    search: string | undefined,
    lookbackMinutes: number,
    endOffsetMinutes: number,
    serviceNames?: string[],
    serviceNamespace?: string
  ) {
    const scope = buildServiceScopeFilter(columns, serviceNames, serviceNamespace);
    const key = JSON.stringify([source.id, lookbackMinutes, endOffsetMinutes, search, scope]);
    const cached = this.infrastructureInventories.get(key);
    if (cached) return cached;
    const keywords = search?.toLowerCase().split('|').filter(Boolean) ?? [];
    const fields = columns.filter(
      (name) =>
        infrastructureField(name) &&
        (!keywords.length || keywords.some((keyword) => name.toLowerCase().includes(keyword)))
    );
    if (!fields.length) return { fields, rows: [], rowRefs: [], query: '', truncated: false };
    const identity = [
      ['resource.attributes.service.name', 'service.name', 'service_name'],
      ['resource.attributes.service.namespace', 'service.namespace', 'namespace'],
    ].flatMap((options) => {
      return options.filter((option) => columns.includes(option));
    });
    identity.push(
      ...['attributes.fluent.tag', 'fluent.tag', 'data_stream.dataset'].filter((name) =>
        columns.includes(name)
      )
    );
    const query = `FROM ${source.view_name}${
      columns.includes('@timestamp')
        ? ` | ${sourceTimeWindow(lookbackMinutes, endOffsetMinutes)}`
        : ''
    } | ${scope}WHERE ${fields
      .map((name) => `${field(name)} IS NOT NULL`)
      .join(' OR ')} | STATS count=COUNT(*) BY ${[...identity, ...fields]
      .map(field)
      .join(', ')} | LIMIT 501`;
    const response = await this.clients.streamDataEsClient.esql.query(
      { query },
      { signal: this.signal, requestTimeout: 30000 }
    );
    const rawRows = response.values.map((values) =>
      Object.fromEntries(
        response.columns.map((column, index) => [
          column.name,
          values[index] === null ? '' : String(values[index]),
        ])
      )
    );
    const groups = new Map<string, Record<string, string>>();
    for (const row of rawRows) {
      const resolved = rowIdentity(row);
      const canonical = { ...row };
      delete canonical.count;
      for (const identityField of [
        'resource.attributes.service.name',
        'service.name',
        'service_name',
      ])
        if (identityField in canonical) canonical[identityField] = resolved.name;
      const groupKey = JSON.stringify(compactResourceRow(canonical));
      const prior = groups.get(groupKey);
      if (!prior) groups.set(groupKey, row);
      else {
        const count = String(Number(prior.count) + Number(row.count));
        const representative =
          row['resource.attributes.service.name'] === resolved.name ? row : prior;
        groups.set(groupKey, { ...representative, count });
      }
    }
    const rows = [...groups.values()];
    rows.sort((left, right) =>
      JSON.stringify(
        Object.fromEntries(Object.entries(left).filter(([name]) => name !== 'count'))
      ).localeCompare(
        JSON.stringify(
          Object.fromEntries(Object.entries(right).filter(([name]) => name !== 'count'))
        )
      )
    );
    const inventory = {
      fields,
      rows,
      rowRefs: this.record(source.id, rows, query),
      query,
      truncated: rawRows.length > 500,
    };
    this.infrastructureInventories.set(key, inventory);
    return inventory;
  }

  /** Emitting service/namespace grouped by populated values of the selected fields. */
  private async groupedFieldInventory(
    source: NightshiftSource,
    columns: string[],
    fields: string[],
    args: z.infer<typeof sourceQuerySchema>,
    guidance: { noFields: string; found: string; empty: string }
  ): Promise<object> {
    if (!fields.length)
      return { sourceId: source.id, fields: [], records: [], nextAction: guidance.noFields };
    const identity = [
      ...SERVICE_NAME_COLUMNS,
      'resource.attributes.service.namespace',
      'service.namespace',
      'namespace',
    ].filter((name) => columns.includes(name));
    const scope = buildServiceScopeFilter(columns, args.serviceNames, args.serviceNamespace);
    const query = `FROM ${source.view_name} | ${sourceTimeWindow(
      args.lookbackMinutes,
      args.endOffsetMinutes
    )} | ${scope}WHERE ${fields
      .map((name) => `${field(name)} IS NOT NULL`)
      .join(' OR ')} | STATS count=COUNT(*) BY ${[...identity, ...fields]
      .map(field)
      .join(', ')} | LIMIT 501`;
    const response = await this.clients.streamDataEsClient.esql.query(
      { query },
      { signal: this.signal, requestTimeout: 30000 }
    );
    const rows = response.values.map((values) =>
      Object.fromEntries(
        response.columns
          .map((column, index): [string, string] => [
            column.name,
            values[index] === null ? '' : String(values[index]),
          ])
          .filter(([, value]) => value !== '')
      )
    );
    const rowRefs = this.record(source.id, rows, query);
    const nextOffset = args.offset + args.maxRows;
    return {
      sourceId: source.id,
      fields: fields.filter((name) => rows.some((row) => row[name])),
      query,
      totalGroups: rows.length,
      records: rows.slice(args.offset, nextOffset).map((row, index) => ({
        ...row,
        observedService: rowIdentity(row),
        evidenceRef: rowRefs[args.offset + index],
      })),
      hasMore: nextOffset < rows.length,
      nextOffset: nextOffset < rows.length ? nextOffset : null,
      truncated: rows.length > 500,
      nextAction: rows.length ? guidance.found : guidance.empty,
    };
  }

  private checkpoint(key: string, value: object): boolean {
    const hash = signature(value);
    this.pendingCheckpoints[key] = { signature: hash, checkedAt: new Date().toISOString() };
    return this.checkpoints[key]?.signature !== hash;
  }

  async execute(name: string, parameters: object): Promise<ToolResponseStructured> {
    if (name === 'esql_guide') return readEsqlGuide(parameters);
    if (name === 'detection_sources') {
      const args = z
        .object({
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .parse(parameters);
      const sources = this.sources.filter((source) => source.enabled);
      return {
        total: sources.length,
        hasMore: args.offset + args.limit < sources.length,
        sources: sources.slice(args.offset, args.offset + args.limit).map((source) => ({
          id: source.id,
          slug: source.slug,
          title: source.title,
          type: source.type,
          revision: source.esql_updated_at,
          lastChecked: this.checkpoints[`${source.id}:novelty`]?.checkedAt ?? null,
        })),
        prioritySourceId: this.run.sourceId ?? null,
      };
    }
    if (name === 'source_esql') {
      const suppliedWindow = z
        .object({ lookbackMinutes: z.number().optional(), lookbackHours: z.number().optional() })
        .parse(parameters);
      const args = sourceQuerySchema.parse({
        ...parameters,
        lookbackMinutes:
          suppliedWindow.lookbackMinutes ??
          (suppliedWindow.lookbackHours === undefined
            ? undefined
            : suppliedWindow.lookbackHours * 60),
      });
      const results = [];
      for (const id of args.sourceIds) {
        if (!this.sources.some((item) => item.id === id && item.enabled)) {
          results.push({
            sourceId: id,
            error: `Unknown or disabled sourceId. Enabled source IDs: ${this.sources
              .filter((item) => item.enabled)
              .map((item) => item.id)
              .join(', ')}. Copy the ID exactly from detection_sources.`,
            coverageComplete: false,
          });
          continue;
        }
        try {
          const result = await this.querySource(this.source(id), args);
          results.push(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const unavailable = /Unknown index|not enabled|not found|unavailable/i.test(message);
          const timedOut = /timeout|timed out/i.test(message);
          if (
            !timedOut &&
            (args.template === 'novelty' || args.template === 'schema' || unavailable)
          ) {
            this.unhealthy.add(id);
            this.failures.set(id, unavailable ? 2 : (this.failures.get(id) ?? 0) + 1);
          }
          results.push({
            sourceId: id,
            error: message,
            lookbackMinutes: args.lookbackMinutes,
            endOffsetMinutes: args.endOffsetMinutes,
            nextAction: timedOut
              ? 'Reduce the time interval or scope services/fields; try a short volume probe and separate older intervals. Do not repeat the same broad scan or treat timeout as absent data.'
              : undefined,
            coverageComplete: false,
          });
        }
      }
      const targets = this.sources.filter(
        (source) => source.enabled && (!this.run.sourceId || source.id === this.run.sourceId)
      );
      this.blocked =
        targets.length > 0 && targets.every((source) => (this.failures.get(source.id) ?? 0) >= 2);
      if (JSON.stringify({ results }).length > 24000) {
        return {
          results: results.map((result) => {
            if (!('changed' in result)) {
              const details = result as Record<string, unknown>;
              return {
                sourceId: details.sourceId,
                error: details.error,
                totalGroups: details.totalGroups,
                totalColumns: details.totalColumns,
                coverageComplete: details.coverageComplete,
                truncated: details.truncated,
                needsDetails: true,
                hasMore: true,
                nextOffset: args.offset,
              };
            }
            const summary = result as {
              sourceId: string;
              changed: boolean;
              serviceGroups: number;
              entityGapCount: number;
              patternGroups: number;
              coverageComplete: boolean;
            };
            return {
              sourceId: summary.sourceId,
              changed: summary.changed,
              serviceGroups: summary.serviceGroups,
              entityGapCount: summary.entityGapCount,
              patternGroups: summary.patternGroups,
              coverageComplete: summary.coverageComplete,
              needsDetails: summary.changed || summary.entityGapCount > 0,
            };
          }),
          nextAction:
            'Batch summary only: request details one source at a time with maxRows=5 and page via offset; use fieldSearch for infrastructure/schema subsets. No evidence has been discarded from the server.',
          failed: results.some((result) => 'error' in result),
        };
      }
      return { results, failed: results.some((result) => 'error' in result) };
    }
    if (name === 'knowledge_indicators') {
      const args = knowledgeSchema.parse(parameters);
      if (args.featuresJson?.trim()) {
        const toFeatures = (items: Array<Record<string, unknown>>) =>
          knowledgeSchema.shape.features.parse(
            items.map((feature) => ({ tags: [], evidence: [], evidence_doc_ids: [], ...feature }))
          );
        let payload: Array<Record<string, unknown>>;
        try {
          payload = z
            .array(z.record(z.string().max(100), z.json()))
            .max(100)
            .parse(JSON.parse(args.featuresJson));
          toFeatures(payload.slice(0, 25));
        } catch (error) {
          throw new Error(
            `featuresJson must be a JSON array of at most 100 current-schema KIs: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        if (payload.length > 25) {
          // The KI write path accepts 25 per batch; split larger arrays rather than failing the call.
          const batches: ToolResponseStructured[] = [];
          for (let index = 0; index < payload.length; index += 25)
            batches.push(
              await this.knowledge({
                ...args,
                featuresJson: undefined,
                features: toFeatures(payload.slice(index, index + 25)),
              })
            );
          return { batches } as unknown as ToolResponseStructured;
        }
        args.features = toFeatures(payload);
      }
      return this.knowledge(args);
    }
    if (name === 'kibana_information') {
      const args = kibanaSchema.parse(parameters);
      const registry = await this.server.agentBuilder?.tools.getRegistry({ request: this.request });
      const tools = (await registry?.list()) ?? [];
      const allowed = tools.filter(
        (tool) =>
          tool.annotations?.readOnlyHint === true &&
          /observability|apm|slo|alert|rule|infra|dashboard|service|anomaly|machine.learning|\bml\b/i.test(
            `${tool.id} ${tool.description}`
          )
      );
      if (args.action === 'catalog')
        return compact({
          tools: allowed
            .filter(
              (tool) =>
                !args.query ||
                args.query
                  .toLowerCase()
                  .split(/[\s|,]+/)
                  .filter(Boolean)
                  .some((term) => `${tool.id} ${tool.description}`.toLowerCase().includes(term))
            )
            .slice(0, 60)
            .map((tool) => ({ id: tool.id, description: tool.description.slice(0, 180) })),
        });
      if (!args.toolId || !allowed.some((tool) => tool.id === args.toolId))
        return {
          error:
            'describe/execute requires a nonempty toolId from catalog; no Kibana lookup was executed.',
          nextAction:
            'Use action=catalog with a relevant query, then describe the returned tool before execute. Source-only evidence does not require an unrelated Kibana lookup.',
          availableTools: allowed
            .slice(0, 8)
            .map((tool) => ({ id: tool.id, description: tool.description.slice(0, 100) })),
        };
      if (args.action === 'describe') {
        const tool = allowed.find((item) => item.id === args.toolId);
        if (!tool) throw new Error('Read-only Kibana tool not found');
        return compact({
          id: tool.id,
          description: tool.description,
          schema: z.toJSONSchema(await tool.getSchema()),
        });
      }
      const tool = allowed.find((item) => item.id === args.toolId);
      if (!tool) throw new Error('Read-only Kibana tool not found');
      const toolSchema = await tool.getSchema();
      let toolParameters = args.parameters ?? {};
      if (args.parametersJson?.trim()) {
        try {
          toolParameters = z
            .record(z.string().max(100), z.json())
            .parse(JSON.parse(args.parametersJson));
        } catch {
          return {
            error: 'parametersJson must be a JSON object matching the described tool schema',
            schema: z.toJSONSchema(toolSchema),
          };
        }
      }
      const validatedParameters = toolSchema.safeParse(toolParameters);
      if (!validatedParameters.success)
        return {
          error:
            'Kibana tool parameters are invalid; pass the required arguments using parametersJson',
          issues: validatedParameters.error.issues,
          schema: z.toJSONSchema(toolSchema),
        };
      const result = await this.server.agentBuilder?.tools.execute({
        toolId: args.toolId,
        toolParams: validatedParameters.data,
        request: this.request,
      });
      if (!result) throw new Error('Kibana information tools are unavailable');
      const changed = args.checkpointKey
        ? this.checkpoint(
            `kibana:${args.checkpointKey}`,
            JSON.parse(
              JSON.stringify(result, (key, value) => (key === 'tool_result_id' ? undefined : value))
            )
          )
        : undefined;
      const text = JSON.stringify(result);
      // Keep tool evidence outside the model context, keyed by each enabled source.
      for (const source of this.sources.filter((item) => item.enabled))
        this.record(source.id, [{ kibana_result: text }], `Kibana tool ${args.toolId}`);
      return compact({ changed, ...result });
    }
    if (name === 'finish_exploration') {
      const parsed = finishSchema.parse(parameters);
      const args = {
        ...parsed,
        remainingGaps: mergeUnexploredDimensions(parsed.remainingGaps, parsed.dimensionReview),
      };
      const coverageComplete = args.coverageComplete && args.remainingGaps.length === 0;
      const outcome = coverageComplete ? args.outcome : 'partial';
      const targetIds = this.run.sourceId
        ? [this.run.sourceId]
        : this.sources.filter((source) => source.enabled).map((source) => source.id);
      if (
        outcome !== 'partial' &&
        targetIds.some((id) => this.unhealthy.has(id) || !this.examined.has(id))
      )
        throw new Error(
          'Coverage is incomplete: finish as partial or inspect every target source successfully'
        );
      if (outcome === 'nothing_new' && this.run.written > 0)
        throw new Error('Knowledge was written; finish as learned');
      this.run.outcome = outcome;
      this.run.coverageComplete = coverageComplete && outcome !== 'partial';
      this.run.remainingGaps = args.remainingGaps;
      this.run.summary = args.summary;
      this.finished = true;
      return {
        finished: true,
        outcome,
        coverageComplete: this.run.coverageComplete,
        remainingGaps: args.remainingGaps,
        written: this.run.written,
      };
    }
    throw new Error(`Unknown exploration tool: ${name}`);
  }

  private async querySource(
    source: NightshiftSource,
    args: z.infer<typeof sourceQuerySchema>
  ): Promise<object> {
    const now = Date.now();
    const lookbackMinutes = args.lookbackMinutes;
    const endOffsetMinutes = args.endOffsetMinutes;
    if (args.template === 'volume') {
      const query = volumeQuery(source.view_name, lookbackMinutes, endOffsetMinutes);
      const started = Date.now();
      const response = await this.clients.streamDataEsClient.esql.query(
        { query },
        { signal: this.signal, requestTimeout: 30000 }
      );
      if (response.is_partial)
        throw new Error(
          'Volume probe returned partial results; reduce the window before retrying.'
        );
      const count = Number(response.values[0]?.[0]);
      if (!Number.isFinite(count) || count < 0)
        throw new Error(
          'Volume probe did not return a valid count; do not assume this source is empty.'
        );
      return {
        sourceId: source.id,
        query,
        lookbackMinutes,
        endOffsetMinutes,
        ...summarizeVolume(count, lookbackMinutes, Date.now() - started),
      };
    }
    const inventoryKey = `${source.id}:${lookbackMinutes}:${endOffsetMinutes}`;
    const schema =
      this.sourceSchemas.get(inventoryKey) ??
      (await getEsqlColumnSchema({
        esClient: this.clients.streamDataEsClient,
        index: source.view_name,
        start: now - (lookbackMinutes + endOffsetMinutes) * 60000,
        end: now - endOffsetMinutes * 60000,
        signal: this.signal,
      }));
    this.sourceSchemas.set(inventoryKey, schema);
    if (!schema.length) {
      this.examined.add(source.id);
      this.unhealthy.delete(source.id);
      return {
        sourceId: source.id,
        empty: true,
        coverageComplete: false,
        note: 'No schema/data returned in this interval. Check older intervals or widen a cheap probe; this does not establish source-wide absence.',
      };
    }
    if (args.template === 'schema') {
      const keywords = args.fieldSearch?.toLowerCase().split('|').filter(Boolean) ?? [];
      const matching = schema.filter(
        (column) =>
          !keywords.length ||
          keywords.some((keyword) => column.name.toLowerCase().includes(keyword))
      );
      const { page, ...paging } = pageSourceFields(matching, args.offset, args.maxRows);
      const refs = this.record(
        source.id,
        page.map((column) => ({ schema_field: column.name, schema_type: column.type })),
        `Source view schema over ${lookbackMinutes} minutes ending ${endOffsetMinutes} minutes ago`
      );
      return {
        sourceId: source.id,
        identityColumns: sourceIdentityColumns(schema.map((column) => column.name)),
        columns: page.map((column, index) => ({ ...column, evidenceRef: refs[index] })),
        totalColumns: matching.length,
        ...paging,
        pagingNote: paging.offsetReset
          ? 'Requested offset exceeded the current filtered fields; returned the first matching page. Reset offset to zero when changing fieldSearch.'
          : undefined,
        metadataIdAvailable: matching.some((column) => column.name === '_id'),
      };
    }
    const columns = schema.map((column) => column.name).sort();
    if (!columns.includes('@timestamp'))
      throw new Error(
        'Source lacks @timestamp; refusing an unbounded historical scan. Inspect schema/context instead.'
      );
    if (args.template === 'profile') {
      if (!args.fieldSearch?.trim())
        throw new Error('profile requires focused fieldSearch keywords; inspect schema first');
      const keywords = args.fieldSearch
        .toLowerCase()
        .split('|')
        .map((word) => word.trim())
        .filter(Boolean);
      const matching = columns.filter((name) =>
        keywords.some((word) => name.toLowerCase().includes(word))
      );
      const { page: fields, ...paging } = pageSourceFields(
        matching,
        args.offset,
        Math.min(args.maxRows, 12)
      );
      if (!fields.length)
        return { sourceId: source.id, fields: [], totalFields: matching.length, hasMore: false };
      const scope = buildServiceScopeFilter(columns, args.serviceNames, args.serviceNamespace);
      const query = `FROM ${source.view_name} | ${sourceTimeWindow(
        lookbackMinutes,
        endOffsetMinutes
      )} | ${scope}STATS documents=COUNT(*), ${fields
        .map((name, index) => `non_null_${index}=COUNT(*) WHERE ${field(name)} IS NOT NULL`)
        .join(', ')}`;
      const response = await this.clients.streamDataEsClient.esql.query(
        { query },
        { signal: this.signal, requestTimeout: 30000 }
      );
      if (response.is_partial)
        throw new Error('Profile is partial; narrow the window/scope before interpreting counts');
      const values = Object.fromEntries(
        response.columns.map((column, index) => [column.name, response.values[0]?.[index]])
      );
      const rows = fields.map((name, index) => ({
        field: name,
        nonNullCount: values[`non_null_${index}`],
      }));
      const rowRefs = this.record(
        source.id,
        rows.map((row) => ({ field: row.field, nonNullCount: String(row.nonNullCount) })),
        query
      );
      return {
        sourceId: source.id,
        query,
        documents: values.documents,
        identityColumns: sourceIdentityColumns(columns),
        identityNote:
          'Use these actual emitting-service columns in KEEP. attributes.service.name is not a replacement for service.name/resource.attributes.service.name; a null arbitrary attribute does not mean absent emitter identity.',
        rows,
        rowRefs,
        totalFields: matching.length,
        ...paging,
        nextAction:
          'For populated fields, use WHERE field IS NOT NULL before KEEP/LIMIT, preserve the actual emitter/namespace and inspect units/type. Zero counts apply only to this interval and scope; rotate time/service before concluding absence.',
      };
    }
    if (args.template === 'infrastructure') {
      const inventory = await this.infrastructureInventory(
        source,
        columns,
        args.fieldSearch,
        lookbackMinutes,
        endOffsetMinutes,
        args.serviceNames,
        args.serviceNamespace
      );
      const nextOffset = args.offset + args.maxRows;
      const hostShare = new Map<string, Set<string>>();
      for (const row of inventory.rows) {
        const host = String(
          row['resource.attributes.host.name'] || row['host.name'] || row['host.hostname'] || ''
        ).toLowerCase();
        const container =
          row['attributes.container_id'] ||
          row.container_id ||
          row['container.id'] ||
          row['resource.attributes.container.id'];
        if (host && container)
          hostShare.set(host, (hostShare.get(host) ?? new Set()).add(container));
      }
      return {
        sourceId: source.id,
        fields: inventory.fields.filter((name) => inventory.rows.some((row) => row[name])),
        query: inventory.query,
        totalGroups: inventory.rows.length,
        records: inventory.rows.slice(args.offset, nextOffset).map((row, index) => {
          const containerId =
            row['attributes.container_id'] ||
            row.container_id ||
            row['container.id'] ||
            row['resource.attributes.container.id'];
          const services = containerId ? this.containerServices(containerId) : [];
          const hostField = ['resource.attributes.host.name', 'host.name', 'host.hostname'].find(
            (name) => row[name]
          );
          const hostValue = hostField ? String(row[hostField]).toLowerCase() : '';
          const orchestrated = Object.keys(row).some(
            (name) => row[name] && /(^|\.)(k8s|kubernetes)\./.test(name)
          );
          const hostNotContainer =
            Boolean(containerId && hostValue) &&
            !orchestrated &&
            !String(containerId).toLowerCase().startsWith(hostValue);
          return {
            ...compactResourceRow(row),
            observedService: rowIdentity(row),
            evidenceRef: inventory.rowRefs[args.offset + index],
            ...(hostNotContainer
              ? {
                  hostNotContainer: {
                    field: hostField,
                    value: row[hostField!],
                    sharedByContainers: hostShare.get(hostValue)?.size ?? 1,
                    guidance:
                      'This host value is not this container (container hostnames equal their ID prefix). It was attached by the shipping pipeline; do not record it as this service placement.',
                  },
                }
              : {}),
            ...(services.length > 1
              ? {
                  attributionWarning:
                    'Container ID is attributed to multiple service identities; record the resource without asserting service ownership.',
                  observedServiceIdentities: services,
                }
              : {}),
          };
        }),
        hasMore: nextOffset < inventory.rows.length,
        nextOffset: nextOffset < inventory.rows.length ? nextOffset : null,
        truncated: inventory.truncated,
        coverageComplete: !inventory.truncated,
        nextAction: inventory.rows.length
          ? 'Persist observed resources with evidence_refs and stable IDs. If attributionWarning is present, omit service_name/service_namespace; the resource still exists. If hostNotContainer is present, keep that host value off the container/service KI. Host fields may describe a collector, not an application host: do not claim application placement without supporting evidence. Page only when useful. Never infer Kubernetes from a container ID.'
          : 'No non-null infrastructure metadata in these fields. Check another fieldSearch subset or relevant read-only Kibana/APM tools; do not fabricate hosts or pods.',
      };
    }
    if (args.template === 'technology' || args.template === 'peers') {
      const technology = args.template === 'technology';
      return this.groupedFieldInventory(
        source,
        columns,
        columns.filter(technology ? technologyField : peerField),
        args,
        technology
          ? {
              noFields:
                'No SDK/runtime/language fields are mapped in this interval. Look for startup lines, stack traces or version banners with samples sampleKind=startup|errors before concluding technologies are unobservable.',
              found:
                'Save technology KIs per observed service with evidence_refs: programming_language from service.language.* or process.runtime.*, and from telemetry.sdk.language of an in-process SDK at moderate confidence when no runtime field exists; runtime and versions from process.runtime.*; telemetry_agent from telemetry.sdk.name/distro. Attribute each to its emitting service and namespace. Then refine each service entity KI with properties.language (and properties.runtime when observed) so the service itself carries its language. A collector or proxy that forwards telemetry is not evidence for another service.',
              empty:
                'No populated SDK/runtime/language values in this interval and scope. Rotate the time stratum or inspect startup/error samples before concluding technologies are unobservable.',
            }
          : {
              noFields:
                'No structured peer/destination/provider fields are mapped in this interval. Use trace_links, relationships and samples sampleKind=dependencies, and enumerate target keys inside message bodies.',
              found:
                'Each record is an emitting service with the populated peer-side fields its own logs name (peer.service, server.address, db.system, messaging.*, rpc.*, feature_flag.provider.name, url.domain...). A caller naming a component in these fields supports a directed dependency caller -> component; resolve addresses to known services only when the host part names that service. Save dependency KIs with evidence_refs, protocol and endpoint from the observed fields.',
              empty:
                'No populated peer/destination/provider values in this interval and scope. Rotate the time stratum, try trace_links, or inspect message bodies before concluding dependencies are unobservable.',
            }
      );
    }
    if (args.template === 'trace_links') {
      const query = traceLinksQuery(
        source.view_name,
        columns,
        sourceTimeWindow(lookbackMinutes, endOffsetMinutes),
        buildServiceScopeFilter(columns, args.serviceNames, args.serviceNamespace)
      );
      if (!query)
        return {
          sourceId: source.id,
          links: [],
          nextAction:
            'This source exposes no service name and trace ID columns together; use peers, relationships or samples instead.',
        };
      const response = await this.clients.streamDataEsClient.esql.query(
        { query },
        { signal: this.signal, requestTimeout: 30000 }
      );
      const rows = response.values.map((values) =>
        Object.fromEntries(
          response.columns.map((column, index): [string, string] => [
            column.name,
            values[index] === null ? '' : String(values[index]),
          ])
        )
      );
      const rowRefs = this.record(source.id, rows, query);
      return {
        sourceId: source.id,
        query,
        links: rows.map((row, index) => ({ ...row, evidenceRef: rowRefs[index] })),
        nextAction: rows.length
          ? 'Each link is a set of services that log under the same trace IDs, with the number of traces. Co-occurrence is undirected and a trace can span services that never call each other. Pairs (size 2) are the strongest candidates. Confirm direction and the actual caller with samples or relationships from both services (for example a caller logging a call or outcome and the callee logging its handling), then save the dependency at moderate confidence with that basis. Do not save every pair of a larger set as edges.'
          : 'No trace shared by two to four services in this interval and scope. Rotate the time stratum or use peers and relationships.',
      };
    }
    const names = identityFields.filter((name) => columns.includes(name));
    // $. names refer to ES|QL views; quoting one changes it into a physical index name.
    const base = `FROM ${source.view_name}`;
    const time = columns.includes('@timestamp')
      ? ` | ${sourceTimeWindow(lookbackMinutes, endOffsetMinutes)}`
      : '';
    let pipeline = names.length
      ? `STATS count=COUNT(*) BY ${names.map(field).join(', ')} | LIMIT 501`
      : 'STATS count=COUNT(*)';
    const warnings: string[] = [];
    if (args.template === 'relationships' || args.template === 'samples') {
      const messageExpression = sourceLogExpression(columns);
      const serviceField = [
        'resource.attributes.service.name',
        'service.name',
        'service_name',
      ].find((name) => columns.includes(name));
      if (!messageExpression || !serviceField)
        return {
          sourceId: source.id,
          rows: [],
          rowRefs: [],
          unavailable:
            'This template requires log-message fields; use template=custom with KEEP of observed schema fields and LIMIT to read metrics or traces. This is not evidence that the source is empty.',
        };
      const namespaceField = [
        'resource.attributes.service.namespace',
        'service.namespace',
        'namespace',
      ].find((name) => columns.includes(name));
      const scopedFilter = buildServiceScopeFilter(
        columns,
        args.serviceNames,
        args.serviceNamespace
      );
      const identityProof = ['attributes.fluent.tag', 'fluent.tag', 'data_stream.dataset']
        .filter((name) => columns.includes(name))
        .map(field);
      const proofGrouping = identityProof.length ? `, ${identityProof.join(', ')}` : '';
      const expressions = {
        representative: '',
        dependencies:
          'hops|upstream|downstream|dependenc|depends|https?://|grpc|rpc|connect|call to|calling|request|fetch|destination|target|publish|consum|queue|topic|broker|attempt|endpoint|peer|remote|database|cache|redis|postgres|mysql|mongo|kafka|rabbit|amqp|host=|port=|reconcil|sync',
        errors: 'error|fail|unavailable|timeout|exception|refused|fallback|retry',
        startup: 'start|listen|ready|version|runtime|initialized|boot',
      };
      const expression =
        args.template === 'relationships' ? expressions.dependencies : expressions[args.sampleKind];
      const observedTimes = columns.includes('@timestamp')
        ? ', first_seen=MIN(`@timestamp`), last_seen=MAX(`@timestamp`)'
        : '';
      pipeline = `${scopedFilter}EVAL log=${messageExpression} | ${
        expression ? `WHERE TO_LOWER(log) RLIKE ".*(${expression}).*" | ` : ''
      }STATS count=COUNT(*)${observedTimes}, sample=TOP(log, 1, "desc"), sample_low=TOP(log, 1, "asc"), sample_any=SAMPLE(log, 1) BY pattern=CATEGORIZE(log), ${field(
        serviceField
      )}${namespaceField ? `, ${field(namespaceField)}` : ''}${proofGrouping} | SORT count DESC`;
    }
    if (args.template === 'custom') {
      if (!args.pipeline) throw new Error('Custom queries require an ES|QL pipeline');
      const commands = args.pipeline
        .replace(/"(?:""|[^"])*"|'(?:''|[^'])*'|`[^`]*`/g, '')
        .toUpperCase();
      if (/[;]|\/\*|\/\//.test(commands) || /\b(FROM|ROW|JOIN|LOOKUP|ENRICH|FORK)\b/.test(commands))
        throw new Error(
          'Provide a source-scoped pipeline without FROM, JOIN, LOOKUP, ENRICH, FORK, comments or semicolons'
        );
      pipeline =
        buildServiceScopeFilter(columns, args.serviceNames, args.serviceNamespace) +
        args.pipeline.replace(/^\s*\|/, '');
      const corrected = categorizeFirst(pipeline);
      if (corrected !== pipeline) {
        pipeline = corrected;
        warnings.push('Moved CATEGORIZE to the first STATS BY expression, as required by ES|QL.');
      }
      if (!columns.includes('_id') && /`?_id`?/.test(pipeline)) {
        pipeline = pipeline.replace(/\bKEEP\s+([^|]+)/gi, (statement, projection: string) => {
          const fields = projection.split(',').map((name: string) => name.trim());
          if (!fields.some((name: string) => name === '_id' || name === '`_id`')) return statement;
          warnings.push(
            'This view does not expose _id; omitted it from KEEP. Use rowRefs as evidence_refs, with evidence_doc_ids=[] instead.'
          );
          const retained = fields.filter((name: string) => name !== '_id' && name !== '`_id`');
          return `KEEP ${retained.length ? retained.join(', ') : '*'} `;
        });
      }
    }
    const offset =
      args.template === 'relationships' || args.template === 'samples' ? args.offset : 0;
    if (offset > 9900)
      throw new Error('Relationship offset must be at most 9900; scope by service instead');
    const limit =
      args.template === 'custom' || args.template === 'relationships' || args.template === 'samples'
        ? offset + args.maxRows + 1
        : 501;
    let query = `${base}${time} | ${pipeline} | LIMIT ${limit}`;
    const executeQuery = (value: string) =>
      this.clients.streamDataEsClient.esql.query(
        { query: value, drop_null_columns: false },
        { signal: this.signal, requestTimeout: 30000 }
      );
    const response = await executeQuery(query).catch(async (error: Error) => {
      const suggestion = error.message.match(
        /Unknown column \[COUNT\], did you mean \[(COUNT\(\*?\))\]/i
      );
      if (args.template !== 'custom' || !suggestion) throw error;
      // Repair only the exact aggregate column verified by Elasticsearch, never guessed fields.
      const corrected = pipeline.replace(
        /(\bSORT\s+)([^|]+)/gi,
        (statement, prefix: string, sorting: string) => {
          const expressions = sorting.split(',').map((expression) => {
            const value = expression.trim();
            return /^COUNT(?:\s+(?:ASC|DESC))?$/i.test(value)
              ? value.replace(/^COUNT/i, field(suggestion[1]))
              : value;
          });
          return `${prefix}${expressions.join(', ')} `;
        }
      );
      if (corrected === pipeline) throw error;
      pipeline = corrected;
      query = `${base}${time} | ${pipeline} | LIMIT ${limit}`;
      warnings.push(
        `SORT COUNT referenced no column; retried once using the verified aggregate column ${suggestion[1]}. Alias aggregates explicitly, for example count=COUNT(*) and SORT count DESC.`
      );
      return executeQuery(query);
    });
    if (
      args.template === 'custom' &&
      sourceIdentityColumns(columns).length &&
      !response.columns.some((column) => sourceIdentityColumns(columns).includes(column.name))
    ) {
      warnings.push(
        `Output omits the mapped emitting-service identity fields (${sourceIdentityColumns(
          columns
        ).join(
          ', '
        )}). If attribution matters, include them in KEEP or grouping before concluding that identity is missing. A source-wide aggregate may intentionally omit identity.`
      );
    }
    const rows = response.values.map((values) =>
      Object.fromEntries(
        response.columns.map((column, index) => [
          column.name,
          values[index] === null ? '' : String(values[index]),
        ])
      )
    );
    if (
      args.template !== 'custom' &&
      args.template !== 'relationships' &&
      args.template !== 'samples'
    )
      rows.sort((left, right) =>
        JSON.stringify(
          Object.fromEntries(Object.entries(left).filter(([name]) => name !== 'count'))
        ).localeCompare(
          JSON.stringify(
            Object.fromEntries(Object.entries(right).filter(([name]) => name !== 'count'))
          )
        )
      );
    const rowRefs = this.record(source.id, rows, query);
    if (
      args.template === 'custom' ||
      args.template === 'relationships' ||
      args.template === 'samples'
    ) {
      const page = rows.slice(offset, offset + args.maxRows);
      const candidates = page.flatMap((row, index) =>
        dependencyCandidates(row, this.observedEntities()).map((candidate) => ({
          ...candidate,
          evidenceRef: rowRefs[offset + index],
          suggestedId: normalizeFeatureSlug(
            `dependency-${candidate.sourceNamespace}-${candidate.source}-${candidate.targetNamespace}-${candidate.target}`
          ),
          properties: {
            source: candidate.source,
            target: candidate.target,
            source_namespace: candidate.sourceNamespace,
            target_namespace: candidate.targetNamespace,
            ...(candidate.protocol ? { protocol: candidate.protocol } : {}),
          },
        }))
      );
      const uniqueCandidates = new Map<string, (typeof candidates)[number]>();
      for (const candidate of candidates) {
        const key = JSON.stringify([
          candidate.source,
          candidate.sourceNamespace,
          candidate.target,
          candidate.targetNamespace,
        ]);
        const prior = uniqueCandidates.get(key);
        if (!prior || (!prior.protocol && candidate.protocol)) uniqueCandidates.set(key, candidate);
      }
      return {
        sourceId: source.id,
        query,
        ...(args.template === 'custom'
          ? { columns: response.columns, identityColumns: sourceIdentityColumns(columns) }
          : {}),
        rows:
          args.template === 'custom'
            ? response.values.slice(offset, offset + args.maxRows)
            : page.map((row, index) => ({
                service: rowIdentity(row),
                count: row.count,
                firstSeen: row.first_seen,
                lastSeen: row.last_seen,
                sampleSelection:
                  'Representative text, not necessarily the latest row; use firstSeen/lastSeen and time buckets for current state.',
                sample: row.sample.slice(0, 2000),
                ...((): { variants?: string[] } => {
                  const variants = [...new Set([row.sample_low, row.sample_any])].filter(
                    (value) => value && value !== row.sample
                  );
                  return variants.length
                    ? { variants: variants.map((value) => value.slice(0, 1000)) }
                    : {};
                })(),
                evidenceRef: rowRefs[offset + index],
                ...(row.sample.length > 2000 ? { sampleTruncated: true } : {}),
                ...(rowIdentity(row).name !== row['resource.attributes.service.name']
                  ? {
                      identityNote: 'Caller resolved from agreeing per-log Fluent tag and dataset.',
                      resourceServiceName: row['resource.attributes.service.name'],
                      fluentTag: row['attributes.fluent.tag'] || row['fluent.tag'],
                      dataset: row['data_stream.dataset'],
                    }
                  : {}),
              })),
        rowRefs: rowRefs.slice(offset, offset + args.maxRows),
        warnings,
        candidates: [...uniqueCandidates.values()],
        nextAction:
          args.template === 'relationships'
            ? 'Interpret the raw relationship rows yourself; candidates is an optional incomplete helper, not a prerequisite for writing a dependency. Inspect structured target fields and representative categories per service. A category groups messages whose variable parts differ: read sample AND variants, because different targets, endpoints or errors can share one category. If rows are empty, inspect schema/structured fields and widen a targeted historical query before concluding that relationships are unavailable. Persist supported findings with their evidenceRef and honest uncertainty.'
            : undefined,
        truncated: rows.length > offset + args.maxRows,
        hasMore: rows.length > offset + args.maxRows,
        nextOffset: rows.length > offset + args.maxRows ? offset + args.maxRows : null,
      };
    }
    const traced = createTracedEsClient({
      client: this.clients.streamDataEsClient,
      logger: this.server.logger,
      plugin: 'significant_events',
    });
    const messageFields = ['message', 'body.text', 'body'].filter((name) => columns.includes(name));
    const needsPatterns =
      messageFields.length > 0 && (args.template === 'novelty' || args.template === 'patterns');
    const patterns = needsPatterns
      ? this.patternInventories.get(inventoryKey) ??
        (await getSigEventsLogPatternsEsql({
          esClient: traced,
          samplingSource: source.view_name,
          start: now - (lookbackMinutes + endOffsetMinutes) * 60000,
          end: now - endOffsetMinutes * 60000,
          fields: messageFields,
        }))
      : [];
    if (needsPatterns) this.patternInventories.set(inventoryKey, patterns);
    patterns.sort((left, right) => left.pattern.localeCompare(right.pattern));
    const infrastructure =
      args.template === 'novelty'
        ? await this.infrastructureInventory(
            source,
            columns,
            undefined,
            lookbackMinutes,
            endOffsetMinutes
          )
        : undefined;
    const patternRefs = this.record(
      source.id,
      patterns.map((pattern) => ({ pattern: pattern.pattern, sample: pattern.sample ?? '' })),
      `CATEGORIZE patterns over ${lookbackMinutes} minutes ending ${endOffsetMinutes} minutes ago`
    );
    const identities = rows
      .map(({ count, ...identity }) => identity)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const patternId = (pattern: string) =>
      signature({
        pattern: pattern
          .toLowerCase()
          .replace(/\b[0-9]+\b/g, '#')
          .replace(/\s+/g, ' ')
          .trim(),
      });
    const snapshotKey = `${source.id}:${
      args.template === 'novelty'
        ? `novelty:${lookbackMinutes}:${endOffsetMinutes}`
        : args.checkpointKey ?? `${args.template}:${lookbackMinutes}:${endOffsetMinutes}`
    }`;
    const priorCheckpoint = this.checkpoints[snapshotKey];
    const knownPatterns = new Set(priorCheckpoint?.patternSignatures ?? []);
    const newPatterns = patterns.filter(
      (pattern) => !knownPatterns.has(patternId(pattern.pattern))
    );
    const factsSignature = signature({
      explorationContractVersion: 5,
      revision: source.esql_updated_at,
      columns,
      identities,
      infrastructure: infrastructure
        ? [
            ...new Set(
              infrastructure.rows.map(({ count, ...identity }) => {
                const resolved = rowIdentity(identity);
                const canonical = { ...identity };
                for (const identityField of [
                  'resource.attributes.service.name',
                  'service.name',
                  'service_name',
                ])
                  if (identityField in canonical) canonical[identityField] = resolved.name;
                return JSON.stringify(compactResourceRow(canonical));
              })
            ),
          ].sort()
        : undefined,
    });
    const factsChanged = priorCheckpoint?.factsSignature !== factsSignature;
    const patternSignatures = [
      ...new Set([...knownPatterns, ...patterns.map((pattern) => patternId(pattern.pattern))]),
    ]
      .slice(-500)
      .sort();
    const changed = factsChanged || newPatterns.length > 0;
    this.pendingCheckpoints[snapshotKey] = {
      signature: signature({ factsSignature, patternSignatures }),
      checkedAt: new Date().toISOString(),
      factsSignature,
      patternSignatures,
    };
    if (args.template === 'novelty') {
      this.pendingCheckpoints[`${source.id}:novelty`] = this.pendingCheckpoints[snapshotKey];
    }
    const visiblePatterns = args.template === 'novelty' && !factsChanged ? newPatterns : patterns;
    const truncated =
      rows.length > 500 || patterns.length >= 500 || Boolean(infrastructure?.truncated);
    if (args.template === 'novelty') {
      this.examined.add(source.id);
      if (truncated) this.unhealthy.add(source.id);
      else this.unhealthy.delete(source.id);
    }
    const compactIdentity = (row: Record<string, string>) => {
      const groups = [
        ['resource.attributes.service.name', 'service.name', 'service_name'],
        ['resource.attributes.service.namespace', 'service.namespace', 'namespace'],
        ['resource.attributes.service.version', 'service.version'],
        [
          'resource.attributes.deployment.environment.name',
          'deployment.environment.name',
          'deployment.environment',
        ],
        ['resource.attributes.k8s.namespace.name', 'kubernetes.namespace'],
      ];
      return Object.fromEntries(
        groups.flatMap((group) => {
          const name = group.find((key) => row[key]);
          return name ? [[name, row[name]]] : [];
        })
      );
    };
    const includeDetails = changed || args.template !== 'novelty';
    const detailCount =
      args.template === 'novelty' && !factsChanged
        ? visiblePatterns.length
        : Math.max(rows.length, visiblePatterns.length);
    const entityGaps: Array<{
      rowIndex: number;
      name: string;
      namespace: string;
      suggestedId: string;
      evidence: string[];
      evidenceRef: string;
    }> = [];
    if (args.template === 'novelty') {
      const client = await this.clients.getKnowledgeIndicatorClient();
      const { hits } = await client.getFeatures(source.id, { limit: 10000, includeExcluded: true });
      for (const [index, row] of rows.entries()) {
        const nameField = ['service.name', 'resource.attributes.service.name', 'service_name'].find(
          (key) => row[key]
        );
        const namespaceField = [
          'service.namespace',
          'resource.attributes.service.namespace',
          'namespace',
        ].find((key) => row[key]);
        if (!nameField) continue;
        const name = row[nameField];
        const namespace = namespaceField ? row[namespaceField] : '';
        const covered = hits.some(
          (feature) =>
            feature.type === 'entity' &&
            feature.subtype === 'service' &&
            (feature.properties.name ?? feature.properties.service_name) === name &&
            String(feature.properties.service_namespace ?? feature.properties.namespace ?? '') ===
              namespace
        );
        if (!covered)
          entityGaps.push({
            rowIndex: index,
            name,
            namespace,
            suggestedId: normalizeFeatureSlug(`service-${namespace}-${name}`),
            evidenceRef: rowRefs[index],
            evidence: [
              `${nameField}=${name}`,
              ...(namespaceField ? [`${namespaceField}=${namespace}`] : []),
            ],
          });
      }
      this.needsServiceEntities = this.needsServiceEntities || entityGaps.length > 0;
    }
    return {
      sourceId: source.id,
      changed,
      changeReasons: [
        ...(factsChanged ? ['source_facts'] : []),
        ...(newPatterns.length ? ['new_patterns'] : []),
      ],
      newPatternCount: newPatterns.length,
      coverageComplete: !truncated,
      query,
      services:
        includeDetails && (factsChanged || args.template !== 'novelty')
          ? rows.slice(args.offset, args.offset + args.maxRows).map((row, index) => ({
              ...compactIdentity(row),
              evidenceRef: rowRefs[args.offset + index],
            }))
          : [],
      entityGaps: entityGaps
        .filter(({ rowIndex }) => rowIndex >= args.offset && rowIndex < args.offset + args.maxRows)
        .slice(0, 25),
      entityGapCount: entityGaps.length,
      hasMore: args.offset + Math.min(args.maxRows, 8) < detailCount,
      nextOffset:
        args.offset + Math.min(args.maxRows, 8) < detailCount
          ? args.offset + Math.min(args.maxRows, 8)
          : null,
      nextAction: entityGaps.length
        ? 'Save all entityGaps before deeper exploration. Use suggestedId, properties.name and properties.service_namespace. Set evidence=[] and evidence_refs=[evidenceRef] to copy exact source evidence. Upsert at most 25 per call.'
        : undefined,
      serviceGroups: rows.length,
      patterns: includeDetails
        ? visiblePatterns
            .slice(args.offset, args.offset + Math.min(args.maxRows, 8))
            .map((pattern, index) => ({
              ...pattern,
              sample: pattern.sample?.slice(0, 600),
              pattern: pattern.pattern.slice(0, 600),
              evidenceRef: patternRefs[patterns.indexOf(visiblePatterns[args.offset + index])],
            }))
        : [],
      infrastructureGroups: infrastructure?.rows.length,
      infrastructureFields: infrastructure?.fields.filter((name) =>
        infrastructure.rows.some((row) => row[name])
      ),
      infrastructureSummary: infrastructure
        ? {
            totalGroups: infrastructure.rows.length,
            nonNullFields: infrastructure.fields.filter((name) =>
              infrastructure.rows.some((row) => row[name])
            ),
            nextAction: infrastructure.rows.length
              ? 'Infrastructure metadata is present. Use template=infrastructure without fieldSearch to inspect sparse resource rows. Empty Kubernetes subsets do not mean hosts/containers are absent.'
              : 'No non-null infrastructure metadata in this window.',
          }
        : undefined,
      patternGroups: patterns.length,
      detailsTruncated:
        includeDetails &&
        (rows.length > args.offset + args.maxRows ||
          visiblePatterns.length > args.offset + Math.min(args.maxRows, 8)),
      truncated,
      columns: includeDetails
        ? columns.filter(
            (name) =>
              identityFields.includes(name) ||
              ['@timestamp', 'message', 'body.text', 'body'].includes(name)
          )
        : [],
    };
  }

  private async knowledge(args: z.infer<typeof knowledgeSchema>): Promise<ToolResponseStructured> {
    const sourceIds = args.sourceId
      ? [this.source(args.sourceId).id]
      : this.sources.filter((source) => source.enabled).map((source) => source.id);
    const client = await this.clients.getKnowledgeIndicatorClient();
    if (args.action === 'index') {
      if (!sourceIds.length) return { total: 0, records: [], hasMore: false };
      const { hits } = await client.getFeatures(sourceIds, { limit: 10000, includeExcluded: true });
      const terms =
        args.query
          ?.toLowerCase()
          .split(/[\s|,]+/)
          .filter(Boolean) ?? [];
      const matching = hits.filter((feature) => {
        const text = `${feature.id} ${feature.title} ${JSON.stringify(
          feature.properties
        )}`.toLowerCase();
        return !terms.length || terms.some((term) => text.includes(term));
      });
      const linksBySource = await client.getSourceToQueryLinksMap(sourceIds, {
        includeExpired: true,
      });
      const queryLinks = Object.values(linksBySource).flat();
      const matchingQueries = queryLinks.filter(({ query: savedQuery }) => {
        const text =
          `${savedQuery.id} ${savedQuery.title} ${savedQuery.description} ${savedQuery.esql.query}`.toLowerCase();
        return !terms.length || terms.some((term) => text.includes(term));
      });
      return {
        total: matching.length,
        queryTotal: matchingQueries.length,
        queryHasMore: args.queryOffset + args.queryLimit < matchingQueries.length,
        queryNextOffset:
          args.queryOffset + args.queryLimit < matchingQueries.length
            ? args.queryOffset + args.queryLimit
            : null,
        queryRecords: matchingQueries
          .slice(args.queryOffset, args.queryOffset + args.queryLimit)
          .map((link) => ({
            id: link.query.id,
            sourceId: link.source_id,
            type: 'query',
            title: link.query.title,
            description: link.query.description,
            queryType: link.query.type,
            ruleBacked: link.rule_backed,
            severityScore: link.query.severity_score,
            esql: link.query.esql.query.slice(0, 2000),
            featureIds: link.query.features?.map(({ id }) => id) ?? [],
          })),
        ...(args.offset === 0 && !args.query
          ? {
              namespaceInventory: summarizeNamespaceInventory(hits),
              inventoryNote:
                'Stored KI inventory only, deduplicated across signal sources. Zero relationships means investigate, not that real dependencies are absent. Source-wide contracts may apply beyond their stored namespace metadata.',
            }
          : {}),
        hasMore: args.offset + args.limit < matching.length,
        offset: args.offset,
        effectiveLimit: args.limit,
        nextOffset: args.offset + args.limit < matching.length ? args.offset + args.limit : null,
        records: matching.slice(args.offset, args.offset + args.limit).map((feature) => ({
          id: feature.id,
          sourceId: feature.source_id,
          type: feature.type,
          title: feature.title,
          confidence: feature.confidence,
          excluded: feature.excluded,
          name: feature.properties.name,
          namespace: feature.properties.service_namespace ?? feature.properties.namespace,
        })),
      };
    }
    if (args.action === 'read') {
      if (!args.ids?.length)
        throw new Error(
          'Read requires specific KI IDs; call action=index first to list IDs, then read selected ones'
        );
      const { hits } = await client.getFeatures(sourceIds, {
        featureIds: args.ids,
        includeExcluded: true,
        limit: 25,
      });
      const selected = hits.slice(args.offset, args.offset + Math.min(args.limit, 5));
      const linksBySource = await client.getSourceToQueryLinksMap(sourceIds, {
        includeExpired: true,
      });
      const matchingQueries = Object.values(linksBySource)
        .flat()
        .filter((link) => args.ids?.includes(link.query.id));
      const selectedQueries = matchingQueries.slice(
        args.offset,
        args.offset + Math.min(args.limit, 5)
      );
      const details = selected.map((feature) =>
        args.includeProvenance
          ? feature
          : {
              ...feature,
              evidence: (feature.evidence ?? []).slice(0, 3),
              evidence_doc_ids: (feature.evidence_doc_ids ?? []).slice(0, 3),
              meta: Object.fromEntries(
                Object.entries(feature.meta ?? {}).filter(
                  ([key]) => !key.startsWith('exploration_')
                )
              ),
              evidenceOmitted: Math.max(0, (feature.evidence?.length ?? 0) - 3),
              provenanceAvailable: true,
            }
      );
      while (details.length > 1 && JSON.stringify(details).length > 10000) details.pop();
      return {
        features: details,
        total: hits.length,
        hasMore: args.offset + details.length < hits.length,
        nextOffset: args.offset + details.length,
        queries: selectedQueries.map((link) => ({
          ...link,
          query: {
            ...link.query,
            evidence: (link.query.evidence ?? []).slice(0, 3),
            evidenceOmitted: Math.max(0, (link.query.evidence?.length ?? 0) - 3),
          },
        })),
        queryTotal: matchingQueries.length,
        queryHasMore: args.offset + selectedQueries.length < matchingQueries.length,
        queryNextOffset: args.offset + selectedQueries.length,
      };
    }
    if (!args.sourceId && sourceIds.length === 1) args.sourceId = sourceIds[0];
    if (!args.sourceId)
      throw new Error('Upsert requires sourceId when several sources are enabled');
    let queryInputs: Array<z.infer<typeof queryKiInputSchema>> = [];
    if (args.queriesJson?.trim()) {
      try {
        queryInputs = z.array(queryKiInputSchema).max(25).parse(JSON.parse(args.queriesJson));
      } catch (error) {
        throw new Error(
          `queriesJson must be a JSON array of at most 25 source-scoped query KIs: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    if (!args.features?.length && !queryInputs.length)
      throw new Error('Upsert requires features or queriesJson');
    const source = this.source(args.sourceId);
    const validatedQueries: StreamQuery[] = queryInputs.map((input) => {
      validateEsqlQueryForSourceOrThrow({
        esqlQuery: input.esql.query,
        viewName: source.view_name,
      });
      const type = deriveQueryType(input.esql.query);
      if (type !== 'stats')
        throw new Error(
          'Knowledge extraction query KIs must be stats queries; match queries can create managed rules.'
        );
      return { ...input, type };
    });
    const { hits: existing } = await client.getFeatures(args.sourceId, {
      limit: 10000,
      includeExcluded: true,
    });
    const validated: BaseFeature[] = [];
    const warnings: Array<{ id: string; ignoredEvidenceRefs: string[]; message: string }> = [];
    const unchanged: Array<{ id: string; type: string }> = [];
    const rejected: Array<{
      id: string;
      reason: string;
      evidence: Array<{ ref: string; actor: string; excerpt: string }>;
    }> = [];
    for (const input of args.features ?? []) {
      const { evidence_refs: evidenceRefs, ...feature } = input;
      feature.properties = Object.fromEntries(
        Object.entries(feature.properties).filter(
          ([, value]) =>
            value !== '' && value != null && (!Array.isArray(value) || value.length > 0)
        )
      );
      const referenced = (evidenceRefs ?? []).map((id) => this.references.get(id));
      const validEvidenceRefs = (evidenceRefs ?? []).filter(
        (id, index) => referenced[index]?.sourceId === args.sourceId
      );
      const ignoredEvidenceRefs = (evidenceRefs ?? []).filter(
        (id) => !validEvidenceRefs.includes(id)
      );
      if (ignoredEvidenceRefs.length)
        warnings.push({
          id: feature.id,
          ignoredEvidenceRefs,
          message:
            'These references are unknown or belong to another source. The KI is still saved, but these references are not copied. Check source ownership and save contracts for different sources in separate calls.',
        });
      const validReferenced = validEvidenceRefs
        .map((id) => this.references.get(id))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
      if (validReferenced.length) {
        const copied = validReferenced.flatMap((entry) => {
          if (!entry) return [];
          const row = entry.row;
          const actor = [
            'resource.attributes.service.name',
            'service.name',
            'service_name',
            'attributes.fluent.tag',
            'fluent.tag',
          ].find((key) => row[key] && row[key] === rowIdentity(row).name);
          const namespace = [
            'service.namespace',
            'resource.attributes.service.namespace',
            'namespace',
          ].find((key) => row[key]);
          const text = ['message', 'body.text', 'body', 'sample', 'pattern', 'kibana_result'].find(
            (key) => row[key]
          );
          const attributes = Object.entries(row).filter(
            ([key, value]) =>
              value &&
              key !== 'count' &&
              key !== actor &&
              key !== namespace &&
              key !== text &&
              (feature.type === 'infrastructure'
                ? infrastructureField(key)
                : feature.type === 'technology' ||
                  (feature.type === 'schema' && key.startsWith('schema_')))
          );
          const propertyValues = new Set(
            Object.values(feature.properties).flatMap((value) =>
              typeof value === 'string'
                ? [value]
                : Array.isArray(value)
                ? value.filter((item): item is string => typeof item === 'string')
                : []
            )
          );
          const score = ([key, value]: [string, string]): number => {
            if (!propertyValues.has(value)) return 0;
            const resource = feature.subtype?.replace(/^kubernetes_/, '');
            return (
              1 +
              (resource && key.includes(resource) ? 2 : 0) +
              (/(^|\.)(uid|id)$/.test(key) ? 1 : 0)
            );
          };
          attributes.sort((left, right) => score(right) - score(left));
          return [
            ...(actor ? [`${actor}=${row[actor]}`] : []),
            ...(namespace ? [`${namespace}=${row[namespace]}`] : []),
            ...attributes.map(([key, value]) => `${key}=${value}`),
            ...(text ? [row[text].slice(0, 2000)] : []),
          ];
        });
        feature.evidence = [...new Set(copied)].slice(0, 5);
      }
      const proposedId = normalizeFeatureSlug(feature.id);
      const sameIdentity = (item: BaseFeature): boolean => {
        if (
          item.type !== feature.type ||
          (!['dependency', 'infrastructure'].includes(feature.type) &&
            item.subtype !== feature.subtype)
        )
          return false;
        const resourceKey =
          feature.type === 'infrastructure'
            ? ['container_id', 'host_id', 'pod_uid'].find((key) => feature.properties[key])
            : undefined;
        const fields =
          feature.type === 'dependency'
            ? ['source', 'target', 'source_namespace', 'target_namespace', 'protocol']
            : feature.type === 'entity'
            ? ['name', 'service_namespace']
            : resourceKey
            ? [resourceKey]
            : undefined;
        return Boolean(
          fields &&
            fields.every((key) =>
              key === 'protocol' && (!item.properties.protocol || !feature.properties.protocol)
                ? true
                : String(item.properties[key] ?? '') === String(feature.properties[key] ?? '')
            )
        );
      };
      const prior = [...validated, ...existing].find(
        (item) =>
          normalizeFeatureSlug(item.id) === proposedId ||
          sameIdentity(item) ||
          (Object.keys(feature.properties).length > 0 && hasSameFingerprint(item, feature))
      );
      const id = prior?.id ?? proposedId;
      const reason =
        prior && prior.type !== feature.type
          ? 'This KI ID already belongs to another type; choose a distinct stable ID.'
          : undefined;
      if (reason) {
        rejected.push({
          id,
          reason,
          evidence: (evidenceRefs ?? []).slice(0, 3).map((ref) => {
            const row = this.references.get(ref)?.row ?? {};
            return {
              ref,
              actor:
                row['service.name'] ||
                row['resource.attributes.service.name'] ||
                row.service_name ||
                '',
              excerpt: (row.message || row['body.text'] || row.body || row.sample || '').slice(
                0,
                500
              ),
            };
          }),
        });
        continue;
      }
      const candidate = {
        ...feature,
        ...(prior && ['dependency', 'infrastructure'].includes(feature.type)
          ? { subtype: prior.subtype }
          : {}),
        id,
        evidence: feature.evidence.slice(0, 5),
        meta: {
          ...feature.meta,
          exploration_run_id: this.run.id,
          ...(validEvidenceRefs.length ? { exploration_evidence_refs: validEvidenceRefs } : {}),
          exploration_queries: [...(this.evidenceQueries.get(args.sourceId) ?? [])].slice(-8),
        },
      };
      if (
        prior?.properties.protocol &&
        !candidate.properties.protocol &&
        candidate.type === 'dependency'
      )
        candidate.properties.protocol = prior.properties.protocol;
      const merged = prior ? mergeFeature(prior, candidate) : candidate;
      if (prior && hasSameFingerprint(prior, merged)) {
        unchanged.push({ id: prior.id, type: prior.type });
        continue;
      }
      const position = validated.findIndex((item) => item.id === id);
      if (position >= 0) validated[position] = merged;
      else validated.push(merged);
    }
    if (validated.length) {
      const scopedClient = await this.clients.getKnowledgeIndicatorClient(source);
      await scopedClient.bulk(
        source.id,
        validated.map((feature) => ({
          index: {
            feature: {
              ...feature,
              run_id: this.run.id,
              expires_at: scopedClient.getDefaultExpiresAt(),
            },
          },
        }))
      );
      this.run.written += validated.length;
      if (validated.some((feature) => feature.type === 'entity' && feature.subtype === 'service'))
        this.needsServiceEntities = false;
    }
    const scopedClient = await this.clients.getKnowledgeIndicatorClient(source);
    for (const query of validatedQueries) await scopedClient.upsertQuery(source.id, query);
    this.run.written += validatedQueries.length;
    const followUp = followUpForSavedFeatures(validated);
    return {
      ...(followUp ? { followUp } : {}),
      sourceId: args.sourceId,
      saved: validated.map((feature) => ({ id: feature.id, type: feature.type })),
      savedQueries: validatedQueries.map(({ id, title }) => ({
        id,
        title,
        type: 'stats',
        ruleBacked: false,
      })),
      unchanged,
      rejected,
      ...(warnings.length ? { warnings } : {}),
      ...(rejected.length
        ? {
            nextAction:
              'Saved records are already persisted; do not resend them. The only KI upsert rejection is an ID collision with a different KI type. Correct the ID and retry that record.',
          }
        : {}),
    };
  }
}
