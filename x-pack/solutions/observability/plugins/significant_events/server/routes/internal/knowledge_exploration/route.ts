/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import { NIGHTSHIFT_MANAGE_AND_CONFIGURE_API_PRIVILEGES } from '@kbn/nightshift-shared';
import { OBSERVABILITY_NIGHTSHIFT_CONTINUOUS_ONBOARDING_ENABLED } from '@kbn/management-settings-ids';
import { createServerRoute } from '../../create_server_route';
import { assertNotPaused } from '../../utils/assert_not_paused';
import { assertSignificantEventsAccess } from '../../utils/assert_significant_events_access';
import { StatusError } from '../../../lib/errors/status_error';

const security = { authz: { requiredPrivileges: NIGHTSHIFT_MANAGE_AND_CONFIGURE_API_PRIVILEGES } };
const status = createServerRoute({
  endpoint: 'GET /internal/significant_events/knowledge_exploration',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.knowledgeExploration.status(request);
  },
});
const run = createServerRoute({
  endpoint: 'GET /internal/significant_events/knowledge_exploration/runs/{runId}',
  options: { access: 'internal' },
  security,
  params: z.object({ path: z.object({ runId: z.string().min(1).max(255) }) }),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.knowledgeExploration.getRun(request, params.path.runId);
  },
});
const recoverRunCost = createServerRoute({
  endpoint: 'POST /internal/significant_events/knowledge_exploration/runs/{runId}/_recover_cost',
  options: { access: 'internal' },
  security,
  params: z.object({ path: z.object({ runId: z.string().min(1).max(255) }) }),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.knowledgeExploration.recoverRunCost(request, params.path.runId);
  },
});
const start = createServerRoute({
  endpoint: 'POST /internal/significant_events/knowledge_exploration/_run',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server, maintenanceService, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    return server.knowledgeExploration.start(request, { reason: 'manual' });
  },
});
const scheduled = createServerRoute({
  endpoint: 'POST /internal/significant_events/knowledge_exploration/_run_sync',
  options: { access: 'internal', timeout: { idleSocket: 1260000 } },
  security,
  handler: async ({ request, server, maintenanceService, getScopedClients }) => {
    const { licensing, uiSettingsClient } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    if (
      !(await uiSettingsClient.get<boolean>(OBSERVABILITY_NIGHTSHIFT_CONTINUOUS_ONBOARDING_ENABLED))
    )
      return { skipped: true };
    const started = await server.knowledgeExploration.start(request, { reason: 'hourly' });
    return server.knowledgeExploration.wait(request, started.id);
  },
});
const cancel = createServerRoute({
  endpoint: 'POST /internal/significant_events/knowledge_exploration/_cancel',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server }) => {
    server.knowledgeExploration.cancel(request);
    return { success: true };
  },
});
const reset = createServerRoute({
  endpoint: 'POST /internal/significant_events/knowledge_exploration/_reset',
  options: { access: 'internal' },
  security,
  params: z.object({ body: z.object({ confirmation: z.literal('RESET FEATURE KNOWLEDGE') }) }),
  handler: async ({ request, server, getScopedClients, maintenanceService }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    return server.knowledgeExploration.resetFeatures(request);
  },
});
const settings = createServerRoute({
  endpoint: 'PUT /internal/significant_events/knowledge_exploration/settings',
  options: { access: 'internal' },
  security,
  params: z.object({
    body: z.object({
      enabled: z.boolean(),
      intervalMinutes: z.number().int().min(1).max(10080).optional(),
    }),
  }),
  handler: async ({
    request,
    params,
    server,
    getScopedClients,
    maintenanceService,
    continuousOnboardingWorkflowService,
  }) => {
    const { licensing, uiSettingsClient } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    if (!continuousOnboardingWorkflowService)
      throw new StatusError('Workflows management is unavailable', 503);
    const previousInterval = await server.knowledgeExploration.intervalMinutes(request);
    const intervalMinutes = params.body.intervalMinutes ?? previousInterval;
    const previous = await uiSettingsClient.get<boolean>(
      OBSERVABILITY_NIGHTSHIFT_CONTINUOUS_ONBOARDING_ENABLED
    );
    await uiSettingsClient.set(
      OBSERVABILITY_NIGHTSHIFT_CONTINUOUS_ONBOARDING_ENABLED,
      params.body.enabled
    );
    try {
      await continuousOnboardingWorkflowService.ensureWorkflow({
        enabled: params.body.enabled,
        intervalMinutes,
        request,
        spaceId: request.spaceId,
      });
      await server.knowledgeExploration.setIntervalMinutes(request, intervalMinutes);
    } catch (error) {
      await uiSettingsClient.set(OBSERVABILITY_NIGHTSHIFT_CONTINUOUS_ONBOARDING_ENABLED, previous);
      await continuousOnboardingWorkflowService.ensureWorkflow({
        enabled: previous,
        intervalMinutes: previousInterval,
        request,
        spaceId: request.spaceId,
      });
      throw error;
    }
    return { success: true };
  },
});

const removeRun = createServerRoute({
  endpoint: 'DELETE /internal/significant_events/knowledge_exploration/runs/{runId}',
  options: { access: 'internal' },
  security,
  params: z.object({ path: z.object({ runId: z.string().min(1).max(255) }) }),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await server.knowledgeExploration.deleteRun(request, params.path.runId);
    return { success: true };
  },
});

const resetRuns = createServerRoute({
  endpoint: 'POST /internal/significant_events/knowledge_exploration/runs/_reset',
  options: { access: 'internal' },
  security,
  params: z.object({ body: z.object({ confirmation: z.literal('RESET RUN HISTORY') }) }),
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.knowledgeExploration.resetRunHistory(request);
  },
});

const resetTotals = createServerRoute({
  endpoint: 'POST /internal/significant_events/knowledge_exploration/_reset_totals',
  options: { access: 'internal' },
  security,
  params: z.object({ body: z.object({ confirmation: z.literal('RESET TOTALS') }) }),
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.knowledgeExploration.resetTotals(request);
  },
});

const anatomy = createServerRoute({
  endpoint: 'GET /internal/significant_events/knowledge_exploration/anatomy',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.knowledgeExploration.anatomy(request);
  },
});

const selectModel = createServerRoute({
  endpoint: 'PUT /internal/significant_events/knowledge_exploration/model',
  options: { access: 'internal' },
  security,
  params: z.object({ body: z.object({ connectorId: z.string().min(1).max(255) }) }),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.knowledgeExploration.selectModel(request, params.body.connectorId);
  },
});

const recoverSourceWrite = createServerRoute({
  endpoint: 'POST /internal/significant_events/knowledge_exploration/_recover_source_write',
  options: { access: 'internal' },
  security,
  params: z.object({
    body: z.object({
      sourceId: z.string().min(1).max(255),
      confirmation: z.literal('RECOVER STALE SOURCE WRITE'),
    }),
  }),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.knowledgeExploration.recoverSourceWrite(request, params.body.sourceId);
  },
});

export const internalKnowledgeExplorationRoutes = {
  ...status,
  ...run,
  ...start,
  ...scheduled,
  ...cancel,
  ...reset,
  ...settings,
  ...removeRun,
  ...resetRuns,
  ...resetTotals,
  ...anatomy,
  ...selectModel,
  ...recoverSourceWrite,
  ...recoverRunCost,
};
