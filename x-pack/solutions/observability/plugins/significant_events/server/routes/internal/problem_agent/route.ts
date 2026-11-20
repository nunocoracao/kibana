/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { NIGHTSHIFT_MANAGE_AND_CONFIGURE_API_PRIVILEGES } from '@kbn/nightshift-shared';
import { lazySchema, z } from '@kbn/zod/v4';
import { createServerRoute } from '../../create_server_route';
import { assertNotPaused } from '../../utils/assert_not_paused';
import { assertSignificantEventsAccess } from '../../utils/assert_significant_events_access';

const security = { authz: { requiredPrivileges: NIGHTSHIFT_MANAGE_AND_CONFIGURE_API_PRIVILEGES } };
const status = createServerRoute({
  endpoint: 'GET /internal/significant_events/problem_agent',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.problemAgent.status(request);
  },
});
const run = createServerRoute({
  endpoint: 'GET /internal/significant_events/problem_agent/runs/{runId}',
  options: { access: 'internal' },
  security,
  params: lazySchema(() => z.object({ path: z.object({ runId: z.string().min(1).max(255) }) })),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.problemAgent.getRun(request, params.path.runId);
  },
});
const recoverRunCost = createServerRoute({
  endpoint: 'POST /internal/significant_events/problem_agent/runs/{runId}/_recover_cost',
  options: { access: 'internal' },
  security,
  params: lazySchema(() => z.object({ path: z.object({ runId: z.string().min(1).max(255) }) })),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.problemAgent.recoverRunCost(request, params.path.runId);
  },
});
const start = createServerRoute({
  endpoint: 'POST /internal/significant_events/problem_agent/_run',
  options: { access: 'internal' },
  security,
  params: lazySchema(() =>
    z.object({ body: z.object({ evaluationMode: z.boolean().default(false) }).nullish() })
  ),
  handler: async ({ request, params, server, maintenanceService, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    return server.problemAgent.start(request, {
      reason: 'manual',
      evaluationMode: params?.body?.evaluationMode ?? false,
    });
  },
});
const scheduled = createServerRoute({
  endpoint: 'POST /internal/significant_events/problem_agent/_run_sync',
  options: { access: 'internal', timeout: { idleSocket: 1260000 } },
  security,
  handler: async ({ request, server, maintenanceService, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    if (!(await server.problemAgent.hourlyEnabled(request))) return { skipped: true };
    const started = await server.problemAgent.start(request, { reason: 'hourly' });
    return server.problemAgent.wait(request, started.id);
  },
});
const cancel = createServerRoute({
  endpoint: 'POST /internal/significant_events/problem_agent/_cancel',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server }) => {
    server.problemAgent.cancel(request);
    return { success: true };
  },
});
const reset = createServerRoute({
  endpoint: 'POST /internal/significant_events/problem_agent/_reset',
  options: { access: 'internal' },
  security,
  params: lazySchema(() =>
    z.object({ body: z.object({ confirmation: z.literal('RESET FEATURE KNOWLEDGE') }) })
  ),
  handler: async ({ request, server, getScopedClients, maintenanceService }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    return server.problemAgent.resetFeatures(request);
  },
});
const settings = createServerRoute({
  endpoint: 'PUT /internal/significant_events/problem_agent/settings',
  options: { access: 'internal' },
  security,
  params: lazySchema(() =>
    z.object({
      body: z.object({
        enabled: z.boolean(),
        intervalMinutes: z.number().int().min(1).max(10080).optional(),
      }),
    })
  ),
  handler: async ({ request, params, server, getScopedClients, maintenanceService }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    await server.problemAgent.setHourlyEnabled(
      request,
      params.body.enabled,
      params.body.intervalMinutes
    );
    return { success: true };
  },
});
const removeRun = createServerRoute({
  endpoint: 'DELETE /internal/significant_events/problem_agent/runs/{runId}',
  options: { access: 'internal' },
  security,
  params: lazySchema(() => z.object({ path: z.object({ runId: z.string().min(1).max(255) }) })),
  handler: async ({ request, params, server }) => {
    await server.problemAgent.deleteRun(request, params.path.runId);
    return { success: true };
  },
});
const resetRuns = createServerRoute({
  endpoint: 'POST /internal/significant_events/problem_agent/_reset_runs',
  options: { access: 'internal' },
  security,
  params: lazySchema(() =>
    z.object({ body: z.object({ confirmation: z.literal('RESET RUN HISTORY') }) })
  ),
  handler: async ({ request, server }) => server.problemAgent.resetRunHistory(request),
});
const resetTotals = createServerRoute({
  endpoint: 'POST /internal/significant_events/problem_agent/_reset_totals',
  options: { access: 'internal' },
  security,
  params: lazySchema(() =>
    z.object({ body: z.object({ confirmation: z.literal('RESET TOTALS') }) })
  ),
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.problemAgent.resetTotals(request);
  },
});

const anatomy = createServerRoute({
  endpoint: 'GET /internal/significant_events/problem_agent/anatomy',
  options: { access: 'internal' },
  security,
  handler: async ({ request, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.problemAgent.anatomy(request);
  },
});

const selectModel = createServerRoute({
  endpoint: 'PUT /internal/significant_events/problem_agent/model',
  options: { access: 'internal' },
  security,
  params: lazySchema(() =>
    z.object({ body: z.object({ connectorId: z.string().min(1).max(255) }) })
  ),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.problemAgent.selectModel(request, params.body.connectorId);
  },
});

const recoverSourceWrite = createServerRoute({
  endpoint: 'POST /internal/significant_events/problem_agent/_recover_source_write',
  options: { access: 'internal' },
  security,
  params: lazySchema(() =>
    z.object({
      body: z.object({
        sourceId: z.string().min(1).max(255),
        confirmation: z.literal('RECOVER STALE SOURCE WRITE'),
      }),
    })
  ),
  handler: async ({ request, params, server, getScopedClients }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    return server.problemAgent.recoverSourceWrite(request, params.body.sourceId);
  },
});

const resetOutputs = createServerRoute({
  endpoint: 'POST /internal/significant_events/problem_agent/_reset_outputs',
  options: { access: 'internal' },
  security,
  params: lazySchema(() =>
    z.object({ body: z.object({ confirmation: z.literal('RESET AGENT OUTPUTS') }) })
  ),
  handler: async ({ request, server, getScopedClients, maintenanceService }) => {
    const { licensing } = await getScopedClients({ request });
    await assertSignificantEventsAccess({ server, licensing });
    await assertNotPaused({ maintenanceService, request });
    return server.problemAgent.resetOutputs(request);
  },
});

export const problemAgentRoutes = {
  ...resetOutputs,
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
