/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { normalizeEnginePreferences } from './engine_preferences';

describe('normalizeEnginePreferences', () => {
  it('provides complete collection defaults for older partial settings', () => {
    expect(normalizeEnginePreferences({})).toEqual({
      confidenceThreshold: 0,
      discoveryPaused: false,
      dailyDiscoveryLimit: 0,
      pausedSources: [],
      usage: {},
      history: [],
      severityFeedback: {},
    });
  });

  it('preserves legacy paused entries, counters and settings without returning the old key', () => {
    const previous = {
      pausedStreams: ['source-a'],
      confidenceThreshold: 0.8,
      discoveryPaused: true,
      dailyDiscoveryLimit: 25,
      usage: { '2026-10-15': 7 },
      history: [{ timestamp: '2026-10-15T12:00:00Z', actor: 'user', message: 'Paused' }],
    };
    const result = normalizeEnginePreferences(previous);
    expect(result.pausedSources).toEqual(['source-a']);
    expect(result).not.toHaveProperty('pausedStreams');
    expect(result.confidenceThreshold).toBe(0.8);
    expect(result.discoveryPaused).toBe(true);
    expect(result.dailyDiscoveryLimit).toBe(25);
    expect(result.usage).toEqual(previous.usage);
    expect(result.history).toEqual(previous.history);
    expect(previous.pausedStreams).toEqual(['source-a']);
  });

  it('prefers current paused sources, including an explicitly empty list', () => {
    expect(
      normalizeEnginePreferences({ pausedStreams: ['old'], pausedSources: ['new'] }).pausedSources
    ).toEqual(['new']);
    expect(
      normalizeEnginePreferences({ pausedStreams: ['old'], pausedSources: [] }).pausedSources
    ).toEqual([]);
  });

  it('does not change already normalized settings on repeated reads', () => {
    const settings = normalizeEnginePreferences({ pausedStreams: ['source-a'] });
    expect(normalizeEnginePreferences(settings)).toEqual(settings);
  });
});
