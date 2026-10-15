/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import { NIGHTSHIFT_API_PRIVILEGES } from '@kbn/nightshift-shared';
import { isTerminalStatus, NonTerminalExecutionStatuses } from '@kbn/workflows';
import {
  SIGNIFICANT_EVENTS_DETECTION_WORKFLOW_ID,
  SIGNIFICANT_EVENTS_DISCOVERY_WORKFLOW_ID,
  SIGNIFICANT_EVENTS_ORCHESTRATOR_WORKFLOW_ID,
  SIGNIFICANT_EVENTS_SCHEDULED_REVIEW_WORKFLOW_ID,
} from '@kbn/workflows/managed';
import { assertSignificantEventsAccess } from '../../utils/assert_significant_events_access';
import { createServerRoute } from '../../create_server_route';

export const internalEngineActivityRoutes = createServerRoute({
  endpoint: 'GET /internal/significant_events/engine_activity',
  options: { access: 'internal', summary: 'Read detection engine progress and recent runs' },
  security: { authz: { requiredPrivileges: [NIGHTSHIFT_API_PRIVILEGES.read] } },
  params: z.object({}),
  handler: async ({ request, server, getScopedClients, getSpaceId }) => {
    const { licensing, sourcesClient } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    const spaceId = await getSpaceId(request);
    const sources = [];
    for (let page = 1; ; page++) {
      const result = await sourcesClient.list({ page, perPage: 100 });
      sources.push(...result.sources);
      if (sources.length >= result.total || !result.sources.length) break;
    }
    const [exploration, monitoring, events] = await Promise.all([
      server.knowledgeExploration.status(request),
      server.monitoringSetup.status(request),
      server.eventDiscovery.status(request),
    ]);
    const client = server.workflowsManagement?.management.getClient(request);
    const definitions = [
      {
        workflowId: SIGNIFICANT_EVENTS_ORCHESTRATOR_WORKFLOW_ID,
        kind: 'pipeline' as const,
        space: spaceId,
      },
      {
        workflowId: SIGNIFICANT_EVENTS_DETECTION_WORKFLOW_ID,
        kind: 'evaluation' as const,
        space: spaceId,
      },
      {
        workflowId: SIGNIFICANT_EVENTS_DISCOVERY_WORKFLOW_ID,
        kind: 'discovery' as const,
        space: spaceId,
      },
      {
        workflowId: `${SIGNIFICANT_EVENTS_SCHEDULED_REVIEW_WORKFLOW_ID}-${spaceId}`,
        kind: 'review' as const,
        space: spaceId,
      },
    ];
    const groups = await Promise.all(
      definitions.map(async (definition) => {
        if (!client) return [];
        const [recent, active] = await Promise.all([
          client.getWorkflowExecutions(
            {
              workflowId: definition.workflowId,
              size: 60,
              sortField: 'createdAt',
              sortOrder: 'desc',
              omitStepRuns: true,
            },
            definition.space
          ),
          client.getWorkflowExecutions(
            {
              workflowId: definition.workflowId,
              statuses: [...NonTerminalExecutionStatuses],
              size: 100,
              sortField: 'createdAt',
              sortOrder: 'desc',
              omitStepRuns: true,
            },
            definition.space
          ),
        ]);
        // Include older active executions even when newer completed runs fill the history window.
        const executions = [
          ...new Map(
            [...active.results, ...recent.results]
              .filter((run) => run.status !== 'skipped')
              .map((run) => [run.id, run])
          ).values(),
        ];
        return Promise.all(
          executions.map(async (run, index) => {
            // Return active progress and the latest run details, without agent inputs or outputs.
            const detail =
              !isTerminalStatus(run.status) || index === 0
                ? await client.getWorkflowExecution(run.id, definition.space)
                : undefined;
            return {
              id: run.id,
              kind: definition.kind,
              sourceId: null,
              status: run.status,
              startedAt: run.startedAt || new Date().toISOString(),
              finishedAt: run.finishedAt || null,
              error: run.error?.message ?? null,
              active: !isTerminalStatus(run.status),
              steps: (detail?.stepExecutions ?? []).map((step) => ({
                id: step.id,
                name: step.stepId,
                type: step.stepType,
                status: step.status,
                startedAt: step.startedAt,
                finishedAt: step.finishedAt,
                error: step.error?.message,
                active: !isTerminalStatus(step.status),
              })),
            };
          })
        );
      })
    );
    const agentRuns = await Promise.all(
      [
        { kind: 'learning' as const, state: exploration, service: server.knowledgeExploration },
        { kind: 'monitoring' as const, state: monitoring, service: server.monitoringSetup },
        { kind: 'discovery' as const, state: events, service: server.eventDiscovery },
      ].flatMap(({ kind, state, service }) =>
        state.runs.map(async (summary) => {
          const run =
            summary.status === 'running' ? await service.getRun(request, summary.id) : summary;
          return {
            id: run.id,
            kind,
            sourceId: run.sourceId ?? null,
            status: run.status,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt ?? null,
            error: run.error ?? null,
            active: run.status === 'running',
            steps: run.steps.map((step) => ({
              id: step.id,
              name: step.name,
              type: step.kind,
              status: step.status,
              startedAt: step.startedAt,
              finishedAt:
                step.status === 'running'
                  ? undefined
                  : new Date(Date.parse(step.startedAt) + step.durationMs).toISOString(),
              error: step.status === 'failed' ? step.output : undefined,
              active: step.status === 'running',
            })),
          };
        })
      )
    );
    return {
      available: true,
      learningEnabled: exploration.enabled,
      sources: sources.map((source) => ({
        id: source.id,
        name: source.id,
        title: source.title,
        description: source.description,
        type: 'query' as const,
        watched: source.enabled,
      })),
      runs: [...groups.flat(), ...agentRuns].sort(
        (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
      ),
      asOf: new Date().toISOString(),
    };
  },
});
