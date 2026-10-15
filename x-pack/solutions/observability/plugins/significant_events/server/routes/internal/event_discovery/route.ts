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
  endpoint: 'GET /internal/significant_events/event_discovery',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.eventDiscovery.status(request);
  },
});
const run = createServerRoute({
  endpoint: 'GET /internal/significant_events/event_discovery/runs/{runId}',
  options: { access: 'internal' },
  security,
  params: z.object({ path: z.object({ runId: z.string().min(1).max(255) }) }),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.eventDiscovery.getRun(request, params.path.runId);
  },
});
const recoverRunCost = createServerRoute({
  endpoint: 'POST /internal/significant_events/event_discovery/runs/{runId}/_recover_cost',
  options: { access: 'internal' },
  security,
  params: z.object({ path: z.object({ runId: z.string().min(1).max(255) }) }),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.eventDiscovery.recoverRunCost(request, params.path.runId);
  },
});
const start = createServerRoute({
  endpoint: 'POST /internal/significant_events/event_discovery/_run',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server, maintenanceService, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    return server.eventDiscovery.start(request, { reason: 'manual' });
  },
});
const scheduled = createServerRoute({
  endpoint: 'POST /internal/significant_events/event_discovery/_run_sync',
  options: { access: 'internal', timeout: { idleSocket: 1260000 } },
  security,
  handler: async ({ request, server, maintenanceService, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    if (!(await server.eventDiscovery.hourlyEnabled(request))) return { skipped: true };
    const started = await server.eventDiscovery.start(request, { reason: 'hourly' });
    return server.eventDiscovery.wait(request, started.id);
  },
});
const settings = createServerRoute({
  endpoint: 'PUT /internal/significant_events/event_discovery/settings',
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
    await server.eventDiscovery.setHourlyEnabled(
      request,
      params.body.enabled,
      params.body.intervalMinutes
    );
    return { success: true };
  },
});
const cancel = createServerRoute({
  endpoint: 'POST /internal/significant_events/event_discovery/_cancel',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server }) => {
    server.eventDiscovery.cancel(request);
    return { success: true };
  },
});
const reset = createServerRoute({
  endpoint: 'POST /internal/significant_events/event_discovery/_reset',
  options: { access: 'internal' },
  security,
  params: z.object({ body: z.object({ confirmation: z.literal('RESET DISCOVERY EVENTS') }) }),
  handler: async ({ request, server, getScopedClients, maintenanceService }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    return server.eventDiscovery.resetFeatures(request);
  },
});
const removeRun = createServerRoute({
  endpoint: 'DELETE /internal/significant_events/event_discovery/runs/{runId}',
  options: { access: 'internal' },
  security,
  params: z.object({ path: z.object({ runId: z.string().min(1).max(255) }) }),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await server.eventDiscovery.deleteRun(request, params.path.runId);
    return { success: true };
  },
});

const resetRuns = createServerRoute({
  endpoint: 'POST /internal/significant_events/event_discovery/runs/_reset',
  options: { access: 'internal' },
  security,
  params: z.object({ body: z.object({ confirmation: z.literal('RESET RUN HISTORY') }) }),
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.eventDiscovery.resetRunHistory(request);
  },
});

const resetTotals = createServerRoute({
  endpoint: 'POST /internal/significant_events/event_discovery/_reset_totals',
  options: { access: 'internal' },
  security,
  params: z.object({ body: z.object({ confirmation: z.literal('RESET TOTALS') }) }),
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.eventDiscovery.resetTotals(request);
  },
});

const anatomy = createServerRoute({
  endpoint: 'GET /internal/significant_events/event_discovery/anatomy',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.eventDiscovery.anatomy(request);
  },
});

const selectModel = createServerRoute({
  endpoint: 'PUT /internal/significant_events/event_discovery/model',
  options: { access: 'internal' },
  security,
  params: z.object({ body: z.object({ connectorId: z.string().min(1).max(255) }) }),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.eventDiscovery.selectModel(request, params.body.connectorId);
  },
});

export const internalEventDiscoveryRoutes = {
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
