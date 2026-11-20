/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { DataStreamsStart } from '@kbn/core-data-streams-server';
import type { Logger } from '@kbn/core/server';
import type { PluginScopedManagedWorkflowsApi } from '@kbn/workflows/server/types';
import { KNOWLEDGE_INDICATORS_DATA_STREAM } from '../../knowledge_indicators/data_stream';
import { DETECTIONS_DATA_STREAM } from '../../significant_events/detections/data_stream';

// Created before any workflow or request can use them. Managed workflows read detections with raw
// Elasticsearch requests (ES|QL `FROM` fails on a missing index). Knowledge indicators are read right
// after their first write, and a data stream created on that first use rejects reads until its
// search shard has recovered.
const EAGER_DATA_STREAMS = [DETECTIONS_DATA_STREAM, KNOWLEDGE_INDICATORS_DATA_STREAM];

export interface ManagedWorkflowsInstaller {
  /** Initializes resources and closes the legacy owner reconciliation window. */
  install: () => Promise<void>;
}

export interface CreateManagedWorkflowsInstallerOptions {
  getClient: () => Promise<PluginScopedManagedWorkflowsApi>;
  dataStreams: Pick<DataStreamsStart, 'initializeClient'>;
  isAvailable: () => Promise<boolean>;
  logger: Logger;
}

/** Retires legacy detection workflows and initializes shared data streams once available. */
export const createManagedWorkflowsInstaller = ({
  getClient,
  dataStreams,
  isAvailable,
  logger,
}: CreateManagedWorkflowsInstallerOptions): ManagedWorkflowsInstaller => {
  let queue: Promise<void> = Promise.resolve();
  let reconciled = false;

  const runInstall = async (): Promise<void> => {
    if (!(await isAvailable())) {
      logger.debug(
        'significantEvents: availability flag disabled, skipping managed workflow installation'
      );
      return;
    }

    // Core creates data streams lazily, on first client use, so create them before any workflow can run.
    for (const dataStreamName of EAGER_DATA_STREAMS) {
      await dataStreams.initializeClient(dataStreamName);
    }

    const client = await getClient();

    // The unified agent replaces detection workflows. Closing the owner reconciliation
    // without installing them retires existing legacy definitions on this branch.

    // Log success only after the whole sequence (including reconciliation) has actually landed, and
    // only once at INFO. Re-installs on later flag flips are routine, so keep them at debug.
    if (!reconciled) {
      await client.ready();
      reconciled = true;
      logger.info('Legacy detection workflows retired; unified agent ready');
    } else {
      logger.debug('Unified agent resources reconciled');
    }
  };

  return {
    install: () => {
      queue = queue.catch(() => {}).then(runInstall);
      return queue;
    },
  };
};
