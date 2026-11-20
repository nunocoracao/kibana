/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { NightshiftSource } from '@kbn/nightshift-shared';
import type { Feature } from '@kbn/significant-events-schema';
import type {
  DetectionLearningFocus,
  ExplorationRun,
  ExplorationState,
} from '../../../common/knowledge_exploration';
import type { RouteHandlerScopedClients } from '../../routes/types';

/** Selects bounded, applicable native learning KIs without retaining excluded or stale knowledge. */
export const summarizeDetectionLearnings = (features: Feature[], sourceIds: string[]) => {
  const applicable = features
    .filter(
      (feature) =>
        sourceIds.includes(feature.source_id) &&
        !feature.excluded &&
        (!feature.expires_at || Date.parse(feature.expires_at) > Date.now()) &&
        feature.type === 'schema' &&
        feature.properties.kind === 'detection_learning'
    )
    .sort((left, right) => (right.updated_at ?? '').localeCompare(left.updated_at ?? ''));
  const lessons = applicable.slice(0, 8).map((feature) => ({
    id: feature.id,
    sourceId: feature.source_id,
    title: feature.title,
    description: feature.description.slice(0, 700),
    propertiesJson: JSON.stringify(feature.properties).slice(0, 2200),
    confidence: feature.confidence,
  }));
  while (lessons.length > 1 && JSON.stringify(lessons).length > 12000) lessons.pop();
  return { lessons, available: applicable.length, hasMore: applicable.length > lessons.length };
};

/** Loads learned strategies from the normal KI store, independently of resettable run history. */
export const loadDetectionLearnings = async (
  clients: RouteHandlerScopedClients,
  sources: NightshiftSource[]
) => {
  const sourceIds = sources.filter((source) => source.enabled).map((source) => source.id);
  if (!sourceIds.length) return { lessons: [], available: 0, hasMore: false };
  const client = await clients.getKnowledgeIndicatorClient();
  const { hits } = await client.getFeatures(sourceIds, { type: ['schema'], limit: 1000 });
  const context = summarizeDetectionLearnings(hits, sourceIds);
  return { ...context, hasMore: context.hasMore || hits.length === 1000 };
};

/** Retains useful gaps and recent execution feedback even after a successful current-health check. */
export const carryForwardDetectionLearning = (state: ExplorationState, run: ExplorationRun) => ({
  remainingGaps:
    run.remainingGaps?.slice(0, 20) ??
    (run.coverageComplete
      ? []
      : [
          `Previous run was incomplete: ${run.summary.slice(
            0,
            450
          )}. Recheck unfinished assessments and source coverage.`,
        ]),
  recentRunFeedback: [
    {
      runId: run.id,
      status: run.status,
      summary: run.summary.slice(0, 1200),
      written: run.written,
      durationMs: Math.max(
        0,
        Date.parse(run.finishedAt ?? run.startedAt) - Date.parse(run.startedAt)
      ),
      estimatedCostUsd: run.estimatedCostUsd,
      sourceReadCalls: run.steps.filter((step) => step.name === 'source_esql').length,
      toolFailures: run.steps
        .filter((step) => step.kind === 'tool' && step.status === 'failed')
        .slice(-2)
        .map((step) => ({
          tool: step.name,
          input: step.input.slice(0, 700),
          error: step.output.slice(0, 500),
        })),
    },
    ...(state.recentRunFeedback ?? []).filter((feedback) => feedback.runId !== run.id),
  ].slice(0, 3),
});

/** Allocates learning effort from saved source knowledge/measurements instead of resettable run counts. */
export const assessDetectionLearningFocus = (
  sources: NightshiftSource[],
  features: Array<Pick<Feature, 'source_id' | 'type' | 'subtype' | 'id' | 'properties'>>,
  queries: Array<{
    source_id: string;
    rule_backed?: boolean;
    query?: { features?: Array<{ id: string }> };
  }>
): DetectionLearningFocus => {
  const priorities = sources
    .filter((source) => source.enabled)
    .map((source) => {
      const known = features.filter(
        (feature) =>
          feature.source_id === source.id && feature.properties.kind !== 'detection_learning'
      );
      const measurements = queries.filter((query) => query.source_id === source.id);
      const coveredIds = new Set(
        measurements
          .filter((query) => query.rule_backed)
          .flatMap((query) => query.query?.features?.map((feature) => feature.id) ?? [])
      );
      const uncoveredServices = known.filter(
        (feature) =>
          feature.type === 'entity' && feature.subtype === 'service' && !coveredIds.has(feature.id)
      );
      const missingFoundations = [
        ...(!known.some((feature) =>
          ['entity', 'dependency', 'infrastructure'].includes(feature.type)
        )
          ? ['Observed entities and system relationships']
          : []),
        ...(!known.some((feature) => feature.type === 'schema')
          ? ['Payload and operation-outcome understanding']
          : []),
        ...(!measurements.length ? ['Validated reusable measurements'] : []),
        ...(!measurements.some((query) => query.rule_backed)
          ? ['Useful native monitoring or a concrete coverage assessment']
          : []),
        ...(uncoveredServices.length
          ? [
              `Evaluate useful existing/native coverage for ${
                uncoveredServices.length
              } known services without linked monitors: ${uncoveredServices
                .slice(0, 10)
                .map(
                  (feature) =>
                    `${feature.properties.service_namespace ?? 'unknown'}/${
                      feature.properties.name ?? feature.id
                    }`
                )
                .join(', ')}. This is an inventory gap, not a rule-count target.`,
            ]
          : []),
      ];
      return {
        sourceId: source.id,
        focus: missingFoundations.length
          ? ('learn_system' as const)
          : ('operate_and_improve' as const),
        missingFoundations,
      };
    });
  return {
    mode: priorities.some((source) => source.focus === 'learn_system')
      ? 'initial_learning'
      : 'incremental',
    sources: priorities,
    note: 'Saved artifacts indicate a minimum foundation, not complete understanding or verified live coverage. Review active problems first. Learn the observed system and useful monitoring where foundations are missing; otherwise prioritize current problem/lifecycle checks and focused learning when new evidence appears. Never create a rule only to change modes.',
  };
};

export const loadDetectionLearningFocus = async (
  clients: RouteHandlerScopedClients,
  sources: NightshiftSource[]
) => {
  const sourceIds = sources.filter((source) => source.enabled).map((source) => source.id);
  const client = await clients.getKnowledgeIndicatorClient();
  const [features, queries] = await Promise.all([
    client.getFeatures(sourceIds, { limit: 10000 }),
    client.getSourceToQueryLinksMap(sourceIds),
  ]);
  return assessDetectionLearningFocus(sources, features.hits, Object.values(queries).flat());
};
