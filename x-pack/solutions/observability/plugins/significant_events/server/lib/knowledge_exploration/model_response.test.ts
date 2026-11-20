/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  ChatCompletionEventType,
  InferenceTaskError,
  ChatCompletionErrorCode,
} from '@kbn/inference-common';
import type { ChatCompletionEvent } from '@kbn/inference-common';
import { concat, of, throwError } from 'rxjs';
import { collectModelResponse } from './model_response';

it.each([false, true])(
  'keeps reported usage on rejected tool arguments; usage available=%s',
  async (reported) => {
    const tokens = { prompt: 1234, completion: 56, total: 1290 };
    const error = new InferenceTaskError(
      ChatCompletionErrorCode.ToolValidationError,
      'Tool call arguments for source_esql were invalid',
      {
        name: 'source_esql',
        errorsText: 'template: invalid option',
        arguments: '{"template":"invented"}',
      }
    );
    const events = concat(
      of<ChatCompletionEvent>({ type: ChatCompletionEventType.ChatCompletionTokenCount, tokens }),
      throwError(() => error)
    );
    const result = collectModelResponse(
      reported ? events : throwError(() => error),
      new AbortController().signal
    );
    if (!reported) {
      await expect(result).rejects.toThrow('template: invalid option');
      return;
    }
    await expect(result).resolves.toMatchObject({
      tokens,
      toolCalls: [],
      validationError: expect.stringContaining('template: invalid option'),
    });
  }
);
