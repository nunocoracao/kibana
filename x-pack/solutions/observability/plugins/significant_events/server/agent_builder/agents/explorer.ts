/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import Boom from '@hapi/boom';
import { z } from '@kbn/zod/v4';
import { AgentAccessControlMode, ToolType } from '@kbn/agent-builder-common';
import { ToolResultType } from '@kbn/agent-builder-common/tools/tool_result';
import type { AgentBuilderPluginSetup, AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import type { AgentTypeDefinition } from '@kbn/agent-builder-server/agents';
import { NIGHTSHIFT_API_PRIVILEGES } from '@kbn/nightshift-shared';
import type { SignificantEventsServer } from '../../types';
import type { ExplorerAgent } from '../../../common/knowledge_exploration';
import type { SignificantEventsMaintenanceService } from '../../lib/maintenance/maintenance_service';
import { assertSignificantEventsAccess } from '../../routes/utils/assert_significant_events_access';
import { assertNotPaused } from '../../routes/utils/assert_not_paused';
import { createSignificantEventsAvailability } from '../tools/significant_events_availability';

const profiles = [
  {
    agent: 'knowledge',
    id: 'nightshift-v2-knowledge-extractor',
    type: 'platform.sig_events.v2-knowledge-extractor-type',
    name: 'v2 Knowledge Extractor',
    tool: 'platform.sig_events.v2_knowledge_extractor',
    description: 'Explore configured sources and learn evidence-backed knowledge indicators.',
  },
  {
    agent: 'monitoring',
    id: 'nightshift-v2-monitoring-setup',
    type: 'platform.sig_events.v2-monitoring-setup-type',
    name: 'v2 Monitoring Setup',
    tool: 'platform.sig_events.v2_monitoring_setup',
    description: 'Assess configured-source coverage and maintain native managed Kibana monitors.',
  },
  {
    agent: 'events',
    id: 'nightshift-v2-event-discovery',
    type: 'platform.sig_events.v2-event-discovery-type',
    name: 'V2 Event Discovery',
    tool: 'platform.sig_events.v2_event_discovery',
    description:
      'Correlate recent managed and user rule firings and persist native active/inactive event assessments.',
  },
] as const;

export const registerExplorerAgentTypes = (agentBuilder: AgentBuilderPluginSetup): void => {
  for (const profile of profiles) {
    const type: AgentTypeDefinition = {
      id: profile.type,
      name: profile.name,
      description: profile.description,
      avatar_icon: 'logoElastic',
      baseConfiguration: {
        instructions: `You are ${profile.name}. Control the canonical source-scoped agentic loop through ${profile.tool}. Use action=run only when explicitly asked to start, status to inspect, stop to cancel, anatomy to inspect its actual prompt/tools/model/thinking. Start at most one run per request. Run returns immediately with an Agent Explorer link; return the link and run ID, then stop. Never poll automatically, restart, schedule or launch other agents. The loop uses the model selected in Agent Explorer (default GPT-6 Luna), cancellation and a $50 reported-estimated cost ceiling. Agent Builder conversation charges are separate. No skills. Never claim a started run completed. Use Agent Explorer for model/output/history resets.`,
        skill_ids: [],
        connector_ids: [],
        tools: [{ tool_ids: [profile.tool] }],
        enable_elastic_capabilities: false,
      },
    };
    agentBuilder.agents.registerType(type);
  }
};

export const installExplorerAgents = async (
  agentBuilder: AgentBuilderPluginStart,
  server: SignificantEventsServer,
  spaceId: string,
  agent?: ExplorerAgent
): Promise<void> => {
  for (const profile of profiles.filter((item) => !agent || item.agent === agent)) {
    await agentBuilder.agents.ensure({
      spaceId,
      availability: createSignificantEventsAvailability({ server, logger: server.logger }),
      agent: {
        id: profile.id,
        type: profile.type,
        name: profile.name,
        description: profile.description,
        labels: ['observability', 'nightshift', 'v2'],
        avatar_symbol:
          profile.agent === 'knowledge' ? 'KI' : profile.agent === 'monitoring' ? 'MS' : 'ED',
        access_control: { access_mode: AgentAccessControlMode.Public },
        configuration: { tools: [], skill_ids: [], connector_ids: [] },
      },
    });
  }
};

export const registerExplorerControlTools = (
  agentBuilder: AgentBuilderPluginSetup,
  server: SignificantEventsServer,
  getMaintenance: () => SignificantEventsMaintenanceService | undefined
): void => {
  for (const profile of profiles.filter((item) => item.tool)) {
    agentBuilder.tools.register({
      id: profile.tool,
      type: ToolType.builtin,
      tags: ['nightshift', 'v2'],
      description: `Run, inspect or stop ${profile.name}. Starts the canonical agentic loop once and returns immediately. Never auto-poll. Model, thinking, traces, costs and output resets are managed in Agent Explorer.`,
      annotations: {
        title: profile.name,
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      schema: z.object({
        action: z.enum(['run', 'status', 'stop', 'anatomy']),
        runId: z.string().max(255).optional(),
      }),
      availability: {
        cacheMode: 'space',
        handler: async () => {
          try {
            await assertSignificantEventsAccess({ server, licensing: server.licensing });
            return { status: 'available' };
          } catch (error) {
            return {
              status: 'unavailable',
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        },
      },
      handler: async (params, { request }) => {
        await assertSignificantEventsAccess({ server, licensing: server.licensing });
        const authz = server.security.authz;
        const allowed =
          authz &&
          (await authz.checkPrivilegesDynamicallyWithRequest(request)({
            kibana: [
              authz.actions.api.get(NIGHTSHIFT_API_PRIVILEGES.manage),
              authz.actions.api.get(NIGHTSHIFT_API_PRIVILEGES.configure),
            ],
          }));
        if (!allowed?.hasAllRequested)
          throw Boom.forbidden('Nightshift manage and configure privileges are required');
        const service =
          profile.agent === 'events'
            ? server.eventDiscovery
            : profile.agent === 'monitoring'
            ? server.monitoringSetup
            : server.knowledgeExploration;
        const explorerUrl = `${server.core.http.basePath.get(
          request
        )}/app/significant_events/knowledge-exploration?agent=${profile.agent}`;
        if (params.action === 'stop') {
          service.cancel(request);
          return {
            results: [{ type: ToolResultType.other, data: { stopped: true, explorerUrl } }],
          };
        }
        if (params.action === 'anatomy')
          return {
            results: [{ type: ToolResultType.other, data: await service.anatomy(request) }],
          };
        if (params.action === 'run') {
          const maintenanceService = getMaintenance();
          if (!maintenanceService) throw Boom.serverUnavailable('Nightshift is starting');
          await assertNotPaused({ maintenanceService, request });
          const run = await service.start(request, { reason: 'manual' });
          return {
            results: [
              {
                type: ToolResultType.other,
                data: { runId: run.id, status: run.status, model: run.model, explorerUrl },
              },
            ],
          };
        }
        if (params.runId) {
          const run = await service.getRun(request, params.runId);
          return {
            results: [{ type: ToolResultType.other, data: { ...run, steps: [], explorerUrl } }],
          };
        }
        const status = await service.status(request);
        return {
          results: [
            {
              type: ToolResultType.other,
              data: {
                ...status,
                availableModels: undefined,
                runs: status.runs.slice(0, 10),
                explorerUrl,
              },
            },
          ],
        };
      },
    });
  }
};
