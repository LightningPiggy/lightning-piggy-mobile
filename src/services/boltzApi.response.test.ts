import { fetchWithTimeout, isSwapServerTimeoutError } from './boltzApi';
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

function stalledBody() {
  let receivedSignal!: AbortSignal;
  global.fetch = jest.fn(async (_url, init) => {
    receivedSignal = init?.signal as AbortSignal;
    return {
      json: () =>
        new Promise((_resolve, reject) => {
          receivedSignal.addEventListener('abort', () => reject(new Error('body aborted')), {
            once: true,
          });
        }),
    } as Response;
  });
  return () => receivedSignal;
}

it('keeps caller cancellation linked after headers while consuming the response body', async () => {
  const signal = stalledBody();
  const controller = new AbortController();
  const reading = fetchWithTimeout(
    'https://example.com',
    { signal: controller.signal },
    10000,
    (response) => response.json(),
  );
  const rejected = expect(reading).rejects.toThrow('body aborted');
  await Promise.resolve();
  expect(signal().aborted).toBe(false);
  controller.abort();
  await rejected;
  expect(signal().aborted).toBe(true);
});

it('keeps the deadline active for a body that stalls after successful headers', async () => {
  jest.useFakeTimers();
  const signal = stalledBody();
  const reading = fetchWithTimeout('https://example.com', undefined, 100, (response) =>
    response.json(),
  );
  // Our own deadline is reported as a timeout, never as the AbortError a
  // caller would mistake for its own cancel (the 2026-11-01 stuck swap).
  const rejected = expect(reading).rejects.toMatchObject({ name: 'SwapServerTimeoutError' });
  await Promise.resolve();
  jest.advanceTimersByTime(100);
  await rejected;
  expect(signal().aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

it('reports its own deadline as a timeout when fetch itself rejects with AbortError', async () => {
  jest.useFakeTimers();
  global.fetch = jest.fn(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      }),
  ) as typeof fetch;
  const request = fetchWithTimeout('https://example.com', undefined, 100).catch((e) => e);
  jest.advanceTimersByTime(100);
  const error = await request;
  expect(isSwapServerTimeoutError(error)).toBe(true);
  expect((error as Error).name).not.toBe('AbortError');
});

it('keeps an AbortError when the caller cancelled', async () => {
  global.fetch = jest.fn(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      }),
  ) as typeof fetch;
  const controller = new AbortController();
  const request = fetchWithTimeout('https://example.com', { signal: controller.signal }, 10000);
  controller.abort();
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
});
