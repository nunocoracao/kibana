/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { NightshiftSource } from '@kbn/nightshift-shared';
import type {
  ExplorationSamplingAttempt,
  ExplorationStep,
  ExplorerAgent,
} from '../../../common/knowledge_exploration';

const TIME_STRATA_MINUTES = [0, 60, 360, 720, 1440] as const;
const MAX_PLANNED_SOURCES = 8;
const MAX_RETAINED_SAMPLING_ATTEMPTS = 64;

export interface SamplingAgenda {
  agent: ExplorerAgent;
  instruction: string;
  sources: Array<{
    sourceId: string;
    title: string;
    type: NightshiftSource['type'];
    volumeProbeMinutes?: number;
    targetWindowMinutes: number;
    endOffsetMinutes: number;
    focus: string;
  }>;
}

const samplingFocus = (agent: ExplorerAgent, type: NightshiftSource['type']): string => {
  if (agent === 'knowledge') {
    if (type === 'logs')
      return 'identify emitters and inspect directed dependency evidence, including body and structured peer fields';
    if (type === 'traces')
      return 'inspect client/server span roles, peer identities, status and duration for dependency edges';
    if (type === 'metrics')
      return 'profile populated instruments by emitter, then retain actual units, types and service/namespace identity';
    return 'inspect mapped and populated fields before choosing a focused query';
  }
  if (agent === 'monitoring') {
    if (type === 'logs')
      return 'compare grouped operation outcomes, technical failures, latency and observed queue or retry signals';
    if (type === 'traces')
      return 'compare server outcomes with client dependency latency and failures by actual peer';
    if (type === 'metrics')
      return 'inspect populated gauges and units for uncovered services; do not treat cumulative counters as rates';
    return 'inspect the populated schema and identify a distinct, source-grounded monitoring concern';
  }
  return 'investigate only source scopes implicated by recent rule signals, using current evidence';
};

/** Builds a small, deterministic source/time agenda from recent runs so loops rotate instead of repeating hot windows. */
export const buildSamplingAgenda = (
  agent: ExplorerAgent,
  sources: NightshiftSource[],
  attempts: ExplorationSamplingAttempt[],
  prioritySourceId?: string,
  unfinishedExploration: string[] = []
): SamplingAgenda => {
  if (agent === 'events') {
    return {
      agent,
      instruction:
        'Signal-driven: inspect recent rule firings first. Query only implicated sources, starting with a 2–3 minute current window; use older windows only for a specific before/current comparison.',
      sources: [],
    };
  }

  const enabled = sources.filter((source) => source.enabled);
  const attemptedCounts = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.agent && attempt.agent !== agent) continue;
    for (const sourceId of attempt.sourceIds)
      attemptedCounts.set(sourceId, (attemptedCounts.get(sourceId) ?? 0) + 1);
  }
  const focusOrder: Record<NightshiftSource['type'], number> =
    agent === 'knowledge'
      ? { logs: 0, traces: 1, metrics: 2, unknown: 3 }
      : { logs: 0, metrics: 1, traces: 2, unknown: 3 };
  const hasOutstandingGap = (source: NightshiftSource): boolean =>
    unfinishedExploration.some((gap) =>
      [source.id, source.slug, source.title].some(
        (identity) =>
          typeof identity === 'string' && gap.toLowerCase().includes(identity.toLowerCase())
      )
    );
  const planned = [...enabled]
    .sort((left, right) => {
      if (left.id === prioritySourceId) return -1;
      if (right.id === prioritySourceId) return 1;
      if (hasOutstandingGap(left) !== hasOutstandingGap(right))
        return hasOutstandingGap(left) ? -1 : 1;
      return (
        (attemptedCounts.get(left.id) ?? 0) - (attemptedCounts.get(right.id) ?? 0) ||
        focusOrder[left.type] - focusOrder[right.type] ||
        left.id.localeCompare(right.id)
      );
    })
    .slice(0, MAX_PLANNED_SOURCES)
    .map((source) => {
      const sourceAttempts = attempts.filter(
        (attempt) =>
          (!attempt.agent || attempt.agent === agent) && attempt.sourceIds.includes(source.id)
      );
      const offsetCounts = new Map<number, number>();
      for (const offset of TIME_STRATA_MINUTES) offsetCounts.set(offset, 0);
      for (const attempt of sourceAttempts) {
        const offset = attempt.endOffsetMinutes;
        if (offsetCounts.has(offset)) offsetCounts.set(offset, (offsetCounts.get(offset) ?? 0) + 1);
      }
      const endOffsetMinutes = [...TIME_STRATA_MINUTES].sort(
        (left, right) =>
          (offsetCounts.get(left) ?? 0) - (offsetCounts.get(right) ?? 0) || left - right
      )[0];
      const hasCurrentVolumeProbe = sourceAttempts.some(
        (attempt) => attempt.template === 'volume' && attempt.endOffsetMinutes === 0
      );
      return {
        sourceId: source.id,
        title: source.title,
        type: source.type,
        ...(hasCurrentVolumeProbe ? {} : { volumeProbeMinutes: 1 }),
        targetWindowMinutes: 5,
        endOffsetMinutes,
        focus: samplingFocus(agent, source.type),
      };
    });

  return {
    agent,
    instruction:
      'Use this deterministic priority list to choose the next bounded reads. Probe volume for one minute before a broad read, then target the listed five-minute time stratum and source-specific question. Complete useful unvisited scopes first; explain any deviation. A probe or a sampled interval is not proof of complete coverage.',
    sources: planned,
  };
};

