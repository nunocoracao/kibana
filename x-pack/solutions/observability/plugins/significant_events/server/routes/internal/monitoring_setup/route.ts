/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import { NIGHTSHIFT_MANAGE_AND_CONFIGURE_API_PRIVILEGES } from '@kbn/nightshift-shared';
import { createServerRoute } from '../../create_server_route';
import { assertNotPaused } from '../../utils/assert_not_paused';
import { assertSignificantEventsAccess } from '../../utils/assert_significant_events_access';

const security = { authz: { requiredPrivileges: NIGHTSHIFT_MANAGE_AND_CONFIGURE_API_PRIVILEGES } };
const status = createServerRoute({
  endpoint: 'GET /internal/significant_events/monitoring_setup',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.monitoringSetup.status(request);
  },
});
const run = createServerRoute({
  endpoint: 'GET /internal/significant_events/monitoring_setup/runs/{runId}',
  options: { access: 'internal' },
  security,
  params: z.object({ path: z.object({ runId: z.string().min(1).max(255) }) }),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.monitoringSetup.getRun(request, params.path.runId);
  },
});
const recoverRunCost = createServerRoute({
  endpoint: 'POST /internal/significant_events/monitoring_setup/runs/{runId}/_recover_cost',
  options: { access: 'internal' },
  security,
  params: z.object({ path: z.object({ runId: z.string().min(1).max(255) }) }),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.monitoringSetup.recoverRunCost(request, params.path.runId);
  },
});
const start = createServerRoute({
  endpoint: 'POST /internal/significant_events/monitoring_setup/_run',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server, maintenanceService, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    return server.monitoringSetup.start(request, { reason: 'manual' });
  },
});
const scheduled = createServerRoute({
  endpoint: 'POST /internal/significant_events/monitoring_setup/_run_sync',
  options: { access: 'internal', timeout: { idleSocket: 1260000 } },
  security,
  handler: async ({ request, server, maintenanceService, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    if (!(await server.monitoringSetup.hourlyEnabled(request))) return { skipped: true };
    const started = await server.monitoringSetup.start(request, { reason: 'hourly' });
    return server.monitoringSetup.wait(request, started.id);
  },
});
const settings = createServerRoute({
  endpoint: 'PUT /internal/significant_events/monitoring_setup/settings',
  options: { access: 'internal' },
  security,
  params: z.object({
    body: z.object({
      enabled: z.boolean(),
      intervalMinutes: z.number().int().min(1).max(10080).optional(),
    }),
  }),
  handler: async ({ request, params, server, maintenanceService, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    await server.monitoringSetup.setHourlyEnabled(
      request,
      params.body.enabled,
      params.body.intervalMinutes
    );
    return { success: true };
  },
});
const cancel = createServerRoute({
  endpoint: 'POST /internal/significant_events/monitoring_setup/_cancel',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server }) => {
    server.monitoringSetup.cancel(request);
    return { success: true };
  },
});
const reset = createServerRoute({
  endpoint: 'POST /internal/significant_events/monitoring_setup/_reset',
  options: { access: 'internal' },
  security,
  params: z.object({ body: z.object({ confirmation: z.literal('RESET MONITORING RULES') }) }),
  handler: async ({ request, server, getScopedClients, maintenanceService }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    return server.monitoringSetup.resetFeatures(request);
  },
});
const removeRun = createServerRoute({
  endpoint: 'DELETE /internal/significant_events/monitoring_setup/runs/{runId}',
  options: { access: 'internal' },
  security,
  params: z.object({ path: z.object({ runId: z.string().min(1).max(255) }) }),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await server.monitoringSetup.deleteRun(request, params.path.runId);
    return { success: true };
  },
});

const resetRuns = createServerRoute({
  endpoint: 'POST /internal/significant_events/monitoring_setup/runs/_reset',
  options: { access: 'internal' },
  security,
  params: z.object({ body: z.object({ confirmation: z.literal('RESET RUN HISTORY') }) }),
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.monitoringSetup.resetRunHistory(request);
  },
});

const resetTotals = createServerRoute({
  endpoint: 'POST /internal/significant_events/monitoring_setup/_reset_totals',
  options: { access: 'internal' },
  security,
  params: z.object({ body: z.object({ confirmation: z.literal('RESET TOTALS') }) }),
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.monitoringSetup.resetTotals(request);
  },
});

const anatomy = createServerRoute({
  endpoint: 'GET /internal/significant_events/monitoring_setup/anatomy',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.monitoringSetup.anatomy(request);
  },
});

const selectModel = createServerRoute({
  endpoint: 'PUT /internal/significant_events/monitoring_setup/model',
  options: { access: 'internal' },
  security,
  params: z.object({ body: z.object({ connectorId: z.string().min(1).max(255) }) }),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.monitoringSetup.selectModel(request, params.body.connectorId);
  },
});

export const internalMonitoringSetupRoutes = {
  ...status,
  ...run,
  ...start,
  ...scheduled,
  ...settings,
  ...cancel,
  ...reset,
  ...removeRun,
  ...resetRuns,
  ...resetTotals,
  ...anatomy,
  ...selectModel,
  ...recoverRunCost,
};
