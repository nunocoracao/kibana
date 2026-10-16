/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomUUID } from 'node:crypto';
import {
  SIGNIFICANT_EVENTS_MONITORING_SETUP_HOURLY_WORKFLOW_ID,
  SIGNIFICANT_EVENTS_EVENT_DISCOVERY_HOURLY_WORKFLOW_ID,
} from '@kbn/workflows/managed';
import type { KibanaRequest } from '@kbn/core/server';
import { MessageRole } from '@kbn/inference-common';
import type { Message, ChatCompletionTokenCount } from '@kbn/inference-common';
import { OBSERVABILITY_NIGHTSHIFT_CONTINUOUS_ONBOARDING_ENABLED } from '@kbn/management-settings-ids';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import { SEVERITY_CONTRACT_RULE } from '@kbn/significant-events-schema';
import type {
  ExplorerAgent,
  ExplorationState,
  ExplorationRun,
  ExplorationPricing,
  ExplorationStatus,
  ExplorationTokens,
} from '../../../common/knowledge_exploration';
import {
  emptyExplorationTokens,
  incrementalExplorationLimits,
  initialExplorationLimits,
} from '../../../common/knowledge_exploration';
import type { SignificantEventsServer } from '../../types';
import type { GetScopedClients } from '../../routes/types';
import type { PriceService } from '../cost/price_service';
import { SOURCE_KNOWLEDGE_STATE_TYPE } from '../knowledge_indicators/source_knowledge_state';
import { StatusError } from '../errors/status_error';
import { EXPLORATION_RUN_TYPE, EXPLORATION_STATE_TYPE, ExplorationStore } from './store';
import { explorationTools, ExplorationToolSession } from './tools';
import {
  buildSamplingAgenda,
  mergeSamplingAttempts,
  SAMPLING_STRATEGY,
  summarizeSamplingAttempts,
} from './sampling_strategy';
import prompt from './system_prompt.text';
import discoveryPrompt from '../event_discovery/system_prompt.text';
import {
  discoveryTools,
  EventDiscoveryToolSession,
  countDiscoveryEvents,
  resetDiscoveryEvents,
} from '../event_discovery/tools';
import { EVENT_DISCOVERY_RUN_TYPE, EVENT_DISCOVERY_STATE_TYPE } from './store';
import monitoringPrompt from '../monitoring_setup/system_prompt.text';
import { MAX_MANAGED_RULES_PER_SERVICE } from '../monitoring_setup/guardrails';
import {
  monitoringTools,
  MonitoringToolSession,
  resetMonitoringRules,
  countMonitoringRules,
} from '../monitoring_setup/tools';
import { installExplorerAgents } from '../../agent_builder/agents/explorer';
import { MONITORING_RUN_TYPE, MONITORING_STATE_TYPE } from './store';

const progressGaps = (summary: string): string[] => [
  `Previous run was incomplete: ${summary.slice(
    0,
    450
  )}. Recheck unfinished source/taxonomy dimensions.`,
];
const LEASE_MS = 90_000;
const MAX_AGENT_RUN_COST_USD = 50;
const MAX_MODEL_REQUEST_MS = 180000;
const MAX_MODEL_ATTEMPTS = 2;
const priceModelKey = (model: string): string =>
  model
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/-chat_completion$/, '')
    .replace(/\s+/g, '-')
    .replace(/^(anthropic-claude)-(\d+(?:\.\d+)?)-(opus|sonnet|haiku|fable|mythos)$/, '$1-$3-$2');
const runDurationMs = (run: ExplorationRun, end = Date.now()): number => {
  const startedAt = Date.parse(run.startedAt);
  const finishedAt = run.finishedAt ? Date.parse(run.finishedAt) : end;
  return Number.isFinite(startedAt) && Number.isFinite(finishedAt)
    ? Math.max(0, finishedAt - startedAt)
    : 0;
};
const recordRunDuration = (state: ExplorationState, run: ExplorationRun): void => {
  state.totalRunDurationMs = (state.totalRunDurationMs ?? 0) + runDurationMs(run);
  state.totalRunDurationSamples = (state.totalRunDurationSamples ?? 0) + 1;
};
const addTokens = (target: ExplorationTokens, source: ExplorationTokens): void => {
  for (const key of ['prompt', 'completion', 'thinking', 'cached', 'total'] as const)
    target[key] += source[key];
};
const tokensOf = (tokens?: ChatCompletionTokenCount): ExplorationTokens => ({
  prompt: tokens?.prompt ?? 0,
  completion: tokens?.completion ?? 0,
  thinking: tokens?.thinking ?? 0,
  cached: tokens?.cached ?? 0,
  total: tokens?.total ?? 0,
});
const costOf = (
  pricing: ExplorationPricing | undefined,
  tokens: ExplorationTokens
): number | undefined => {
  if (!pricing || (pricing.tierThreshold !== null && tokens.prompt > pricing.tierThreshold)) return;
  const cached = Math.min(tokens.cached, tokens.prompt);
  if (cached > 0 && pricing.cacheRead === null) return;
  return (
    ((tokens.prompt - cached) * pricing.input +
      cached * (pricing.cacheRead ?? 0) +
      (tokens.completion + tokens.thinking) * pricing.output) /
    1000000
  );
};

const awaitModel = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Model request cancelled'));
    };
    if (signal.aborted) {
      void promise.catch(() => undefined);
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });

