/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ToolDefinition } from '@kbn/inference-common';
import type { ExplorationLimits } from './knowledge_exploration';

export interface ExplorationAgentAnatomy {
  id: string;
  name: string;
  description: string;
  connectorId: string;
  model: string;
  defaultModel: { connectorId: string; model: string };
  systemPrompt: string;
  tools: Array<ToolDefinition & { name: string }>;
  subAgents: ExplorationAgentAnatomy[];
  thinking?: { enabled: boolean; effort: string };
  skills?: Array<{ name: string; description: string; content: string }>;
  scope?: { spaceId: string; sources: string; lookback: string };
  triggers?: string[];
  limits?: ExplorationLimits & {
    initialLearning: ExplorationLimits;
    hardEstimatedCostCeilingUsd: number;
    maxActiveManagedRulesPerService: number;
  };
  persistence?: string[];
  memory?: Array<{ name: string; scope: string; storage: string; lifetime: string }>;
  costEstimate?: string;
}
