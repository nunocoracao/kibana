/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest, Logger } from '@kbn/core/server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import {
  SIGNIFICANT_EVENTS_KI_CONTINUOUS_ONBOARDING_WORKFLOW_ID,
  getManagedWorkflowDefinition,
  SIGNIFICANT_EVENTS_MONITORING_SETUP_HOURLY_WORKFLOW_ID,
  SIGNIFICANT_EVENTS_EVENT_DISCOVERY_HOURLY_WORKFLOW_ID,
} from '@kbn/workflows/managed';
import { createContinuousOnboardingWorkflowService } from './continuous_onboarding_workflow';
import type { SignificantEventsKIsOnboardingClient } from './onboarding_workflow_client';

describe.each([
  SIGNIFICANT_EVENTS_KI_CONTINUOUS_ONBOARDING_WORKFLOW_ID,
  SIGNIFICANT_EVENTS_MONITORING_SETUP_HOURLY_WORKFLOW_ID,
  SIGNIFICANT_EVENTS_EVENT_DISCOVERY_HOURLY_WORKFLOW_ID,
])('Agent schedule %s', (id) => {
  const definition = getManagedWorkflowDefinition(id);
  const render = (intervalMinutes?: number): string => {
    if (!definition?.yamlTemplate) throw new Error('Missing agent schedule template');
    return definition.yamlTemplate(intervalMinutes === undefined ? {} : { intervalMinutes });
  };

  it('preserves the existing hourly schedule for older installs', () => {
    expect(render()).toContain("every: '60m'");
  });

  it.each([1, 7, 90, 10080])(
    'renders a %i-minute cadence without changing run concurrency',
    (minutes) => {
      const yaml = render(minutes);
      expect(yaml).toContain(`every: '${minutes}m'`);
      expect(yaml).toContain('strategy: drop');
      expect(yaml).toContain('max: 1');
      expect(yaml).toContain('enabled: false');
      expect(yaml).not.toContain('__EXPLORATION_INTERVAL_MINUTES__');
      expect(yaml).not.toContain('_extraction/_eligible');
    }
  );
});

