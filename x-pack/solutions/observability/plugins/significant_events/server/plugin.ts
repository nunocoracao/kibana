/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AlertActionsClientApi, AlertEventsClientApi } from '@kbn/alerting-v2-plugin/server';
import { asSpaceId } from '@kbn/core-spaces-common';
import type {
  CoreSetup,
  CoreStart,
  KibanaRequest,
  Logger,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/server';
import { SavedObjectsClient } from '@kbn/core/server';
import { PROJECT_ROUTING_ALL } from '@kbn/cps-server-utils';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import { NIGHTSHIFT_ENABLED_FLAG } from '@kbn/nightshift-shared';
import { registerRoutes } from '@kbn/server-route-repository';
import type { Subscription } from 'rxjs';
import {
  catchError,
  combineLatest,
  distinctUntilChanged,
  exhaustMap,
  filter,
  from,
  of,
  skip,
  switchMap,
  timer,
} from 'rxjs';
import { registerFeatureFlags } from './feature_flags';
import { KnowledgeExplorationService } from './lib/knowledge_exploration/service';
import { explorationSavedObjectTypes } from './lib/knowledge_exploration/store';
import {
  createSourceKnowledgeStateClient,
  SOURCE_KNOWLEDGE_STATE_TYPE,
  SOURCE_WRITE_LEASE_WAIT_MS,
  sourceKnowledgeStateSavedObjectType,
} from './lib/knowledge_indicators/source_knowledge_state';
import {
  createSignificantEventsMaintenanceService,
  type SignificantEventsMaintenanceService,
} from './lib/maintenance/maintenance_service';
import { getSignificantEventsMaintenanceStateSavedObjectType } from './lib/maintenance/saved_object';
import { whenNightshiftTurnsOff } from './lib/maintenance/when_nightshift_turns_off';
import { runQuotaLedgerSavedObjectType, runQuotaSettingsSavedObjectType } from './lib/run_quotas';
import {
  createSeveritySync,
  registerAfterInvestigationHook,
} from './lib/significant_events/events/severity';
import { getSignificantEventsTuningConfig } from './lib/significant_events/helpers/get_significant_events_tuning_config';
import {
  getRelayAppConnectionSavedObjectType,
  RELAY_APP_CONNECTION_SO_TYPE,
} from './lib/slack_app/saved_object';
import { SlackAppService } from './lib/slack_app/service';
import {
  createManagedWorkflowsInstaller,
  type ManagedWorkflowsInstaller,
} from './lib/workflows/setup/managed_workflows_installer';
import { reconcileSourceCatalog } from './routes/internal/knowledge_indicators/reconcile_source_catalog';

import type { SignificantEventsAlertingContext } from './lib/significant_events/alerting/significant_events_alerting_context';
import { createSignificantEventsAlertingContextResolver } from './lib/significant_events/alerting/significant_events_alerting_context';

import { SIGNIFICANT_EVENT_TIERED_FEATURES } from '../common/constants';
import { registerStreamsAgentBuilder } from './agent_builder/register';
import { registerSignificantEventsSkills } from './agent_builder/skills/register_skills';
import { registerAgentBuilderSmlTypes } from './agent_builder/sml/register_sml_types';
import { createSignificantEventsAvailability } from './agent_builder/tools/significant_events_availability';
import { createPriceService } from './lib/cost/price_service';
import {
  type KnowledgeIndicatorClient,
  knowledgeIndicatorsDataStream,
  KnowledgeIndicatorService,
  TopologySnapshotClient,
} from './lib/knowledge_indicators';
import { detectionsDataStream } from './lib/significant_events/detections';
import {
  createSignificantEventsClients,
  createSignificantEventsServices,
} from './lib/significant_events/significant_events_clients';
import { getDetectionSnapshotKnowledgeCounts } from './lib/telemetry/detection_snapshot_contributor';
import { EbtTelemetryService } from './lib/telemetry/ebt';
import { type CleanupWorkflowService } from './lib/workflows/cleanup_workflow';
import { type ContinuousOnboardingWorkflowService } from './lib/workflows/continuous_onboarding_workflow';
import { createWorkflowClients } from './lib/workflows/create_workflow_clients';
import type { SignificantEventsKIsOnboardingClient } from './lib/workflows/onboarding_workflow_client';
import { type SignificantEventsScheduledWorkflowsService } from './lib/workflows/significant_events_scheduled_workflows';
import { type SyncWorkflowService } from './lib/workflows/sync_workflow';
import { significantEventsRouteRepository } from './routes';
import type { GetScopedClients, RouteHandlerScopedClients } from './routes/types';
import { isSignificantEventsAvailable } from './routes/utils/assert_significant_events_access';
import { getRequestAbortSignal } from './routes/utils/get_request_abort_signal';
import { classifyDetectionsStepDefinition } from './step_definitions/classify_detections';
import { resolveModelStepDefinition } from './step_definitions/resolve_model';
import type {
  SignificantEventsPluginSetupDependencies,
  SignificantEventsPluginStartDependencies,
  SignificantEventsServer,
} from './types';
import { createTriggerEmitter } from './workflows/triggers/emit';
import { registerSignificantEventsWorkflowTriggers } from './workflows/triggers/register_triggers';

const SIGNIFICANT_EVENTS_MANAGED_WORKFLOW_OWNER = 'significantEvents';
const SLACK_CONNECTOR_RECONCILE_INTERVAL_MS = 60_000;
const RULE_CREATION_APP = 'nightshift';

export class SignificantEventsPlugin
  implements
    Plugin<
      void,
      void,
      SignificantEventsPluginSetupDependencies,
      SignificantEventsPluginStartDependencies
    >
{
  public logger: Logger;
  public server?: SignificantEventsServer;
  private isDev: boolean;
  private ebtTelemetryService = new EbtTelemetryService();
  private getScopedClients?: GetScopedClients;
  private subscriptions: Subscription[] = [];
  private kibanaVersion: string;
  private streamsKIsOnboardingClient?: SignificantEventsKIsOnboardingClient;
  private managedWorkflowsInstaller?: ManagedWorkflowsInstaller;
  private maintenanceService?: SignificantEventsMaintenanceService;
  constructor(context: PluginInitializerContext) {
    this.isDev = context.env.mode.dev;
    this.logger = context.logger.get();
    this.kibanaVersion = context.env.packageInfo.version;
  }

  public setup(
    core: CoreSetup<SignificantEventsPluginStartDependencies>,
    plugins: SignificantEventsPluginSetupDependencies
  ): void {
    this.server = {
      logger: this.logger,
      workflowsManagement: plugins.workflowsManagement,
      cloud: plugins.cloud,
      kibanaVersion: this.kibanaVersion,
      severitySync: createSeveritySync({
        getAgenticInvestigations: () => this.server?.agenticInvestigations,
        logger: this.logger,
      }),
    } as SignificantEventsServer;
    this.server.workflowsManagement = plugins.workflowsManagement;

    core.savedObjects.registerType(explorationSavedObjectTypes[0]);
    core.savedObjects.registerType(explorationSavedObjectTypes[1]);
    core.savedObjects.registerType(getRelayAppConnectionSavedObjectType());
    core.savedObjects.registerType(getSignificantEventsMaintenanceStateSavedObjectType());
    core.savedObjects.registerType(sourceKnowledgeStateSavedObjectType);
    core.savedObjects.registerType(runQuotaSettingsSavedObjectType);
    core.savedObjects.registerType(runQuotaLedgerSavedObjectType);

    plugins.nightshiftInvestigations?.registerDetectionSnapshotContributor(
      async ({ spaceId, request, signal }) => {
        const [coreStart, pluginsStart] = await core.getStartServices();
        return getDetectionSnapshotKnowledgeCounts({
          signal,
          esClient: coreStart.elasticsearch.client.asInternalUser,
          rulesClient: await pluginsStart.alertingVTwo.getRulesClientWithRequestInSpace(
            request,
            asSpaceId(spaceId)
          ),
          space: spaceId,
          logger: this.logger.get('knowledge_indicators'),
        });
      }
    );

    core.dataStreams.registerDataStream(detectionsDataStream);
    core.dataStreams.registerDataStream(knowledgeIndicatorsDataStream);

    this.ebtTelemetryService.setup(
      core.analytics,
      {
        cpsEnabled: plugins.cps?.getCpsEnabled() ?? false,
        originProjectId: plugins.cloud?.serverless.projectId,
        getLinkedProjectIds: async (request) => {
          const [, pluginsStart] = await core.getStartServices();
          const linkedProjects = await pluginsStart.cps?.getLinkedProjects(request);
          return linkedProjects?.map(({ id }) => id);
        },
      },
      this.logger.get('telemetry')
    );

    const significantEventsServices = createSignificantEventsServices();
    const knowledgeIndicatorService = new KnowledgeIndicatorService(core, this.logger);
    this.getScopedClients = async ({
      request,
    }: {
      request: KibanaRequest;
    }): Promise<RouteHandlerScopedClients> => {
      const [coreStart, pluginsStart] = await core.getStartServices();
      const cpsEnabled = plugins.cps?.getCpsEnabled() ?? false;

      const scopedSoClient = coreStart.savedObjects.getScopedClient(request);
      const uiSettingsClient = coreStart.uiSettings.asScopedToClient(scopedSoClient);
      const globalUiSettingsClient = coreStart.uiSettings.globalAsScopedToClient(scopedSoClient);

      // `scopedClusterClient`: origin-only. Used for everything the plugin owns (its hidden
      // data streams), which only ever exists in the origin project.
      // `streamDataEsClient`: always routed across every CPS-linked project, regardless of the
      // active space's project routing expression. Knowledge indicators are stored per space,
      // but they model all data available to a source, so extraction must always read across
      // every linked project.
      //
      // Detection matches that all-projects scope when CPS is enabled via `withAllProjectsRouting`.
      const scopedClusterClient = coreStart.elasticsearch.client.asScoped(request);
      const streamDataEsClient = coreStart.elasticsearch.client.asScoped(request, {
        projectRouting: 'expression',
        value: PROJECT_ROUTING_ALL,
      }).asCurrentUser;
      const soClient = scopedSoClient;
      const inferenceClient = pluginsStart.inference.getClient({ request });
      const licensing = pluginsStart.licensing;
      const fieldsMetadataClient = await pluginsStart.fieldsMetadata.getClient(request);

      const [tuningConfig, sourcesClient] = await Promise.all([
        getSignificantEventsTuningConfig(globalUiSettingsClient, this.logger),
        pluginsStart.nightshiftSources.getSourcesClient({ request }),
      ]);

      // Core always populates `request.spaceId` (default space when the URL has no prefix), so
      // no fallback is needed. Knowledge indicators and their rules are scoped to this space.
      const space = request.spaceId;

      let alertEventsClientPromise: Promise<AlertEventsClientApi> | undefined;
      const getAlertEventsClient = (): Promise<AlertEventsClientApi> => {
        alertEventsClientPromise ??=
          pluginsStart.alertingVTwo.getAlertEventsClientWithRequest(request);
        return alertEventsClientPromise;
      };

      let alertActionsClientPromise: Promise<AlertActionsClientApi> | undefined;
      const getAlertActionsClient = (): Promise<AlertActionsClientApi> => {
        alertActionsClientPromise ??=
          pluginsStart.alertingVTwo.getAlertActionsClientWithRequest(request);
        return alertActionsClientPromise;
      };

      const significantEventsClients = createSignificantEventsClients({
        services: significantEventsServices,
        dataStreams: coreStart.dataStreams,
        esClient: scopedClusterClient.asCurrentUser,
        internalEsClient: scopedClusterClient.asInternalUser,
        logger: this.logger,
        space,
        getAlertEventsClient,
        getAlertActionsClient,
        triggerEmitter: createTriggerEmitter({
          workflowsExtensions: pluginsStart.workflowsExtensions,
          request,
          logger: this.logger,
        }),
        telemetry: {
          trackEventStatusChanged: (params) =>
            this.ebtTelemetryService.getClient().trackEventStatusChanged(params, request),
          logger: this.logger,
        },
      });

      const getAlertingV2RulesClient = async () =>
        pluginsStart.alertingVTwo.getRulesClientWithRequestInSpace(request, space, {
          app: RULE_CREATION_APP,
        });

      const resolveSignificantEventsAlertingContext =
        createSignificantEventsAlertingContextResolver({
          getAlertingV2RulesClient,
          cpsEnabled,
        });

      const sourceKnowledgeState = createSourceKnowledgeStateClient({
        repository: coreStart.savedObjects.createInternalRepository([SOURCE_KNOWLEDGE_STATE_TYPE]),
        space,
        sourcesClient,
      });
      const createKnowledgeIndicatorClient = (
        context: SignificantEventsAlertingContext,
        source?: NightshiftSource
      ) =>
        knowledgeIndicatorService.getClient({
          esClient: scopedClusterClient.asInternalUser,
          soClient,
          space,
          context,
          config: tuningConfig,
          withSourceWrite: (sourceId, run, options) => {
            const shouldWaitForLease = options?.waitForLease !== false;
            return sourceKnowledgeState.write({
              sourceId,
              allowDisabled: options?.allowDisabled,
              waitForLeaseMs: shouldWaitForLease ? SOURCE_WRITE_LEASE_WAIT_MS : undefined,
              signal: shouldWaitForLease ? getRequestAbortSignal(request) : undefined,
              expectedRevision:
                typeof request.headers['x-nightshift-source-revision'] === 'string' &&
                request.headers['x-nightshift-source-revision']
                  ? request.headers['x-nightshift-source-revision']
                  : source?.esql_updated_at,
              run,
            });
          },
        });

      let kiClientPromise: ReturnType<typeof createKnowledgeIndicatorClient> | undefined;
      const getKnowledgeIndicatorClient = async (
        source?: NightshiftSource
      ): Promise<KnowledgeIndicatorClient> => {
        if (source) {
          return createKnowledgeIndicatorClient(
            await resolveSignificantEventsAlertingContext(),
            source
          );
        }
        kiClientPromise ??= (async () =>
          createKnowledgeIndicatorClient(await resolveSignificantEventsAlertingContext()))();
        return kiClientPromise;
      };

      const getTopologySnapshotClient = async (): Promise<TopologySnapshotClient> =>
        new TopologySnapshotClient({
          reader: await getKnowledgeIndicatorClient(),
          logger: this.logger.get('topology'),
        });

      const license = await licensing.getLicense();
      const isSecurityEnabled = license.getFeature('security').isEnabled;

      return {
        scopedClusterClient,
        streamDataEsClient,
        soClient,
        space,
        getSignificantEventsAlertingContext: resolveSignificantEventsAlertingContext,
        getKnowledgeIndicatorClient,
        getTopologySnapshotClient,
        sourceKnowledgeState,
        scheduleSourceOnboarding: async () => false,
        getAlertEventsClient,
        getAlertActionsClient,
        ...significantEventsClients,
        inferenceClient,
        fieldsMetadataClient,
        sourcesClient,
        licensing,
        uiSettingsClient,
        globalUiSettingsClient,
        isSecurityEnabled,
        tuningConfig,
      };
    };

    const telemetryClient = this.ebtTelemetryService.getClient();

    const workflowClients = createWorkflowClients(
      plugins.workflowsManagement?.management,
      telemetryClient,
      this.logger,
      async (request) => {
        const [, pluginsStart] = await core.getStartServices();
        return pluginsStart.nightshiftSources.getSourcesClient({ request });
      }
    );
    const streamsKIsOnboardingClient = workflowClients.streamsKIsOnboardingClient;
    this.streamsKIsOnboardingClient = streamsKIsOnboardingClient;

    if (plugins.agentBuilderSml && this.getScopedClients) {
      registerAgentBuilderSmlTypes({
        agentBuilderSml: plugins.agentBuilderSml,
        getScopedClients: this.getScopedClients,
        isAvailable: async () => {
          const [, pluginsStart] = await core.getStartServices();
          return this.server
            ? isSignificantEventsAvailable({
                server: this.server,
                licensing: pluginsStart.licensing,
              })
            : false;
        },
      });
    }

    if (plugins.agentBuilder) {
      registerAfterInvestigationHook({
        agentBuilder: plugins.agentBuilder,
        logger: this.logger.get('afterInvestigation'),
        getDeps: () => {
          const { getScopedClients, server } = this;
          if (!getScopedClients || !server) return undefined;
          return {
            agenticInvestigations: server.agenticInvestigations,
            severitySync: server.severitySync,
            getEventClient: async (request) =>
              (await getScopedClients({ request })).getEventSearchClient(),
          };
        },
      });
      void core
        .getStartServices()
        .then(async () => {
          const { getScopedClients, server, maintenanceService } = this;
          if (!getScopedClients || !server || !maintenanceService) return;
          await registerStreamsAgentBuilder({
            agentBuilder: plugins.agentBuilder!,
            getScopedClients,
            server,
            logger: this.logger,
            telemetry: telemetryClient,
            maintenanceService,
          });
        })
        .catch((err) => {
          this.logger.error(`Failed to register agent builder: ${err.message}`);
        });
    }

    let continuousOnboardingWorkflowService: ContinuousOnboardingWorkflowService | undefined;
    let syncWorkflowService: SyncWorkflowService | undefined;
    let cleanupWorkflowService: CleanupWorkflowService | undefined;
    let significantEventsScheduledWorkflowsService:
      | SignificantEventsScheduledWorkflowsService
      | undefined;

    plugins.workflowsExtensions?.registerManagedWorkflowOwner(
      SIGNIFICANT_EVENTS_MANAGED_WORKFLOW_OWNER
    );
    plugins.workflowsExtensions?.registerStepDefinition(
      resolveModelStepDefinition({
        getInference: () => this.server?.inference,
        getSavedObjects: () => this.server?.core?.savedObjects,
        getUiSettings: () => this.server?.core?.uiSettings,
        logger: this.logger.get('resolve_model'),
      })
    );
    plugins.workflowsExtensions?.registerStepDefinition(
      classifyDetectionsStepDefinition({ logger: this.logger.get('classify_detections') })
    );

    // Custom event-driven triggers users can subscribe to from their own workflows.
    registerSignificantEventsWorkflowTriggers(plugins.workflowsExtensions);

    plugins.taskManager.registerTaskDefinitions({
      'nightshiftProblemAgent:run': {
        title: 'Nightshift Problem Agent',
        description: 'Runs the unified problem agent with the scheduling user credentials.',
        timeout: '22m',
        createTaskRunner: ({ taskInstance, fakeRequest, signal }) => ({
          run: async () => {
            if (!fakeRequest)
              throw new Error(
                'Problem agent schedule has no credentials; save the schedule again.'
              );
            const agent = this.server?.problemAgent;
            if (
              !agent ||
              !(await agent.hourlyEnabled(fakeRequest)) ||
              !(await agent.sources(fakeRequest)).some((source) => source.enabled) ||
              (await this.maintenanceService?.getState({ request: fakeRequest })) === 'paused' ||
              !this.server ||
              !(await isSignificantEventsAvailable({
                server: this.server,
                licensing: this.server.licensing,
              }))
            )
              return { state: taskInstance.state };
            const run = await agent.start(fakeRequest, { reason: 'hourly' });
            if (run.reason !== 'hourly') return { state: taskInstance.state };
            const cancel = () => agent.cancel(fakeRequest);
            signal.addEventListener('abort', cancel, { once: true });
            try {
              await agent.wait(fakeRequest, run.id);
            } finally {
              signal.removeEventListener('abort', cancel);
            }
            return { state: taskInstance.state };
          },
        }),
      },
    });

    core.pricing.registerProductFeatures(SIGNIFICANT_EVENT_TIERED_FEATURES);
    registerFeatureFlags(core, this.logger, plugins.cloud);

    this.maintenanceService = createSignificantEventsMaintenanceService({
      logger: this.logger,
      server: this.server,
      getScopedClients: this.getScopedClients,
      internalRuleBackedRules: {
        listRuleIds: async (spaceId) => {
          const [coreStart] = await core.getStartServices();
          return knowledgeIndicatorService.listRuleBackedRuleIds({
            esClient: coreStart.elasticsearch.client.asInternalUser,
            space: spaceId,
          });
        },
        bulkDisableRules: async (params) => {
          const [, pluginsStart] = await core.getStartServices();
          const rulesClient = await pluginsStart.alertingVTwo.getUnsafeInternalRulesClient();
          return rulesClient.bulkDisableRules(params);
        },
      },
    });

    plugins.nightshiftSources.onSourceChange(async (event) => {
      this.server?.problemAgent?.cancel(event.request);
      const clients = await this.getScopedClients!({ request: event.request });
      await reconcileSourceCatalog({
        sourcesClient: clients.sourcesClient,
        kiClient: await clients.getKnowledgeIndicatorClient(),
        sourceKnowledgeState: clients.sourceKnowledgeState,
        maintenanceService: this.maintenanceService!,
        request: event.request,
      });
    });

    const priceService = createPriceService({
      fetchFn: fetch,
      getNow: () => new Date(),
      logger: this.logger.get('cost'),
      timeoutMs: 10_000,
      cacheTtlMs: 6 * 60 * 60 * 1000,
      maxBodyBytes: 4 * 1024 * 1024,
      maxScopedRows: 10_000,
      baseUrl: plugins.cloud?.baseUrl ?? 'https://cloud.elastic.co',
    });

    this.server.problemAgent = new KnowledgeExplorationService(
      () => this.server,
      this.getScopedClients,
      () => priceService
    );

    registerRoutes({
      repository: significantEventsRouteRepository,
      dependencies: {
        server: this.server,
        telemetry: telemetryClient,
        getScopedClients: this.getScopedClients,
        continuousOnboardingWorkflowService,
        syncWorkflowService,
        cleanupWorkflowService,
        significantEventsScheduledWorkflowsService,
        workflowClients,
        maintenanceService: this.maintenanceService,
        priceService,
        // Same resolution as the knowledge indicator space above; core always populates it.
        getSpaceId: async (request: KibanaRequest) => request.spaceId,
      },
      core,
      logger: this.logger,
      runDevModeChecks: this.isDev,
    });
  }

  public start(core: CoreStart, plugins: SignificantEventsPluginStartDependencies): void {
    if (this.server) {
      this.server.core = core;
      this.server.taskManager = plugins.taskManager;
      this.server.isServerless = this.server.cloud?.isServerlessEnabled ?? false;
      this.server.security = plugins.security;
      this.server.actions = plugins.actions;
      this.server.encryptedSavedObjects = plugins.encryptedSavedObjects;
      this.server.inference = plugins.inference;
      this.server.licensing = plugins.licensing;
      this.server.spaces = plugins.spaces;
      this.server.workflowsExtensions = plugins.workflowsExtensions;
      this.server.agentBuilder = plugins.agentBuilder;
      this.server.nightshiftInvestigations = plugins.nightshiftInvestigations;
      this.server.agenticInvestigations = plugins.agenticInvestigations;

      this.server.relayClient = plugins.actions.getRelayClient();

      // The Elastic Slack connector is in-memory, so it survives neither a restart nor a connect
      // handled by another node. The connection document is namespace-agnostic, so one internal
      // client covers the deployment. Relay config is static at start, so skip the poller when the
      // client is absent rather than ticking a reconcile loop that can never do anything.
      if (this.server.relayClient) {
        const slackAppService = new SlackAppService(this.server);
        const soClient = new SavedObjectsClient(
          core.savedObjects.createInternalRepository([RELAY_APP_CONNECTION_SO_TYPE])
        );

        // `timer(0, …)` makes the first tick the startup restore. `catchError` must stay inside the
        // inner observable — outside, one failed tick would end the loop for the process's lifetime.
        this.subscriptions.push(
          timer(0, SLACK_CONNECTOR_RECONCILE_INTERVAL_MS)
            .pipe(
              exhaustMap(() =>
                from(slackAppService.reconcileConnector(soClient)).pipe(
                  catchError((error: unknown) => {
                    this.logger.warn(
                      `Failed to reconcile the Elastic Slack connector: ${
                        error instanceof Error ? error.message : String(error)
                      }`
                    );
                    return of(undefined);
                  })
                )
              )
            )
            .subscribe()
        );
      }
    }

    // Availability is the same requirement registry that gates requests, so a deployment never gets
    // resources it cannot run. Only the flag and the license change at runtime, so only those feed
    // the stream.
    const isAvailable = () =>
      this.server
        ? isSignificantEventsAvailable({ server: this.server, licensing: plugins.licensing })
        : Promise.resolve(false);
    const available$ = combineLatest([
      core.featureFlags.getBooleanValue$(NIGHTSHIFT_ENABLED_FLAG, false),
      plugins.licensing.license$,
    ]).pipe(switchMap(isAvailable), distinctUntilChanged());

    // The availability observable emits its current value on subscribe. `skip(1)` drops that
    // initial emission so the stream represents *changes* only; the initial install/registration is
    // driven explicitly below. `filter((enabled) => enabled)` then keeps only the off->on
    // transitions, since installation only ever adds resources (a flip back to off is handled by
    // request-time gating).
    const availabilityEnabled$ = available$.pipe(
      skip(1),
      filter((enabled) => enabled)
    );

    // Managed workflows go through a single serialized installer that owns the only `ready()` call,
    // so a runtime flag flip can never close the reconciliation window with a partial set (which
    // would prune the owner's other workflows). Created here so the availability path below reuses
    // the same instance.
    if (plugins.workflowsExtensions) {
      const { workflowsExtensions } = plugins;
      this.managedWorkflowsInstaller = createManagedWorkflowsInstaller({
        getClient: () =>
          workflowsExtensions.initManagedWorkflowsClient(SIGNIFICANT_EVENTS_MANAGED_WORKFLOW_OWNER),
        dataStreams: core.dataStreams,
        isAvailable,
        logger: this.logger,
      });
    }

    void this.ensureSignificantEventsInstalled(isAvailable).catch((error: unknown) => {
      this.logManagedResourceError('startup', error);
    });

    this.subscriptions.push(
      availabilityEnabled$.subscribe(() => {
        void this.ensureSignificantEventsInstalled(isAvailable).catch((error: unknown) => {
          this.logManagedResourceError('availability flag change', error);
        });
      })
    );

    // Turning Nightshift off at runtime (once the value settles) pauses background activity.
    // Turning it back on leaves the pause in place (the install above re-asserts it) until a
    // user resumes.
    this.subscriptions.push(
      whenNightshiftTurnsOff(
        core.featureFlags.getBooleanValue$(NIGHTSHIFT_ENABLED_FLAG, false)
      ).subscribe(() => {
        void this.maintenanceService?.pauseOnFlagOff().catch((error: unknown) => {
          this.logFlagOffPauseError(error);
        });
      })
    );

    // Editable discovery agents: installed via agents.ensure when significant events is
    // available. skip(1) on availabilityEnabled$ drops the initial emission, so catch up at
    // startup as well. Per-space installs also happen just-in-time from scheduled discovery
    // enablement and manual discovery execute, and for the feature identification and KI query
    // generation agents from the routes that run them.
    // Pause re-assert runs inside ensureSignificantEventsInstalled after every install.
    if (plugins.agentBuilder && this.server && this.getScopedClients) {
      const agentBuilder = plugins.agentBuilder;
      const telemetry = this.ebtTelemetryService.getClient();

      // Managed resources (templates + workflows) and agent-builder skills install on independent
      // async paths, so on a runtime flip skills can be advertised a moment before their templates and
      // workflows finish installing. We accept that transient window rather than serializing skills
      // behind the installer: every installer is idempotent and self-heals, request-time gating
      // (assertSignificantEventsAccess) already blocks calls until the feature is truly available, and
      // runtime flips are rare admin actions. On a normal boot with the flag already on there is no
      // window, since installation runs before any request can reach a skill.

      // Core skills (including investigation): registered through the start-phase skills API, gated
      // by the availability flag and (re)registered when the flag flips on.
      registerSignificantEventsSkills({
        agentBuilder,
        telemetry,
        streamsKIsOnboardingClient: this.streamsKIsOnboardingClient,
        maintenanceService: this.maintenanceService,
        getScopedClients: this.getScopedClients,
        server: this.server,
        logger: this.logger,
        isAvailable,
        availability: createSignificantEventsAvailability({
          server: this.server,
          logger: this.logger,
        }),
      })
        .then(({ ensureRegistered }) => {
          const onFlip = () => {
            void ensureRegistered().catch((error: unknown) => {
              this.logSkillsRegistrationError('core', error);
            });
          };
          this.subscriptions.push(availabilityEnabled$.subscribe(onFlip));
          // The availability flag may have flipped between the initial registration inside the
          // registrar and this subscription; `skip(1)` would have dropped that emission, so re-check
          // current state once now. `ensureRegistered` is idempotent, so this is a no-op when
          // nothing changed.
          onFlip();
        })
        .catch((err) => {
          this.logger.error(`Failed to register significant events skills: ${err.message}`);
        });
    }
  }

  private async ensureSignificantEventsInstalled(
    isAvailable: () => Promise<boolean>
  ): Promise<void> {
    if (!(await isAvailable())) {
      this.logger.debug(
        'significantEvents: availability flag disabled, skipping managed resource installation'
      );
      return;
    }

    try {
      await this.managedWorkflowsInstaller?.install();
    } finally {
      // A partial install can still leave workflows enabled in a paused space.
      await this.reassertPauseAfterWorkflowInstall();
    }
  }

  private async reassertPauseAfterWorkflowInstall(): Promise<void> {
    if (!this.maintenanceService) {
      return;
    }
    // Propagate failures: swallowing them lets install succeed while newly
    // installed workflows stay enabled in a paused space.
    await this.maintenanceService.reassertPause();
  }

  private logManagedResourceError(context: string, error: unknown): void {
    this.logger.error(
      `significantEvents: failed to install managed resources (${context}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  private logFlagOffPauseError(error: unknown): void {
    this.logger.error(
      `significantEvents: failed to pause after nightshift was turned off: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  private logSkillsRegistrationError(scope: string, error: unknown): void {
    this.logger.error(
      `significantEvents: failed to register ${scope} skills: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  public async stop() {
    await this.server?.problemAgent?.stop();
    this.subscriptions.forEach((s) => s.unsubscribe());
  }
}
