/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import CLEANUP_YAML from './cleanup.yaml';
import EVENT_DISCOVERY_HOURLY_YAML from './event_discovery_hourly.yaml';
import INVESTIGATION_COMPLETED_YAML from './investigation_completed.yaml';
import MONITORING_SETUP_HOURLY_YAML from './monitoring_setup_hourly.yaml';
import DETECTION_YAML from './significant_events/detection.yaml';
import DISCOVERY_YAML from './significant_events/discovery.yaml';
import ORCHESTRATOR_YAML from './significant_events/orchestrator.yaml';
import type { ManagedWorkflowDefinition } from '../../types';
export {
  SIGNIFICANT_EVENTS_SCHEDULED_DETECTION_WORKFLOW,
  SIGNIFICANT_EVENTS_SCHEDULED_DETECTION_WORKFLOW_ID,
  SIGNIFICANT_EVENTS_SCHEDULED_REVIEW_WORKFLOW,
  SIGNIFICANT_EVENTS_SCHEDULED_REVIEW_WORKFLOW_ID,
} from './scheduled';

export const SIGNIFICANT_EVENTS_DETECTION_WORKFLOW_ID = 'system-significant-events-detection';
export const SIGNIFICANT_EVENTS_DISCOVERY_WORKFLOW_ID = 'system-significant-events-discovery';
export const SIGNIFICANT_EVENTS_ORCHESTRATOR_WORKFLOW_ID = 'system-significant-events-orchestrator';
export const SIGNIFICANT_EVENTS_CLEANUP_WORKFLOW_ID = 'system-significant-events-cleanup';
export const SIGNIFICANT_EVENTS_INVESTIGATION_COMPLETED_WORKFLOW_ID =
  'system-significant-events-investigation-completed';

// lifecycle: 'static' — instances are declared at startup; orphans are cleaned up on restart.
// versionStrategy: 'auto' — version bumps are handled automatically on install.
// enablement: 'enforced' — apply the YAML state; detection is disabled in this KI prototype.
const SIGNIFICANT_EVENTS_WORKFLOW_MANAGEMENT = {
  lifecycle: 'static',
  versionStrategy: 'auto',
  enablement: 'enforced',
} as const;

const SIGNIFICANT_EVENTS_CLEANUP_WORKFLOW_MANAGEMENT = {
  lifecycle: 'dynamic',
  versionStrategy: 'auto',
  enablement: 'restorable',
} as const;

export const SIGNIFICANT_EVENTS_DETECTION_WORKFLOW = {
  id: SIGNIFICANT_EVENTS_DETECTION_WORKFLOW_ID,
  pluginId: 'significantEvents',
  version: 8,
  billable: false,
  yaml: DETECTION_YAML,
  management: SIGNIFICANT_EVENTS_WORKFLOW_MANAGEMENT,
} as const satisfies ManagedWorkflowDefinition;

export const SIGNIFICANT_EVENTS_DISCOVERY_WORKFLOW = {
  id: SIGNIFICANT_EVENTS_DISCOVERY_WORKFLOW_ID,
  pluginId: 'significantEvents',
  version: 24,
  billable: false,
  yaml: DISCOVERY_YAML,
  management: SIGNIFICANT_EVENTS_WORKFLOW_MANAGEMENT,
} as const satisfies ManagedWorkflowDefinition;

export const SIGNIFICANT_EVENTS_ORCHESTRATOR_WORKFLOW = {
  id: SIGNIFICANT_EVENTS_ORCHESTRATOR_WORKFLOW_ID,
  pluginId: 'significantEvents',
  version: 4,
  billable: false,
  yaml: ORCHESTRATOR_YAML,
  management: SIGNIFICANT_EVENTS_WORKFLOW_MANAGEMENT,
} as const satisfies ManagedWorkflowDefinition;

export const SIGNIFICANT_EVENTS_CLEANUP_WORKFLOW = {
  id: SIGNIFICANT_EVENTS_CLEANUP_WORKFLOW_ID,
  pluginId: 'significantEvents',
  version: 1,
  billable: false,
  yaml: CLEANUP_YAML,
  management: SIGNIFICANT_EVENTS_CLEANUP_WORKFLOW_MANAGEMENT,
} as const satisfies ManagedWorkflowDefinition;

export const SIGNIFICANT_EVENTS_INVESTIGATION_COMPLETED_WORKFLOW = {
  id: SIGNIFICANT_EVENTS_INVESTIGATION_COMPLETED_WORKFLOW_ID,
  pluginId: 'significantEvents',
  version: 1,
  billable: false,
  yaml: INVESTIGATION_COMPLETED_YAML,
  management: SIGNIFICANT_EVENTS_WORKFLOW_MANAGEMENT,
} as const satisfies ManagedWorkflowDefinition;

export const SIGNIFICANT_EVENTS_MONITORING_SETUP_HOURLY_WORKFLOW_ID =
  'system-nightshift-v2-monitoring-setup-hourly';

export const SIGNIFICANT_EVENTS_MONITORING_SETUP_HOURLY_WORKFLOW = {
  id: SIGNIFICANT_EVENTS_MONITORING_SETUP_HOURLY_WORKFLOW_ID,
  pluginId: 'significantEvents',
  version: 2,
  billable: false,
  yamlTemplate: ({ intervalMinutes = 60 }) =>
    MONITORING_SETUP_HOURLY_YAML.replace(
      '__EXPLORATION_INTERVAL_MINUTES__',
      String(intervalMinutes)
    ),
  management: {
    lifecycle: 'dynamic',
    versionStrategy: 'auto',
    enablement: 'restorable',
  },
} as const satisfies ManagedWorkflowDefinition<{ intervalMinutes?: number }>;

export const SIGNIFICANT_EVENTS_EVENT_DISCOVERY_HOURLY_WORKFLOW_ID =
  'system-nightshift-v2-event-discovery-hourly';

export const SIGNIFICANT_EVENTS_EVENT_DISCOVERY_HOURLY_WORKFLOW = {
  id: SIGNIFICANT_EVENTS_EVENT_DISCOVERY_HOURLY_WORKFLOW_ID,
  pluginId: 'significantEvents',
  version: 2,
  billable: false,
  yamlTemplate: ({ intervalMinutes = 60 }) =>
    EVENT_DISCOVERY_HOURLY_YAML.replace(
      '__EXPLORATION_INTERVAL_MINUTES__',
      String(intervalMinutes)
    ),
  management: {
    lifecycle: 'dynamic',
    versionStrategy: 'auto',
    enablement: 'restorable',
  },
} as const satisfies ManagedWorkflowDefinition<{ intervalMinutes?: number }>;
