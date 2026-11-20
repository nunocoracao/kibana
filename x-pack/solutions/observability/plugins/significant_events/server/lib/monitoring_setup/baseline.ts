/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { estypes } from '@elastic/elasticsearch';

interface BaselineGroup {
  dimensions: Record<string, string>;
  points: number;
  firstBucket: string;
  lastBucket: string;
  missingMinutes: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  medianAbsoluteDeviation: number;
  olderMean: number;
  newerMean: number;
  latestValue: number;
}
interface BaselineSummary {
  groups: BaselineGroup[];
  totalGroups: number;
  truncated: boolean;
  invalidRows: number;
  warnings: string[];
}
const percentile = (values: number[], fraction: number): number => {
  const sorted = values.slice().sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
};
const mean = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** Describes observed complete-minute series without inventing missing values or incident thresholds. */
export const summarizeBaseline = (
  response: Pick<estypes.EsqlQueryResponse, 'columns' | 'values'>
): BaselineSummary => {
  const bucketColumn = response.columns.findIndex((column) => column.name === 'bucket');
  const valueColumn = response.columns.findIndex((column) => column.name === 'metric_value');
  if (bucketColumn < 0 || valueColumn < 0)
    throw new Error('Baseline requires bucket and metric_value columns');
  const dimensionColumns = response.columns.flatMap((column, index) =>
    index === bucketColumn || index === valueColumn ? [] : [{ name: column.name, index }]
  );
  const grouped = new Map<
    string,
    { dimensions: Record<string, string>; points: Map<number, number> }
  >();
  let invalidRows = 0;
  for (const row of response.values) {
    const timestamp = row[bucketColumn];
    const bucket = typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp));
    const metric = row[valueColumn];
    const value = typeof metric === 'number' || typeof metric === 'string' ? Number(metric) : NaN;
    if (!Number.isFinite(bucket) || !Number.isFinite(value)) {
      invalidRows++;
      continue;
    }
    const dimensions = Object.fromEntries(
      dimensionColumns.map(({ name, index }) => [name, String(row[index] ?? '')])
    );
    const key = JSON.stringify(dimensions);
    const group = grouped.get(key) ?? { dimensions, points: new Map<number, number>() };
    if (group.points.has(bucket))
      throw new Error(
        'Baseline emits multiple values per group and bucket; use complete-minute grouping'
      );
    group.points.set(bucket, value);
    grouped.set(key, group);
  }
  const groups = [...grouped.values()].map(({ dimensions, points }) => {
    const ordered = [...points].sort(([a], [b]) => a - b);
    const values = ordered.map(([, value]) => value);
    const median = percentile(values, 0.5);
    const half = Math.max(1, Math.floor(values.length / 2));
    const first = ordered[0][0];
    const last = ordered[ordered.length - 1][0];
    return {
      dimensions,
      points: values.length,
      firstBucket: new Date(first).toISOString(),
      lastBucket: new Date(last).toISOString(),
      missingMinutes: Math.max(0, Math.round((last - first) / 60000) + 1 - values.length),
      min: Math.min(...values),
      max: Math.max(...values),
      mean: mean(values),
      median,
      p95: percentile(values, 0.95),
      medianAbsoluteDeviation: percentile(
        values.map((value) => Math.abs(value - median)),
        0.5
      ),
      olderMean: mean(values.slice(0, half)),
      newerMean: mean(values.slice(half).length ? values.slice(half) : values),
      latestValue: values[values.length - 1],
    };
  });
  const truncated = response.values.length >= 1001 || groups.length > 20;
  const warnings = [
    'Descriptive observations, not incident thresholds or proof of normality. Missing buckets are unknown, never zero. Compare aligned outcomes/denominators and units.',
  ];
  if (groups.some((group) => group.points < 12))
    warnings.push(
      'Some groups have fewer than 12 complete buckets; baseline/change-point confidence is limited.'
    );
  if (groups.some((group) => group.missingMinutes))
    warnings.push(
      'Gapped history; absence and recovery cannot be inferred from missing measurements.'
    );
  if (invalidRows)
    warnings.push('Null or invalid measurements were omitted, not interpreted as healthy zeroes.');
  if (truncated)
    warnings.push(
      'Result/group cap reached; narrow dimensions or time before claiming full coverage.'
    );
  return {
    groups: groups.slice(0, 20),
    totalGroups: groups.length,
    truncated,
    invalidRows,
    warnings,
  };
};

export const BASELINE_EVIDENCE_PREFIX = 'nightshift-monitor-baseline-v1:';