describe('createContinuousOnboardingWorkflowService', () => {
  const request = {} as KibanaRequest;
  const spaceId = 'space-a';
  const workflowDocumentId = `${SIGNIFICANT_EVENTS_KI_CONTINUOUS_ONBOARDING_WORKFLOW_ID}-${spaceId}`;
  const managedWorkflowOptions = {
    spaceId,
    workflowIdSuffix: spaceId,
    values: { intervalMinutes: 60 },
  };

  let logger: Logger;
  let getWorkflow: jest.Mock;
  // The legacy unsuffixed document is read through the management API, the space document
  // through the request-scoped client.
  let getLegacyWorkflow: jest.Mock;
  let managementApi: jest.Mocked<WorkflowsServerPluginSetup['management']>;
  let managedWorkflowsClient: { install: jest.Mock; uninstall: jest.Mock };

  beforeEach(() => {
    logger = {
      get: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as unknown as Logger;
    (logger.get as jest.Mock).mockReturnValue(logger);
    getWorkflow = jest.fn();
    getLegacyWorkflow = jest.fn().mockResolvedValue(null);
    managementApi = {
      getClient: jest.fn(() => ({ getWorkflow })),
      getWorkflow: getLegacyWorkflow,
      updateWorkflow: jest.fn().mockResolvedValue(undefined),
      getWorkflowExecutions: jest.fn().mockResolvedValue({ results: [], total: 0 }),
      cancelWorkflowExecution: jest.fn().mockResolvedValue(undefined),
      cancelAllActiveWorkflowExecutions: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<WorkflowsServerPluginSetup['management']>;
    managedWorkflowsClient = {
      install: jest.fn().mockResolvedValue(undefined),
      uninstall: jest.fn().mockResolvedValue(undefined),
    };
  });

  const createService = () =>
    createContinuousOnboardingWorkflowService({
      logger,
      managementApi,
      streamsKIsOnboardingClient: {
        cancelAllRunning: jest.fn().mockResolvedValue(0),
      } as unknown as SignificantEventsKIsOnboardingClient,
      getManagedWorkflowsClient: jest.fn().mockResolvedValue(managedWorkflowsClient),
    });

  it('installs and enables the space document when turned on', async () => {
    getWorkflow.mockResolvedValue({ enabled: false });

    await createService().ensureWorkflow({ enabled: true, request, spaceId });

    expect(managedWorkflowsClient.install).toHaveBeenCalledWith(
      SIGNIFICANT_EVENTS_KI_CONTINUOUS_ONBOARDING_WORKFLOW_ID,
      managedWorkflowOptions
    );
    expect(getWorkflow).toHaveBeenCalledWith(workflowDocumentId, spaceId);
    expect(managementApi.updateWorkflow).toHaveBeenCalledWith(
      workflowDocumentId,
      { enabled: true },
      spaceId,
      request
    );
  });

  it('updates the cadence while keeping an already enabled workflow enabled', async () => {
    getWorkflow.mockResolvedValue({ enabled: true });
    await createService().ensureWorkflow({ enabled: true, intervalMinutes: 7, request, spaceId });
    expect(managedWorkflowsClient.install).toHaveBeenCalledWith(
      SIGNIFICANT_EVENTS_KI_CONTINUOUS_ONBOARDING_WORKFLOW_ID,
      { spaceId, workflowIdSuffix: spaceId, values: { intervalMinutes: 7 } }
    );
    expect(managementApi.updateWorkflow).not.toHaveBeenCalled();
  });

  it('uses the saved cadence when a source change reconciles the workflow', async () => {
    getWorkflow.mockResolvedValue({ enabled: true });
    const service = createContinuousOnboardingWorkflowService({
      logger,
      managementApi,
      streamsKIsOnboardingClient: {
        cancelAllRunning: jest.fn(),
      } as unknown as SignificantEventsKIsOnboardingClient,
      getManagedWorkflowsClient: jest.fn().mockResolvedValue(managedWorkflowsClient),
      getIntervalMinutes: async () => 17,
    });
    await service.ensureWorkflow({ enabled: true, request, spaceId });
    expect(managedWorkflowsClient.install).toHaveBeenCalledWith(
      SIGNIFICANT_EVENTS_KI_CONTINUOUS_ONBOARDING_WORKFLOW_ID,
      { spaceId, workflowIdSuffix: spaceId, values: { intervalMinutes: 17 } }
    );
  });

  it('throws when turned on and the document is missing after install', async () => {
    getWorkflow.mockResolvedValue(undefined);

    await expect(
      createService().ensureWorkflow({ enabled: true, request, spaceId })
    ).rejects.toThrow(
      `Managed continuous onboarding workflow ${workflowDocumentId} is not installed yet`
    );
    expect(managementApi.updateWorkflow).not.toHaveBeenCalled();
  });

  it('throws when disabling fails', async () => {
    getWorkflow.mockResolvedValue({ enabled: true });
    managementApi.updateWorkflow.mockRejectedValue(new Error('update failed'));

    await expect(
      createService().ensureWorkflow({ enabled: false, request, spaceId })
    ).rejects.toThrow('update failed');
  });

  it('disables and drains the space document but keeps it when turned off', async () => {
    getWorkflow.mockResolvedValue({ enabled: true });
    (managementApi.getWorkflowExecutions as jest.Mock)
      .mockResolvedValueOnce({ results: [{ id: 'exec-1' }], total: 1 })
      .mockResolvedValue({ results: [], total: 0 });

    await createService().ensureWorkflow({ enabled: false, request, spaceId });

    expect(managementApi.updateWorkflow).toHaveBeenCalledWith(
      workflowDocumentId,
      { enabled: false },
      spaceId,
      request
    );
    expect(managementApi.cancelWorkflowExecution).toHaveBeenCalledWith('exec-1', spaceId, request);
    expect(managedWorkflowsClient.install).not.toHaveBeenCalled();
    expect(managedWorkflowsClient.uninstall).not.toHaveBeenCalled();
  });

  it('leaves the legacy default-space document alone outside the default space', async () => {
    getWorkflow.mockResolvedValue({ enabled: false });

    await createService().ensureWorkflow({ enabled: true, request, spaceId });

    expect(getLegacyWorkflow).not.toHaveBeenCalled();
    expect(managedWorkflowsClient.uninstall).not.toHaveBeenCalled();
  });

  describe('in the default space', () => {
    const defaultSpaceId = 'default';

    it.each([
      { label: 'on', enabled: true, current: false },
      { label: 'off', enabled: false, current: true },
    ])(
      'stops and removes the legacy unsuffixed document when turned $label',
      async ({ enabled, current }) => {
        getWorkflow.mockResolvedValue({ enabled: current });
        getLegacyWorkflow.mockResolvedValue({ enabled: true });

        await createService().ensureWorkflow({ enabled, request, spaceId: defaultSpaceId });

        expect(managementApi.updateWorkflow).toHaveBeenCalledWith(
          SIGNIFICANT_EVENTS_KI_CONTINUOUS_ONBOARDING_WORKFLOW_ID,
          { enabled: false },
          defaultSpaceId,
          request
        );
        expect(managementApi.cancelAllActiveWorkflowExecutions).toHaveBeenCalledWith(
          SIGNIFICANT_EVENTS_KI_CONTINUOUS_ONBOARDING_WORKFLOW_ID,
          defaultSpaceId,
          request
        );
        expect(managedWorkflowsClient.uninstall).toHaveBeenCalledWith(
          SIGNIFICANT_EVENTS_KI_CONTINUOUS_ONBOARDING_WORKFLOW_ID,
          { spaceId: defaultSpaceId }
        );
        expect(managementApi.updateWorkflow).toHaveBeenCalledWith(
          `${SIGNIFICANT_EVENTS_KI_CONTINUOUS_ONBOARDING_WORKFLOW_ID}-${defaultSpaceId}`,
          { enabled },
          defaultSpaceId,
          request
        );
      }
    );

    it('skips the removal when the legacy document is already gone', async () => {
      getWorkflow.mockResolvedValue({ enabled: false });

      await createService().ensureWorkflow({ enabled: true, request, spaceId: defaultSpaceId });

      expect(managementApi.cancelAllActiveWorkflowExecutions).not.toHaveBeenCalled();
      expect(managedWorkflowsClient.uninstall).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('enables the space document with a warning when the legacy removal fails', async () => {
      getWorkflow.mockResolvedValue({ enabled: false });
      getLegacyWorkflow.mockResolvedValue({ enabled: false });
      managedWorkflowsClient.uninstall.mockRejectedValue(new Error('uninstall failed'));

      await createService().ensureWorkflow({ enabled: true, request, spaceId: defaultSpaceId });

      expect(managementApi.updateWorkflow).toHaveBeenCalledWith(
        `${SIGNIFICANT_EVENTS_KI_CONTINUOUS_ONBOARDING_WORKFLOW_ID}-${defaultSpaceId}`,
        { enabled: true },
        defaultSpaceId,
        request
      );
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('uninstall failed'));
    });
  });
});