export const SAMPLING_STRATEGY = `
ADAPTIVE SAMPLING SHARED BY ALL AGENTS
Treat every read as answering a concrete question, not completing a ritual template sequence. For each configured source, use a deliberately short volume probe (for example one minute). A capped probe gives a lower bound, not a measured throughput rate or permission to scan a larger period. Shrink a capped/slow window and/or scope service, namespace, operation and fields before expensive work. Do not follow a capped probe with an unfiltered one/two-hour infrastructure or categorization scan. Volume is source-wide, so a small service-specific read may still be cheap; test it rather than extrapolating a source-wide count.
Follow the deterministic sampling agenda in the run context: it rotates the least-sampled enabled sources and time strata, with a task matched to logs, traces or metrics. Finish useful unvisited agenda items before repeating a hot source; explain any deviation. Build a small source/namespace/service/telemetry matrix, not a single first page. Use compact inventories for breadth, then rotate short targeted intervals across recent and earlier hours with endOffsetMinutes for discovery or historical baselines. Do not repeatedly sample the same hour, hottest emitter or first rows. A recent incident needs current evidence independently of historical learning. Distributed exploratory samples are not complete histories or exact baseline denominators.
For a field/instrument, check that it is populated IN THE REQUESTED SCOPE before interpreting it. template=profile counts non-null observations for a focused fieldSearch subset. Use WHERE actual_field IS NOT NULL before KEEP/LIMIT when asking for value examples. Metrics may be sparse/wide: fifteen arbitrary metric rows with null checkout fields may simply be other instruments, not evidence that checkout metrics are unavailable. Inspect the populated instrument's own emitting service/namespace, units and type. Retain the actual identityColumns returned by schema/profile in KEEP or grouping. Do not substitute attributes.service.name for service.name/resource.attributes.service.name or invent attributes.service.namespace; an optional attribute being null does not mean the emitter identity is absent. Never invent metric.type/metrics.name/metrics.value from convention; use mapped fields. Inspect message AND body.text for mixed log formats; filter named target/peer/span fields to non-null and enumerate their distinct values to investigate directed relationships. CATEGORIZE examples alone may hide targets. When a namespace page is dominated by cart operations or broker maintenance, do not repeat the same top-frequency page in another hour: select a different observed service, profile named target/peer fields, inspect lower-frequency categories or request explicit endpoint-bearing records. Absence in the hottest few categories is not evidence of absent dependencies. If targeted log/metric evidence cannot resolve a relationship, inspect the existing kibana_information read-only catalog for topology/dependency/APM tools, describe their inputs and use a bounded scope matching source-observed service identities. Do not import unrelated service maps or guess links from names.
Use fieldSearch to split infrastructure by pods/nodes, hosts/IPs or containers/cloud and apply service/namespace scope. Keep extraction and placement uncertainty separate: observed resources can be saved without claiming application placement. Save supported findings and pursue independently observable monitoring concerns while another source/anchor is blocked.
Read previousSamplingAttempts and unfinishedExploration. Change a failed or uninformative strategy: a smaller/different time slice, different emitter, actual populated field, alternate body format or appropriate read-only Kibana tool. An identical historical query against null fields is not progress. Schema/profile offsets are relative to the SAME fieldSearch/scope. Reset offset=0 when changing filters; an out-of-range page does not mean no matching fields. After syntax errors correct the observed schema issue before retrying. Report exactly what remains unobservable versus untried; stop repeating a blocked branch while other useful questions remain.
`;

export const summarizeSamplingAttempts = (
  steps: ExplorationStep[],
  agent: ExplorerAgent
): ExplorationSamplingAttempt[] =>
  steps
    .filter((step) => step.kind === 'tool' && step.name === 'source_esql')
    .slice(-8)
    .flatMap((step) => {
      try {
        const input = JSON.parse(step.input);
        const output = JSON.parse(step.output);
        return [
          {
            attemptId: step.id,
            agent,
            startedAt: step.startedAt,
            template: String(input.template ?? ''),
            sourceIds: Array.isArray(input.sourceIds)
              ? input.sourceIds.slice(0, 10).map(String)
              : [],
            lookbackMinutes: Number(input.lookbackMinutes),
            endOffsetMinutes: Number(input.endOffsetMinutes ?? 0),
            namespace: String(input.serviceNamespace ?? '').slice(0, 255),
            services: Array.isArray(input.serviceNames)
              ? input.serviceNames.slice(0, 10).map(String)
              : [],
            fieldSearch: String(input.fieldSearch ?? '').slice(0, 200),
            pipeline: String(input.pipeline ?? '').slice(0, 500),
            durationMs: step.durationMs,
            status: step.status,
            results: (Array.isArray(output.results) ? output.results : [])
              .slice(0, 10)
              .map((result: Record<string, unknown>) => ({
                sourceId: String(result.sourceId ?? ''),
                error: typeof result.error === 'string' ? result.error.slice(0, 300) : undefined,
                documents: typeof result.documents === 'number' ? result.documents : undefined,
                countRelation:
                  typeof result.countRelation === 'string' ? result.countRelation : undefined,
                rowsReturned: Array.isArray(result.rows) ? result.rows.length : undefined,
                truncated: result.truncated === true,
              })),
          },
        ];
      } catch {
        return [];
      }
    })
    .slice(-MAX_RETAINED_SAMPLING_ATTEMPTS);

export const mergeSamplingAttempts = (
  previous: ExplorationSamplingAttempt[],
  current: ExplorationSamplingAttempt[]
): ExplorationSamplingAttempt[] => {
  const attemptsById = new Map<string, ExplorationSamplingAttempt>();
  for (const attempt of [...previous, ...current]) {
    const key = attempt.attemptId ?? JSON.stringify(attempt);
    attemptsById.set(key, attempt);
  }
  return [...attemptsById.values()]
    .sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''))
    .slice(-MAX_RETAINED_SAMPLING_ATTEMPTS);
};
