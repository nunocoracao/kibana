/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Feature } from '@kbn/significant-events-schema';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import type { ExplorationRun, ExplorationState } from '../../../common/knowledge_exploration';
import {
  emptyExplorationTokens,
  selectExplorationLimits,
} from '../../../common/knowledge_exploration';
import type { RouteHandlerScopedClients } from '../../routes/types';
import {
  assessDetectionLearningFocus,
  carryForwardDetectionLearning,
  loadDetectionLearnings,
} from './learning_context';

it('loads native lessons without history, respecting disabled sources, exclusions and expiry', async () => {
  const lesson: Feature = {
    id: 'learning-api-503',
    uuid: 'stored-lesson',
    source_id: 'source',
    type: 'schema',
    subtype: 'custom',
    description: 'Verify successful requests before closing a 503 incident',
    confidence: 95,
    properties: {
      kind: 'detection_learning',
      recovery: 'Successful requests and no current server failures',
    },
  };
  const clients = {
    getKnowledgeIndicatorClient: async () => ({
      getFeatures: async () => ({
        hits: [
          lesson,
          { ...lesson, id: 'disabled', source_id: 'disabled' },
          { ...lesson, id: 'excluded', excluded: true },
          { ...lesson, id: 'expired', expires_at: '2000-01-01T00:00:00Z' },
          { ...lesson, id: 'ordinary-schema', properties: { kind: 'log_format' } },
        ],
      }),
    }),
  } as unknown as RouteHandlerScopedClients;
  const context = await loadDetectionLearnings(clients, [
    { id: 'source', enabled: true } as NightshiftSource,
    { id: 'disabled', enabled: false } as NightshiftSource,
  ]);
  expect(context.lessons).toMatchObject([
    { id: 'learning-api-503', description: lesson.description },
  ]);
  expect(context.lessons).toHaveLength(1);
  expect(context.lessons[0].propertiesJson).toContain('Successful requests');
});

it('preserves explicit knowledge gaps after complete coverage, and carries bounded tool feedback into later runs', () => {
  let state: ExplorationState = {
    checkpoints: {},
    totalCostUsd: 0,
    totalRuns: 0,
    totalTokens: emptyExplorationTokens(),
  };
  const run = {
    id: 'healthy',
    status: 'completed',
    summary: 'Current operations are healthy',
    written: 0,
    coverageComplete: true,
    remainingGaps: ['Confirm the new emitter’s database dependency'],
    startedAt: '2026-11-20T10:00:00Z',
    finishedAt: '2026-11-20T10:01:00Z',
    estimatedCostUsd: 0.01,
    steps: [
      {
        kind: 'tool',
        name: 'knowledge_indicators',
        status: 'failed',
        input: '{"featuresJson":"mixed feature/query batch"}',
        output: 'A query is not a feature',
      },
    ],
  } as ExplorationRun;
  state = { ...state, ...carryForwardDetectionLearning(state, run) };
  expect(state.remainingGaps).toEqual(['Confirm the new emitter’s database dependency']);
  expect(state.recentRunFeedback?.[0].toolFailures[0].error).toBe('A query is not a feature');
  for (let index = 0; index < 4; index++)
    state = {
      ...state,
      ...carryForwardDetectionLearning(state, { ...run, id: `later-${index}`, remainingGaps: [] }),
    };
  expect(state.remainingGaps).toEqual([]);
  expect(state.recentRunFeedback).toHaveLength(3);
});

it('keeps learning until saved foundations exist and returns to learning for a new uncovered service or source', () => {
  const source = { id: 'logs', enabled: true } as NightshiftSource;
  const entity = {
    id: 'api',
    source_id: 'logs',
    type: 'entity',
    subtype: 'service',
    properties: { name: 'api', service_namespace: 'prod' },
  };
  const schema = {
    id: 'format',
    source_id: 'logs',
    type: 'schema',
    subtype: 'custom',
    properties: {},
  };
  expect(assessDetectionLearningFocus([source], [], []).mode).toBe('initial_learning');
  expect(assessDetectionLearningFocus([source], [entity, schema], []).mode).toBe(
    'initial_learning'
  );
  const monitor = { source_id: 'logs', rule_backed: true, query: { features: [{ id: 'api' }] } };
  expect(assessDetectionLearningFocus([source], [entity, schema], [monitor]).mode).toBe(
    'incremental'
  );
  const unfamiliar = {
    ...entity,
    id: 'new-worker',
    properties: { name: 'worker', service_namespace: 'new' },
  };
  const changed = assessDetectionLearningFocus([source], [entity, schema, unfamiliar], [monitor]);
  expect(changed.mode).toBe('initial_learning');
  expect(changed.sources[0].missingFoundations.join(' ')).toContain('new/worker');
  const added = assessDetectionLearningFocus(
    [source, { id: 'metrics', enabled: true } as NightshiftSource],
    [entity, schema],
    [monitor]
  );
  expect(added.sources.map((scope) => scope.focus)).toEqual([
    'operate_and_improve',
    'learn_system',
  ]);
});

it('removes ceilings only for explicitly marked evaluation runs', () => {
  const evaluation = selectExplorationLimits('initial_learning', true);
  const ordinary = selectExplorationLimits('initial_learning');
  expect(evaluation.maxDurationMinutes).toBeNull();
  expect(evaluation.maxEstimatedCostUsd).toBeNull();
  expect(ordinary.maxDurationMinutes).not.toBeNull();
  expect(ordinary.maxEstimatedCostUsd).not.toBeNull();
});