export class KnowledgeExplorationService {
  private active = new Map<
    string,
    { runId: string; controller: AbortController; promise: Promise<void> }
  >();
  private pendingSources = new Map<string, Set<string>>();
  private stopping = false;
  private installedAgentSpaces = new Map<string, Promise<void>>();
  constructor(
    private getServer: () => SignificantEventsServer | undefined,
    private getScopedClients: GetScopedClients,
    private getPriceService: () => PriceService,
    private agent: ExplorerAgent = 'knowledge'
  ) {}
  private get tools() {
    return this.agent === 'events'
      ? discoveryTools
      : this.agent === 'monitoring'
      ? monitoringTools
      : explorationTools;
  }
  private get systemPrompt() {
    const instructions =
      this.agent === 'events'
        ? discoveryPrompt + '\n' + SEVERITY_CONTRACT_RULE
        : this.agent === 'monitoring'
        ? monitoringPrompt
        : prompt;
    return (
      instructions +
      SAMPLING_STRATEGY +
      '\nRUN INSPECTOR PROGRESS NOTES\nBefore calling tools, include one short user-facing sentence in your response explaining the next investigation or decision and its purpose. When reviewing results, state the key finding or uncertainty that motivates the next action. Keep notes concise (roughly 25 words), avoid repetitive boilerplate, and do not disclose private chain-of-thought. These progress summaries are shown in Agent Explorer alongside your tool calls.'
    );
  }

  private server(): SignificantEventsServer {
    const server = this.getServer();
    if (!server?.core) throw new Error('Knowledge Explorer is starting');
    return server;
  }
  private store(request: KibanaRequest): ExplorationStore {
    return new ExplorationStore(
      this.server().core.savedObjects.createInternalRepository([
        this.agent === 'events'
          ? EVENT_DISCOVERY_RUN_TYPE
          : this.agent === 'monitoring'
          ? MONITORING_RUN_TYPE
          : EXPLORATION_RUN_TYPE,
        this.agent === 'events'
          ? EVENT_DISCOVERY_STATE_TYPE
          : this.agent === 'monitoring'
          ? MONITORING_STATE_TYPE
          : EXPLORATION_STATE_TYPE,
      ]),
      request.spaceId,
      this.agent
    );
  }
  private async ensureAgent(request: KibanaRequest): Promise<void> {
    const server = this.server();
    if (!server.agentBuilder) return;
    if (!this.installedAgentSpaces.has(request.spaceId)) {
      const installation = installExplorerAgents(
        server.agentBuilder,
        server,
        request.spaceId,
        this.agent
      ).catch((error) => {
        this.installedAgentSpaces.delete(request.spaceId);
        throw error;
      });
      this.installedAgentSpaces.set(request.spaceId, installation);
    }
    await this.installedAgentSpaces.get(request.spaceId);
  }
  private async model(request: KibanaRequest): Promise<{ connectorId: string; model: string }> {
    const connectors = await this.server().inference.getConnectorList(request);
    const { state } = await this.store(request).getState();
    if (state.selectedConnectorId) {
      const connector = connectors.find((item) => item.connectorId === state.selectedConnectorId);
      if (!connector)
        throw new StatusError(
          'The selected inference connector is unavailable; select another model',
          409
        );
      return { connectorId: connector.connectorId, model: connector.name };
    }
    const lunaPro = connectors.find(
      (connector) => connector.connectorId === '.openai-gpt-6-luna-pro-chat_completion'
    );
    if (!lunaPro)
      throw new StatusError(
        'Configure a Luna 6 Pro inference connector before running an agent',
        409
      );
    return { connectorId: lunaPro.connectorId, model: lunaPro.name };
  }

  async intervalMinutes(request: KibanaRequest): Promise<number> {
    return (await this.store(request).getState()).state.intervalMinutes ?? 60;
  }

