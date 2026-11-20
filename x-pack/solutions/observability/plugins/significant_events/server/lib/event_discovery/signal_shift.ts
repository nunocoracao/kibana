/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Returns a relative series-change hint without assuming the measurement's units. */
export const detectSeriesShift = (
  values: readonly number[]
): { reference: number; newest: number; ratio: number | null } | undefined => {
  if (values.length < 5) return undefined;
  const median = (samples: readonly number[]): number => {
    const sorted = [...samples].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const reference = median(values.slice(0, -2));
  const newest = median(values.slice(-2));
  if (newest === reference) return undefined;
  const ratio = reference ? newest / reference : Infinity;
  return ratio <= 0.67 || ratio >= 1.5
    ? { reference, newest, ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null }
    : undefined;
};
