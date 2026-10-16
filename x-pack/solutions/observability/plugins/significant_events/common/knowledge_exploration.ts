/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export interface ExplorationTokens {
  prompt: number;
  completion: number;
  thinking: number;
  cached: number;
  total: number;
}

export interface ExplorationStep {
  id: string;
  kind: 'model' | 'tool';
  name: string;
  startedAt: string;
  durationMs: number;
  status: 'running' | 'completed' | 'partial' | 'failed';
  input: string;
  output: string;
  tokens?: ExplorationTokens;
  estimatedCostUsd?: number;
}

export interface ExplorationPricing {
  input: number;
  output: number;
  cacheRead: number | null;
  tierThreshold: number | null;
  source: 'elastic_catalog' | 'public_haiku';
}

export interface ExplorationLimits {
  mode: 'initial_learning' | 'incremental';
  maxDurationMinutes: number;
  maxTurns: number;
  maxCumulativeTokens: number;
  maxEstimatedCostUsd: number;
}

export const incrementalExplorationLimits: ExplorationLimits = {
  mode: 'incremental',
  maxDurationMinutes: 10,
  maxTurns: 48,
  maxCumulativeTokens: 2560000,
  maxEstimatedCostUsd: 50,
};

export const initialExplorationLimits: ExplorationLimits = {
  mode: 'initial_learning',
  maxDurationMinutes: 20,
  maxTurns: 96,
  maxCumulativeTokens: 5120000,
  maxEstimatedCostUsd: 50,
};

export type ExplorerAgent = 'knowledge' | 'monitoring' | 'events';
export interface MonitoringCoverage {
  priority?: 'high' | 'medium' | 'low';
  priorityReason?: string;
  sourceId: string;
  entity: string;
  concern: string;
  state: 'covered' | 'partial' | 'blind_spot' | 'unobservable';
  ruleIds: string[];
  evidence: string;
}

export interface ExplorationRun {
  agent?: ExplorerAgent;
  coverage?: MonitoringCoverage[];
  discovery?: {
    signalCount: number;
    active: number;
    inactive: number;
    excludedUnattributed: number;
  };
  id: string;
  reason: 'manual' | 'hourly' | 'source_added';
  sourceId?: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  outcome?: 'learned' | 'nothing_new' | 'configured' | 'unchanged' | 'assessed' | 'partial';
  coverageComplete?: boolean;
  remainingGaps?: string[];
  summary: string;
  connectorId: string;
  model: string;
  thinking: true;
  limits?: ExplorationLimits;
  steps: ExplorationStep[];
  tokens: ExplorationTokens;
  estimatedCostUsd: number;
  pricing?: ExplorationPricing;
  pricingRecoveredAt?: string;
  costEstimateComplete?: boolean;
  written: number;
  examinedSources: string[];
  error?: string;
}

export interface ExplorationCheckpoint {
  factsSignature?: string;
  patternSignatures?: string[];
  signature: string;
  checkedAt: string;
}

export interface ExplorationSamplingAttempt {
  attemptId?: string;
  agent?: ExplorerAgent;
  startedAt?: string;
  template: string;
  sourceIds: string[];
  lookbackMinutes: number;
  endOffsetMinutes: number;
  namespace: string;
  services: string[];
  fieldSearch: string;
  pipeline: string;
  durationMs: number;
  status: ExplorationStep['status'];
  results: Array<{
    sourceId: string;
    error?: string;
    documents?: number;
    countRelation?: string;
    rowsReturned?: number;
    truncated: boolean;
  }>;
}

export interface ExplorationState {
  samplingAttempts?: ExplorationSamplingAttempt[];
  hourlyEnabled?: boolean;
  intervalMinutes?: number;
  costTotalsResetAt?: string;
  repricedRunIds?: string[];
  remainingGaps?: string[];
  selectedConnectorId?: string;
  unpricedRuns?: number;
  checkpoints: Record<string, ExplorationCheckpoint>;
  activeRunId?: string;
  leaseUntil?: number;
  totalCostUsd: number;
  totalRuns: number;
  totalRunDurationMs?: number;
  totalRunDurationSamples?: number;
  totalTokens: ExplorationTokens;
}

export interface ExplorationStatus {
  availableModels: Array<{ connectorId: string; model: string }>;
  costEstimateComplete: boolean;
  featureCount: number;
  enabled: boolean;
  interval: string;
  intervalMinutes: number;
  thinking: true;
  model: string;
  connectorId: string;
  runningRunId?: string;
  runs: ExplorationRun[];
  totalCostUsd: number;
  totalRuns: number;
  totalRunDurationMs: number;
  averageRunDurationMs: number;
  totalTokens: ExplorationTokens;
  sources: Array<{ id: string; slug: string; title: string; enabled: boolean }>;
}

export const emptyExplorationTokens = (): ExplorationTokens => ({
  prompt: 0,
  completion: 0,
  thinking: 0,
  cached: 0,
  total: 0,
});
