/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { StatusError } from '../errors/status_error';

// This branch focuses on Knowledge Explorer; existing detection workflows stay off.
export const DETECTION_WORKFLOWS_ENABLED: boolean = false;

export const assertDetectionWorkflowsEnabled = (): void => {
  if (!DETECTION_WORKFLOWS_ENABLED)
    throw new StatusError(
      'Detection workflows are disabled in the Knowledge Explorer prototype.',
      409
    );
};