  async setIntervalMinutes(request: KibanaRequest, intervalMinutes: number): Promise<void> {
    const store = this.store(request);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await store.getState();
      current.state.intervalMinutes = intervalMinutes;
      try {
        await store.setState(current.state, current.version);
        return;
      } catch (error) {
        if (!(error instanceof Error) || !/conflict/i.test(error.message) || attempt === 2)
          throw error;
      }
    }
  }

  async hourlyEnabled(request: KibanaRequest): Promise<boolean> {
    return (await this.store(request).getState()).state.hourlyEnabled ?? false;
  }

  async setHourlyEnabled(
    request: KibanaRequest,
    enabled: boolean,
    intervalMinutes?: number
  ): Promise<void> {
    if (this.agent === 'knowledge') throw new StatusError('Use Knowledge schedule settings', 400);
    const server = this.server();
    const extensions = server.workflowsExtensions;
    const management = server.workflowsManagement?.management;
    if (!extensions || !management)
      throw new StatusError('Workflows management is unavailable', 503);
    const definitionId =
      this.agent === 'events'
        ? SIGNIFICANT_EVENTS_EVENT_DISCOVERY_HOURLY_WORKFLOW_ID
        : SIGNIFICANT_EVENTS_MONITORING_SETUP_HOURLY_WORKFLOW_ID;
    const workflowId = `${definitionId}-${request.spaceId}`;
    const previousInterval = await this.intervalMinutes(request);
    const nextInterval = intervalMinutes ?? previousInterval;
    const setWorkflow = async (scheduled: boolean, minutes: number): Promise<void> => {
      if (scheduled) {
        const client = await extensions.initManagedWorkflowsClient('significantEvents');
        await client.install(definitionId, {
          spaceId: request.spaceId,
          workflowIdSuffix: request.spaceId,
          values: { intervalMinutes: minutes },
        });
      }
      const existing = await management.getClient(request).getWorkflow(workflowId, request.spaceId);
      if (existing && existing.enabled !== scheduled)
        await management.updateWorkflow(
          workflowId,
          { enabled: scheduled },
          request.spaceId,
          request
        );
    };
    const previous = await this.hourlyEnabled(request);
    await setWorkflow(enabled, nextInterval);
    try {
      const store = this.store(request);
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await store.getState();
        current.state.hourlyEnabled = enabled;
        current.state.intervalMinutes = nextInterval;
        try {
          await store.setState(current.state, current.version);
          return;
        } catch (error) {
          if (!(error instanceof Error) || !/conflict/i.test(error.message) || attempt === 2)
            throw error;
        }
      }
    } catch (error) {
      await setWorkflow(previous, previousInterval);
      throw error;
    }
  }

  async selectModel(request: KibanaRequest, connectorId: string): Promise<{ success: true }> {
    const connectors = await this.server().inference.getConnectorList(request);
    if (!connectors.some((item) => item.connectorId === connectorId))
      throw new StatusError('Select an available inference connector', 400);
    const store = this.store(request);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await store.getState();
      current.state.selectedConnectorId = connectorId;
      try {
        await store.setState(current.state, current.version);
        return { success: true };
      } catch (error) {
        if (!(error instanceof Error) || !/conflict/i.test(error.message) || attempt === 2)
          throw error;
      }
    }
    throw new StatusError('Model selection changed concurrently; retry', 409);
  }

  private async pricing(
    connectorId: string,
    model: string
  ): Promise<ExplorationPricing | undefined> {
    const catalog = await this.getPriceService().getPrices();
    const identities = new Set([priceModelKey(connectorId), priceModelKey(model)]);
    const price = [...(catalog?.prices ?? [])].find(([key]) =>
      identities.has(priceModelKey(key))
    )?.[1];
    if (price) return { ...price, source: 'elastic_catalog' };
    if (!/haiku/i.test(model)) return;
    const newer = /5[.-]5/.test(model);
    return {
      input: newer ? 0.1 : 1,
      output: newer ? 0.5 : 5,
      cacheRead: newer ? 0.01 : 0.1,
      tierThreshold: newer ? 100000 : null,
      source: 'public_haiku',
    };
  }

  async recoverRunCost(request: KibanaRequest, id: string): Promise<ExplorationRun> {
    const store = this.store(request);
    const run = await store.getRun(id);
    if (run.status === 'running')
      throw new StatusError('Wait for this run to finish before recovering its estimate', 409);
    // Existing price snapshots are immutable; only recover runs that never resolved a price.
    if (run.pricing) return run;
    const pricing = await this.pricing(run.connectorId, run.model);
    if (!pricing) throw new StatusError('No verified pricing is available for this model', 409);
    const previousCost = run.estimatedCostUsd;
    const accountedTokens = emptyExplorationTokens();
    let complete = true;
    let estimatedCost = 0;
    for (const step of run.steps.filter((item) => item.kind === 'model')) {
      if (!step.tokens) {
        complete = false;
        continue;
      }
      addTokens(accountedTokens, step.tokens);
      const cost = costOf(pricing, step.tokens);
      if (cost === undefined) complete = false;
      else estimatedCost += cost;
      step.estimatedCostUsd = cost;
    }
    complete =
      complete &&
      (['prompt', 'completion', 'thinking', 'cached', 'total'] as const).every(
        (key) => accountedTokens[key] === run.tokens[key]
      );
    run.pricing = pricing;
    run.pricingRecoveredAt = new Date().toISOString();
    run.estimatedCostUsd = estimatedCost;
    run.costEstimateComplete = complete;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { state, version } = await store.getState();
      if (!state.repricedRunIds?.includes(run.id)) {
        const belongsToTotals =
          state.totalRuns > 0 &&
          (state.unpricedRuns ?? 0) > 0 &&
          (!state.costTotalsResetAt || run.startedAt >= state.costTotalsResetAt);
        if (belongsToTotals) {
          state.totalCostUsd += estimatedCost - previousCost;
          if (complete) state.unpricedRuns = Math.max(0, (state.unpricedRuns ?? 0) - 1);
        }
        state.repricedRunIds = [...(state.repricedRunIds ?? []), run.id];
        try {
          await store.setState(state, version);
        } catch (error) {
          if (!(error instanceof Error) || !/conflict/i.test(error.message) || attempt === 4)
            throw error;
          continue;
        }
      }
      await store.saveRun(run);
      return run;
    }
    throw new StatusError('Cost totals changed concurrently; retry recovery', 409);
  }

  async recoverSourceWrite(
    request: KibanaRequest,
    sourceId: string
  ): Promise<{ recovered: boolean }> {
    const clients = await this.getScopedClients({ request });
    await clients.sourcesClient.get(sourceId);
    const { state } = await this.recoverInterrupted(request, this.store(request));
    if (state.activeRunId)
      throw new StatusError('Stop the active exploration before recovering a source write', 409);
    const repository = this.server().core.savedObjects.createInternalRepository([
      SOURCE_KNOWLEDGE_STATE_TYPE,
    ]);
    const current = await repository.get<{ lease: { owner: string; expiresAt: number } | null }>(
      SOURCE_KNOWLEDGE_STATE_TYPE,
      sourceId,
      { namespace: request.spaceId }
    );
    if (!current.attributes.lease) return { recovered: false };
    const lastUpdated = Date.parse(current.updated_at ?? '');
    if (!Number.isFinite(lastUpdated) || Date.now() - lastUpdated < 11 * 60000)
      throw new StatusError(
        'The source write lease is still recent; wait for the current write to finish',
        409
      );
    const tasks = await this.server().core.elasticsearch.client.asInternalUser.tasks.list(
      { actions: 'indices:data/write/*', detailed: true },
      { requestTimeout: 10000 }
    );
    const writing = Object.values(tasks.nodes ?? {})
      .flatMap((node) => Object.values(node.tasks ?? {}))
      .some((task) => /knowledge|nightshift|\.kibana/.test(task.description ?? ''));
    if (writing)
      throw new StatusError(
        'Knowledge storage has active writes; retry recovery after they finish',
        409
      );
    await repository.update(
      SOURCE_KNOWLEDGE_STATE_TYPE,
      sourceId,
      { lease: null },
      { namespace: request.spaceId, version: current.version, refresh: 'wait_for' }
    );
    return { recovered: true };
  }

  async sources(request: KibanaRequest): Promise<NightshiftSource[]> {
    const { sourcesClient } = await this.getScopedClients({ request });
    const sources: NightshiftSource[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await sourcesClient.list({ page, perPage: 100 });
      sources.push(...result.sources);
      if (result.sources.length < 100) break;
    }
    return sources;
  }
  private async recoverInterrupted(request: KibanaRequest, store: ExplorationStore) {
    const current = await store.getState();
    const id = current.state.activeRunId;
    if (!id) return current;
    const local = this.active.get(request.spaceId);
    if (local) {
      const activeRun = await store.getRun(id);
      if (
        Date.now() - Date.parse(activeRun.startedAt) <=
        (activeRun.limits ?? incrementalExplorationLimits).maxDurationMinutes * 60000 + 60000
      )
        return current;
      local.controller.abort(new Error('Exceeded maximum run duration'));
      this.active.delete(request.spaceId);
      // No new writes can start after cancellation; retain the knowledge already saved.
    }
    const run = await store.getRun(id);
    const legacyLease = (current.state.leaseUntil ?? 0) > Date.now() + LEASE_MS;
    const progress = Date.parse(run.steps.at(-1)?.startedAt ?? run.startedAt);
    if (
      !local &&
      (current.state.leaseUntil ?? 0) > Date.now() &&
      !(legacyLease && Date.now() - progress > 150000)
    )
      return current;
    current.state.activeRunId = undefined;
    current.state.leaseUntil = undefined;
    if (run.status === 'running') {
      run.status = 'interrupted';
      run.costEstimateComplete = false;
      run.summary = local
        ? 'Worker exceeded the run limit; saved knowledge is preserved'
        : 'Worker stopped before completing this run';
      run.error = run.summary;
      run.finishedAt = new Date().toISOString();
      for (const step of run.steps) if (step.status === 'running') step.status = 'failed';
      current.state.totalCostUsd += run.estimatedCostUsd;
      if (run.costEstimateComplete === false)
        current.state.unpricedRuns = (current.state.unpricedRuns ?? 0) + 1;
      current.state.totalRuns++;
      recordRunDuration(current.state, run);
      addTokens(current.state.totalTokens, run.tokens);
    }
    await store.setState(current.state, current.version);
    await store.saveRun(run);
    return store.getState();
  }

  async resetTotals(request: KibanaRequest): Promise<{ success: true }> {
    const local = this.active.get(request.spaceId);
    if (local) {
      this.cancel(request);
      await local.promise;
    }
    const store = this.store(request);
    const current = await this.recoverInterrupted(request, store);
    if (current.state.activeRunId)
      throw new StatusError('Stop the active worker before resetting totals', 409);
    current.state.unpricedRuns = 0;
    current.state.costTotalsResetAt = new Date().toISOString();
    current.state.repricedRunIds = [];
    current.state.totalCostUsd = 0;
    current.state.totalRuns = 0;
    current.state.totalRunDurationMs = 0;
    current.state.totalRunDurationSamples = 0;
    current.state.totalTokens = emptyExplorationTokens();
    await store.setState(current.state, current.version);
    return { success: true };
  }

  async resetRunHistory(request: KibanaRequest): Promise<{ removed: number }> {
    const local = this.active.get(request.spaceId);
    if (local) {
      this.cancel(request);
      await local.promise;
    }
    const store = this.store(request);
    const current = await this.recoverInterrupted(request, store);
    if (current.state.activeRunId)
      throw new StatusError('Stop the active worker before clearing run history', 409);
    const removed = await store.clearRuns();
    current.state.unpricedRuns = 0;
    current.state.costTotalsResetAt = new Date().toISOString();
    current.state.repricedRunIds = [];
    current.state.totalCostUsd = 0;
    current.state.totalRuns = 0;
    current.state.totalRunDurationMs = 0;
    current.state.totalRunDurationSamples = 0;
    current.state.totalTokens = emptyExplorationTokens();
    await store.setState(current.state, current.version);
    return { removed };
  }

  async anatomy(request: KibanaRequest) {
    const selected = await this.model(request);
    return {
      name:
        this.agent === 'events'
          ? 'V2 Event Discovery'
          : this.agent === 'monitoring'
          ? 'v2 Monitoring Setup'
          : 'v2 Knowledge Extractor',
      ...selected,
      systemPrompt: this.systemPrompt,
      tools: Object.entries(this.tools).map(([name, definition]) => ({
        name,
        ...definition,
      })),
      thinking: { enabled: true, effort: 'low' },
      skills: [],
      scope: {
        spaceId: request.spaceId,
        sources: 'All enabled detection sources in this space',
        lookback:
          this.agent === 'knowledge'
            ? 'Choose explicit time windows using source volume/latency probes; sample historical intervals and scope by service before expensive exploration'
            : 'Agent-selected bounded windows; start small and widen with evidence',
      },
      triggers:
        this.agent !== 'knowledge'
          ? [
              `Every ${await this.intervalMinutes(request)} minutes when enabled (off by default)`,
              'Run now',
            ]
          : [
              `Every ${await this.intervalMinutes(request)} minutes when enabled`,
              'Source added or query changed',
              'Run now',
            ],
      limits: {
        ...incrementalExplorationLimits,
        incremental: incrementalExplorationLimits,
        initialLearning: initialExplorationLimits,
        selection: 'Initial learning until enabled sources have completed novelty checkpoints',
        maxModelRequestSeconds: MAX_MODEL_REQUEST_MS / 1000,
        hardEstimatedCostCeilingUsd: MAX_AGENT_RUN_COST_USD,
        ...(this.agent === 'monitoring'
          ? { maxActiveManagedRulesPerService: MAX_MANAGED_RULES_PER_SERVICE }
          : {}),
        maxFeatureBatch: 25,
      },
      persistence:
        this.agent === 'events'
          ? [
              'Native active/inactive event assessments',
              'Stable event series and prior verdicts',
              'Run traces and token/cost totals',
            ]
          : this.agent === 'monitoring'
          ? [
              'Native managed Kibana rules',
              'Existing-schema query KI references',
              'Source-scoped coverage reports',
              'Run traces and token/cost totals',
            ]
          : [
              'Existing-schema feature KIs',
              'Space-scoped novelty checkpoints',
              'Run traces and token/cost totals',
            ],
      costEstimate:
        'Reported chat tokens with a per-run snapshot of the Elastic inference price catalog; public Haiku rates are a fallback. Missing rates or unsupported price tiers are marked incomplete. Excludes cache writes, embedding and Elasticsearch compute costs.',
    };
  }

  async status(request: KibanaRequest): Promise<ExplorationStatus> {
    await this.ensureAgent(request);
    const store = this.store(request);
    const [{ state }, runs, selected, sources, clients] = await Promise.all([
      this.recoverInterrupted(request, store),
      store.listRuns(),
      this.model(request),
      this.sources(request),
      this.getScopedClients({ request }),
    ]);
    const connectors = await this.server().inference.getConnectorList(request);
    const candidate =
      state.activeRunId && (state.leaseUntil ?? 0) > Date.now()
        ? await store.getRun(state.activeRunId)
        : undefined;
    const active = candidate?.status === 'running' ? candidate : undefined;
    const visibleRuns = candidate
      ? [{ ...candidate, steps: [] }, ...runs.filter((run) => run.id !== candidate.id)]
      : runs;
    return {
      enabled:
        this.agent !== 'knowledge'
          ? state.hourlyEnabled ?? false
          : await clients.uiSettingsClient.get<boolean>(
              OBSERVABILITY_NIGHTSHIFT_CONTINUOUS_ONBOARDING_ENABLED
            ),
      interval: `${state.intervalMinutes ?? 60}m`,
      intervalMinutes: state.intervalMinutes ?? 60,
      thinking: true,
      ...selected,
      availableModels: connectors.map(({ connectorId, name }) => ({ connectorId, model: name })),
      costEstimateComplete: !(state.unpricedRuns ?? 0) && active?.costEstimateComplete !== false,
      runningRunId: active?.id,
      runs: visibleRuns,
      totalCostUsd: state.totalCostUsd + (active?.estimatedCostUsd ?? 0),
      totalRuns: state.totalRuns,
      totalRunDurationMs:
        state.totalRunDurationMs ??
        runs.reduce((total, run) => total + (run.finishedAt ? runDurationMs(run) : 0), 0),
      averageRunDurationMs:
        (state.totalRunDurationMs !== undefined && state.totalRunDurationSamples !== undefined
          ? state.totalRunDurationSamples > 0
            ? state.totalRunDurationMs / state.totalRunDurationSamples
            : 0
          : (() => {
              const completed = runs.filter((run) => run.finishedAt);
              return completed.length
                ? completed.reduce((total, run) => total + runDurationMs(run), 0) / completed.length
                : 0;
            })()) || 0,
      totalTokens: state.totalTokens,
      featureCount:
        this.agent === 'events'
          ? await countDiscoveryEvents(clients)
          : this.agent === 'monitoring'
          ? await countMonitoringRules(clients)
          : await (await clients.getKnowledgeIndicatorClient()).countKnowledgeIndicators('feature'),
      sources: sources.map(({ id, slug, title, enabled }) => ({ id, slug, title, enabled })),
    };
  }
  getRun(request: KibanaRequest, id: string): Promise<ExplorationRun> {
    return this.store(request).getRun(id);
  }

  async start(
    request: KibanaRequest,
    args: { reason: ExplorationRun['reason']; sourceId?: string }
  ): Promise<ExplorationRun> {
    await this.ensureAgent(request);
    const store = this.store(request);
    const previous = await this.recoverInterrupted(request, store);
    if (previous.state.totalRunDurationMs === undefined) {
      const savedRuns = await store.listRuns();
      const completedRuns = savedRuns.filter((run) => run.finishedAt);
      previous.state.totalRunDurationMs = completedRuns.reduce(
        (total, run) => total + runDurationMs(run),
        0
      );
      previous.state.totalRunDurationSamples = completedRuns.length;
    }
    if (previous.state.activeRunId && (previous.state.leaseUntil ?? 0) > Date.now()) {
      if (args.reason === 'source_added' && args.sourceId) {
        const pending = this.pendingSources.get(request.spaceId) ?? new Set<string>();
        pending.add(args.sourceId);
        this.pendingSources.set(request.spaceId, pending);
      }
      return store.getRun(previous.state.activeRunId);
    }
    if (previous.state.activeRunId) {
      const stale = await store.getRun(previous.state.activeRunId);
      if (stale.status === 'running') {
        stale.status = 'interrupted';
        stale.finishedAt = new Date().toISOString();
        stale.error = 'Worker stopped before completing this run';
        await store.saveRun(stale);
        previous.state.totalCostUsd += stale.estimatedCostUsd;
        previous.state.totalRuns++;
        recordRunDuration(previous.state, stale);
        addTokens(previous.state.totalTokens, stale.tokens);
      }
    }
    const enabledSources = (await this.sources(request)).filter((source) => source.enabled);
    if (!enabledSources.length)
      throw new StatusError('Add an enabled detection source before starting exploration', 409);
    const selected = await this.model(request);
    const pricing = await this.pricing(selected.connectorId, selected.model);
    if (!pricing)
      throw new StatusError(
        'Model pricing is unavailable; choose a priced model so the run cost limit can be enforced',
        409
      );
    const run: ExplorationRun = {
      id: randomUUID(),
      agent: this.agent,
      ...args,
      ...selected,
      status: 'running',
      startedAt: new Date().toISOString(),
      thinking: true,
      limits: enabledSources.some((source) => !previous.state.checkpoints[`${source.id}:novelty`])
        ? { ...initialExplorationLimits }
        : { ...incrementalExplorationLimits },
      summary:
        this.agent === 'events'
          ? 'Assessing recent rule firings'
          : this.agent === 'monitoring'
          ? 'Assessing monitoring coverage'
          : 'Checking for new knowledge',
      steps: [],
      tokens: emptyExplorationTokens(),
      estimatedCostUsd: 0,
      pricing,
      costEstimateComplete: Boolean(pricing),
      written: 0,
      examinedSources: [],
    };
    previous.state.activeRunId = run.id;
    previous.state.leaseUntil = Date.now() + LEASE_MS;
    await store.setState(previous.state, previous.version);
    await store.saveRun(run);
    const controller = new AbortController();
    const promise = this.execute(request, run, previous.state.checkpoints, controller, store)
      .catch((error) => this.server().logger.error(String(error)))
      .finally(() => {
        if (this.active.get(request.spaceId)?.runId === run.id) this.active.delete(request.spaceId);
      });
    this.active.set(request.spaceId, { runId: run.id, controller, promise });
    return run;
  }
  async deleteRun(request: KibanaRequest, id: string): Promise<void> {
    const local = this.active.get(request.spaceId);
    if (local?.runId === id) {
      this.cancel(request);
      await local.promise;
    }
    const store = this.store(request);
    const run = await store.getRun(id);
    const { state, version } = await this.recoverInterrupted(request, store);
    if (run.status === 'running') {
      if (state.activeRunId === id && (state.leaseUntil ?? 0) > Date.now())
        throw new StatusError(
          'Run is still active on another worker; wait for its lease to expire',
          409
        );
      state.totalCostUsd += run.estimatedCostUsd;
      state.totalRuns++;
      recordRunDuration(state, run);
      addTokens(state.totalTokens, run.tokens);
      if (state.activeRunId === id) {
        state.activeRunId = undefined;
        state.leaseUntil = undefined;
      }
      await store.setState(state, version);
    }
    await store.deleteRun(id);
  }

  async wait(request: KibanaRequest, id: string): Promise<ExplorationRun> {
    const local = this.active.get(request.spaceId);
    if (local?.runId === id) await local.promise;
    else {
      const initial = await this.getRun(request, id);
      const deadline =
        Date.parse(initial.startedAt) +
        (initial.limits ?? incrementalExplorationLimits).maxDurationMinutes * 60000 +
        60000;
      while (Date.now() < deadline) {
        const run = await this.getRun(request, id);
        if (run.status !== 'running') return run;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    return this.getRun(request, id);
  }
  cancel(request: KibanaRequest): void {
    this.pendingSources.delete(request.spaceId);
    this.active.get(request.spaceId)?.controller.abort(new Error('Cancelled by user'));
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.pendingSources.clear();
    const runs = [...this.active.values()];
    for (const active of runs) active.controller.abort(new Error('Kibana stopped'));
    await Promise.allSettled(runs.map((active) => active.promise));
  }

  /** Clears feature KIs and novelty checkpoints in this space after an explicit UI confirmation. */
  async resetFeatures(request: KibanaRequest): Promise<{ features: number }> {
    if (this.agent !== 'knowledge') {
      const active = this.active.get(request.spaceId);
      if (active) {
        this.cancel(request);
        await active.promise;
      }
      const current = await this.recoverInterrupted(request, this.store(request));
      if (current.state.activeRunId)
        throw new StatusError('Stop the active worker before resetting monitors', 409);
      const clients = await this.getScopedClients({ request });
      const result =
        this.agent === 'events'
          ? await resetDiscoveryEvents(clients)
          : await resetMonitoringRules(clients);
      current.state.checkpoints = {};
      current.state.remainingGaps = [];
      current.state.samplingAttempts = [];
      await this.store(request).setState(current.state, current.version);
      return result;
    }
    const store = this.store(request);
    const { state } = await store.getState();
    if (state.activeRunId && (state.leaseUntil ?? 0) > Date.now())
      throw new StatusError('Stop the running exploration before resetting knowledge', 409);
    const clients = await this.getScopedClients({ request });
    const client = await clients.getKnowledgeIndicatorClient();
    const sources = await this.sources(request);
    const ids = new Set([
      ...sources.map((source) => source.id),
      ...(await client.getSourceIdsWithKnowledgeIndicators()),
    ]);
    let features = 0;
    for (const id of ids) {
      const result = await client.getFeatures(id, {
        includeExcluded: true,
        includeExpired: true,
        limit: 10000,
      });
      if (result.hits.length) {
        const deleted = await client.bulk(
          id,
          result.hits.map((feature) => ({ delete: { type: 'feature' as const, id: feature.uuid } }))
        );
        features += deleted.applied;
      }
    }
    const latest = await store.getState();
    latest.state.checkpoints = {};
    latest.state.remainingGaps = [];
    latest.state.samplingAttempts = [];
    await store.setState(latest.state, latest.version);
    return { features };
  }

  private async execute(
    request: KibanaRequest,
    run: ExplorationRun,
    checkpoints: import('../../../common/knowledge_exploration').ExplorationState['checkpoints'],
    controller: AbortController,
    store: ExplorationStore
  ): Promise<void> {
    const limits = run.limits ?? incrementalExplorationLimits;
    const timeout = setTimeout(
      () =>
        controller.abort(new Error(`Reached the ${limits.maxDurationMinutes}-minute run limit`)),
      limits.maxDurationMinutes * 60000
    );
    let session:
      | ExplorationToolSession
      | MonitoringToolSession
      | EventDiscoveryToolSession
      | undefined;
    let heartbeatWork = Promise.resolve();
    const heartbeat = setInterval(() => {
      heartbeatWork = heartbeatWork
        .then(async () => {
          const current = await store.getState();
          if (current.state.activeRunId !== run.id) {
            controller.abort(new Error('Run lease was lost'));
            return;
          }
          current.state.leaseUntil = Date.now() + LEASE_MS;
          await store.setState(current.state, current.version);
        })
        .catch((error) => {
          controller.abort(error instanceof Error ? error : new Error(String(error)));
        });
    }, 30000);
    try {
      const clients = await this.getScopedClients({ request });
      const sources = await this.sources(request);
      const Session =
        this.agent === 'events'
          ? EventDiscoveryToolSession
          : this.agent === 'monitoring'
          ? MonitoringToolSession
          : ExplorationToolSession;
      session = new Session(
        this.server(),
        clients,
        request,
        run,
        sources,
        checkpoints,
        controller.signal
      );
      const { state: progress } = await store.getState();
      const samplingPlan = buildSamplingAgenda(
        this.agent,
        sources,
        progress.samplingAttempts ?? [],
        run.sourceId,
        progress.remainingGaps ?? []
      );
      const messages: Message[] = [
        {
          role: MessageRole.User,
          content: JSON.stringify({
            trigger: run.reason,
            prioritySourceId: run.sourceId ?? null,
            lookback:
              this.agent === 'knowledge'
                ? 'Choose explicit time windows using source volume/latency probes; sample historical intervals and scope by service before expensive exploration'
                : 'Agent-selected bounded windows; start small and widen with evidence',
            unfinishedExploration: progress.remainingGaps ?? [],
            previousSamplingAttempts: progress.samplingAttempts ?? [],
            samplingPlan,
            now: run.startedAt,
            limits,
            instruction:
              this.agent === 'events'
                ? 'Assess managed and user rule firings in the last 30 minutes, investigate relevance, preserve active/inactive assessments, then finish_exploration.'
                : this.agent === 'monitoring'
                ? 'Assess source-scoped monitoring coverage, maintain only your native managed Kibana rules, then finish_exploration.'
                : 'Plan volume-informed source sampling first; explore and save evidence-backed knowledge across the estate, then call finish_exploration.',
          }),
        },
      ];
      for (let round = 0; round < limits.maxTurns && !session.finished; round++) {
        controller.signal.throwIfAborted();
        if (
          run.tokens.total >= limits.maxCumulativeTokens ||
          run.estimatedCostUsd >= Math.min(limits.maxEstimatedCostUsd, MAX_AGENT_RUN_COST_USD)
        ) {
          run.outcome = 'partial';
          run.summary =
            run.estimatedCostUsd >= Math.min(limits.maxEstimatedCostUsd, MAX_AGENT_RUN_COST_USD)
              ? 'Estimated cost ceiling reached; saved progress is available for the next run.'
              : 'Cumulative token limit reached; saved progress is available for the next run.';
          break;
        }
        const step = {
          id: randomUUID(),
          kind: 'model' as const,
          name: `Reasoning ${round + 1}`,
          startedAt: new Date().toISOString(),
          durationMs: 0,
          status: 'running' as 'running' | 'completed' | 'partial' | 'failed',
          input: `Context: ${messages.length} messages; thinking enabled`,
          output: '',
        };
        run.steps.push(step);
        await store.saveRun(run);
        const started = Date.now();
        const requestModel = (modelSignal: AbortSignal) =>
          awaitModel(
            clients.inferenceClient.chatComplete({
              connectorId: run.connectorId,
              system: this.systemPrompt,
              messages,
              tools: this.tools,
              reasoning: { enabled: true, effort: 'low' },
              temperature: 1,
              stream: false,
              abortSignal: modelSignal,
              timeout: MAX_MODEL_REQUEST_MS,
              maxRetries: 0,
              cacheControl: { type: 'ephemeral', ttl: '1h' },
              sessionId: `${this.agent}-exploration:${request.spaceId}`,
              metadata: {
                connectorTelemetry: {
                  pluginId: 'nightshift_ki_extraction',
                  aggregateBy: 'nightshift',
                  interactionId: run.id,
                  spaceId: request.spaceId,
                },
              },
            }),
            modelSignal
          );
        let response: Awaited<ReturnType<typeof requestModel>>;
        for (let attempt = 1; ; attempt++) {
          const modelSignal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(MAX_MODEL_REQUEST_MS),
          ]);
          try {
            response = await requestModel(modelSignal);
            break;
          } catch (error) {
            const timedOut =
              !controller.signal.aborted &&
              error instanceof Error &&
              (error.name === 'TimeoutError' || /timeout|timed out/i.test(error.message));
            if (!timedOut || attempt >= MAX_MODEL_ATTEMPTS) throw error;
            // The abandoned request may still be billed without reported usage.
            run.costEstimateComplete = false;
            step.output = `Model request exceeded ${
              MAX_MODEL_REQUEST_MS / 1000
            } seconds; retried (attempt ${attempt + 1}).`;
            await store.saveRun(run);
          }
        }
        const tokens = tokensOf(response.tokens);
        const cost = costOf(run.pricing, tokens);
        if (!response.tokens || cost === undefined) run.costEstimateComplete = false;
        Object.assign(step, {
          durationMs: Date.now() - started,
          status: 'completed',
          output: response.content.slice(0, 12000),
          tokens,
          estimatedCostUsd: cost,
        });
        addTokens(run.tokens, tokens);
        run.estimatedCostUsd += cost ?? 0;
        if (
          !response.tokens ||
          cost === undefined ||
          run.estimatedCostUsd >= MAX_AGENT_RUN_COST_USD
        ) {
          await store.saveRun(run);
          controller.abort(
            new Error(
              !response.tokens || cost === undefined
                ? 'Stopped: reported usage cannot be priced; cost protection is unavailable'
                : 'Stopped: reached the $50 estimated run cost ceiling'
            )
          );
          controller.signal.throwIfAborted();
        }
        if (response.model) run.model = response.model;
        messages.push({
          role: MessageRole.Assistant,
          content: response.content || null,
          toolCalls: response.toolCalls,
        });
        await store.saveRun(run);
        if (!response.toolCalls.length) {
          messages.push({
            role: MessageRole.User,
            content:
              'Continue using tools if useful evidence is still needed. Otherwise call finish_exploration with the actual outcome. This is a tool protocol reminder, not an instruction to end early.',
          });
          continue;
        }
        for (const call of response.toolCalls) {
          controller.signal.throwIfAborted();
          const toolStep = {
            id: call.toolCallId,
            kind: 'tool' as const,
            name: call.function.name,
            startedAt: new Date().toISOString(),
            durationMs: 0,
            status: 'running' as 'running' | 'completed' | 'partial' | 'failed',
            input: JSON.stringify(call.function.arguments).slice(0, 64000),
            output: '',
          };
          run.summary =
            call.function.name === 'knowledge_indicators' &&
            'action' in call.function.arguments &&
            call.function.arguments.action === 'upsert'
              ? 'Saving evidence-backed knowledge'
              : call.function.name === 'source_esql'
              ? 'Inspecting source telemetry'
              : 'Exploring system context';
          run.steps.push(toolStep);
          await store.saveRun(run);
          const toolStarted = Date.now();
          let result;
          try {
            result = await session.execute(call.function.name, call.function.arguments);
            toolStep.status =
              result.failed || result.error
                ? 'failed'
                : Array.isArray(result.rejected) && result.rejected.length > 0
                ? Array.isArray(result.saved) && result.saved.length > 0
                  ? 'partial'
                  : 'failed'
                : result.truncated
                ? 'partial'
                : 'completed';
          } catch (error) {
            result = { error: error instanceof Error ? error.message : String(error) };
            toolStep.status = 'failed';
          }
          toolStep.durationMs = Date.now() - toolStarted;
          toolStep.output = JSON.stringify(result).slice(0, 64000);
          messages.push({
            role: MessageRole.Tool,
            name: call.function.name,
            toolCallId: call.toolCallId,
            response: result,
          });
          run.examinedSources = [...session.examined];
          await store.saveRun(run);
          if (session.blocked) {
            run.outcome = 'partial';
            run.summary =
              'Source reads failed twice. Stopped to avoid spending tokens on repeated errors.';
            session.finished = true;
          }
          if (session.finished) break;
        }
      }
      if (!run.outcome) {
        run.outcome = 'partial';
        run.summary = 'Agent turn limit reached; remaining gaps will be revisited.';
      }
      run.status = 'completed';
    } catch (error) {
      if (run.steps.at(-1)?.kind === 'model' && run.steps.at(-1)?.status === 'running')
        run.costEstimateComplete = false;
      run.outcome = 'partial';
      run.status = controller.signal.aborted ? 'cancelled' : 'failed';
      const timedOut =
        error instanceof Error &&
        (error.name === 'TimeoutError' || /timeout|timed out/i.test(error.message));
      run.error = timedOut
        ? `Model request exceeded ${MAX_MODEL_REQUEST_MS / 1000} seconds`
        : error instanceof Error
        ? error.message
        : String(error);
      run.summary = `${run.error}${
        run.written
          ? `; ${run.written} ${
              this.agent === 'events'
                ? 'event updates'
                : this.agent === 'monitoring'
                ? 'rule changes'
                : 'KI writes'
            } saved. Run again to resume from saved progress.`
          : ''
      }`;
      for (const step of run.steps.filter((item) => item.status === 'running')) {
        step.status = 'failed';
        step.durationMs = Date.now() - Date.parse(step.startedAt);
        step.output = run.error;
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      await heartbeatWork;
      run.finishedAt = new Date().toISOString();
      await store.saveRun(run);
      const latest = await store.getState();
      if (latest.state.activeRunId === run.id) {
        if (
          run.status === 'completed' &&
          run.coverageComplete === true &&
          run.outcome !== 'partial' &&
          session
        )
          Object.assign(latest.state.checkpoints, session.pendingCheckpoints);
        latest.state.samplingAttempts = mergeSamplingAttempts(
          latest.state.samplingAttempts ?? [],
          summarizeSamplingAttempts(run.steps, this.agent)
        );
        latest.state.remainingGaps = run.coverageComplete
          ? []
          : run.remainingGaps ?? progressGaps(run.summary);
        latest.state.activeRunId = undefined;
        latest.state.leaseUntil = undefined;
        latest.state.totalCostUsd += run.estimatedCostUsd;
        if (run.costEstimateComplete === false)
          latest.state.unpricedRuns = (latest.state.unpricedRuns ?? 0) + 1;
        latest.state.totalRuns++;
        recordRunDuration(latest.state, run);
        addTokens(latest.state.totalTokens, run.tokens);
        await store.setState(latest.state, latest.version);
      }
      this.active.delete(request.spaceId);
      const pending = this.pendingSources.get(request.spaceId);
      const next = pending?.values().next().value;
      if (next && !this.stopping) {
        pending?.delete(next);
        void this.start(request, { reason: 'source_added', sourceId: next }).catch((error) =>
          this.server().logger.warn(String(error))
        );
      }
    }
  }
}
