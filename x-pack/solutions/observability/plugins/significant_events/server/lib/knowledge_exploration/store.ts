/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SavedObjectsClientContract, SavedObjectsType } from '@kbn/core/server';
import { SavedObjectsErrorHelpers } from '@kbn/core/server';
import type {
  ExplorationRun,
  ExplorationState,
  ExplorerAgent,
} from '../../../common/knowledge_exploration';
import { emptyExplorationTokens } from '../../../common/knowledge_exploration';

export const EXPLORATION_RUN_TYPE = 'nightshift-knowledge-exploration-run';
export const EXPLORATION_STATE_TYPE = 'nightshift-knowledge-exploration-state';
export const MONITORING_RUN_TYPE = 'nightshift-monitoring-exploration-run';
export const MONITORING_STATE_TYPE = 'nightshift-monitoring-exploration-state';
export const EVENT_DISCOVERY_RUN_TYPE = 'nightshift-event-discovery-run';
export const EVENT_DISCOVERY_STATE_TYPE = 'nightshift-event-discovery-state';
export const explorationSavedObjectTypes: SavedObjectsType[] = [
  {
    name: EXPLORATION_RUN_TYPE,
    hidden: true,
    namespaceType: 'single',
    mappings: {
      dynamic: false,
      properties: { startedAt: { type: 'date' }, status: { type: 'keyword' } },
    },
    management: { importableAndExportable: false },
  },
  {
    name: EXPLORATION_STATE_TYPE,
    hidden: true,
    namespaceType: 'single',
    mappings: { dynamic: false, properties: {} },
    management: { importableAndExportable: false },
  },
];

export const monitoringSavedObjectTypes: SavedObjectsType[] = explorationSavedObjectTypes.map(
  (type) => ({
    ...type,
    name: type.name === EXPLORATION_RUN_TYPE ? MONITORING_RUN_TYPE : MONITORING_STATE_TYPE,
  })
);

export const eventDiscoverySavedObjectTypes: SavedObjectsType[] = explorationSavedObjectTypes.map(
  (type) => ({
    ...type,
    name:
      type.name === EXPLORATION_RUN_TYPE ? EVENT_DISCOVERY_RUN_TYPE : EVENT_DISCOVERY_STATE_TYPE,
  })
);

export interface StoredExplorationPayload {
  payload: string;
  startedAt?: string;
  status?: string;
}

export class ExplorationStore {
  constructor(
    private repository: SavedObjectsClientContract,
    private space: string,
    private agent: ExplorerAgent = 'knowledge'
  ) {}
  private get runType(): string {
    return this.agent === 'events'
      ? EVENT_DISCOVERY_RUN_TYPE
      : this.agent === 'monitoring'
      ? MONITORING_RUN_TYPE
      : EXPLORATION_RUN_TYPE;
  }
  private get stateType(): string {
    return this.agent === 'events'
      ? EVENT_DISCOVERY_STATE_TYPE
      : this.agent === 'monitoring'
      ? MONITORING_STATE_TYPE
      : EXPLORATION_STATE_TYPE;
  }

  async getState(): Promise<{ state: ExplorationState; version?: string }> {
    try {
      const doc = await this.repository.get<StoredExplorationPayload>(this.stateType, 'state', {
        namespace: this.space,
      });
      return {
        state: JSON.parse(doc.attributes.payload) as ExplorationState,
        version: doc.version,
      };
    } catch (error) {
      if (!(error instanceof Error) || !SavedObjectsErrorHelpers.isNotFoundError(error))
        throw error;
      return {
        state: {
          checkpoints: {},
          totalCostUsd: 0,
          totalRuns: 0,
          totalTokens: emptyExplorationTokens(),
        },
      };
    }
  }

  async setState(state: ExplorationState, version?: string): Promise<string | undefined> {
    const doc = await this.repository.create(
      this.stateType,
      { payload: JSON.stringify(state) },
      {
        id: 'state',
        namespace: this.space,
        overwrite: Boolean(version),
        version,
        refresh: false,
      }
    );
    return doc.version;
  }

  async saveRun(run: ExplorationRun): Promise<void> {
    await this.repository.create(
      this.runType,
      {
        payload: JSON.stringify(run),
        startedAt: run.startedAt,
        status: run.status,
      },
      { id: run.id, namespace: this.space, overwrite: true, refresh: false }
    );
  }

  async getRun(id: string): Promise<ExplorationRun> {
    const doc = await this.repository.get<StoredExplorationPayload>(this.runType, id, {
      namespace: this.space,
    });
    return JSON.parse(doc.attributes.payload) as ExplorationRun;
  }

  async deleteRun(id: string): Promise<void> {
    await this.repository.delete(this.runType, id, {
      namespace: this.space,
      refresh: 'wait_for',
    });
  }

  async clearRuns(): Promise<number> {
    const ids: string[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.repository.find<StoredExplorationPayload>({
        type: this.runType,
        namespaces: [this.space],
        perPage: 1000,
        page,
      });
      ids.push(...result.saved_objects.map((doc) => doc.id));
      if (result.saved_objects.length < 1000) break;
    }
    for (let offset = 0; offset < ids.length; offset += 25)
      await Promise.all(ids.slice(offset, offset + 25).map((id) => this.deleteRun(id)));
    return ids.length;
  }

  async listRuns(): Promise<ExplorationRun[]> {
    const docs = await this.repository.find<StoredExplorationPayload>({
      type: this.runType,
      namespaces: [this.space],
      sortField: 'startedAt',
      sortOrder: 'desc',
      perPage: 50,
    });
    return docs.saved_objects.map((doc) => ({
      ...(JSON.parse(doc.attributes.payload) as ExplorationRun),
      steps: [],
    }));
  }
}
