/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Detects forbidden operations outside ES|QL string literals and quoted identifiers. */
export const hasForbiddenMonitoringOperations = (pipeline: string): boolean => {
  const commands = pipeline.replace(
    /"(?:\\.|""|[^"\\])*"|'(?:\\.|''|[^'\\])*'|`(?:``|[^`])*`/g,
    ''
  );
  return /\b(FROM|ROW|JOIN|LOOKUP|ENRICH|FORK|INLINE|CHANGE_POINT|COMPLETION)\b|;|\/\*|--/i.test(
    commands
  );
};
