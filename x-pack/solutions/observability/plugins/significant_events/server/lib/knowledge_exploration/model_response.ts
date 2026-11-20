/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  ChatCompleteResponse,
  ChatCompletionEvent,
  ChatCompletionMessageEvent,
  ChatCompletionTokenCount,
} from '@kbn/inference-common';
import { ChatCompletionEventType, isToolValidationError } from '@kbn/inference-common';
import type { Observable } from 'rxjs';
import { fromEvent, lastValueFrom, takeUntil, tap } from 'rxjs';

/** Preserves reported usage when inference rejects a generated tool call before execution. */
export const collectModelResponse = async (
  events: Observable<ChatCompletionEvent>,
  signal: AbortSignal
): Promise<ChatCompleteResponse & { validationError?: string }> => {
  signal.throwIfAborted();
  const response: {
    message?: ChatCompletionMessageEvent;
    tokens?: ChatCompletionTokenCount;
    model?: string;
  } = {};
  try {
    await lastValueFrom(
      events.pipe(
        takeUntil(fromEvent(signal, 'abort')),
        tap((event) => {
          if (event.type === ChatCompletionEventType.ChatCompletionTokenCount) {
            response.tokens = event.tokens;
            response.model = event.model;
          }
          if (event.type === ChatCompletionEventType.ChatCompletionMessage)
            response.message = event;
        })
      ),
      { defaultValue: undefined }
    );
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof Error) || !isToolValidationError(error)) throw error;
    const details = `${error.message}: ${error.meta.errorsText ?? 'Invalid JSON tool arguments'}`;
    if (!response.tokens) throw new Error(`${details}. The request returned no token usage.`);
    return {
      content: '',
      toolCalls: [],
      tokens: response.tokens,
      model: response.model,
      validationError: `${details}. Rejected arguments: ${(error.meta.arguments ?? '').slice(
        0,
        12000
      )}`,
    };
  }
  signal.throwIfAborted();
  if (!response.message) throw new Error('Model stream ended without a completed message');
  return { ...response.message, tokens: response.tokens, model: response.model };
};
