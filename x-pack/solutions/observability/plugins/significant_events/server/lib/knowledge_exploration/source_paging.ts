/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Keeps a stale offset from making a changed field filter appear empty. */
export const pageSourceFields = <T>(
  items: readonly T[],
  requestedOffset: number,
  limit: number
) => {
  const offset = requestedOffset >= items.length ? 0 : requestedOffset;
  const page = items.slice(offset, offset + limit);
  return {
    page,
    offset,
    requestedOffset,
    offsetReset: offset !== requestedOffset,
    hasMore: offset + page.length < items.length,
    nextOffset: offset + page.length < items.length ? offset + page.length : null,
  };
};
