import { requireOptionalNativeModule } from 'expo-modules-core';
import { selectedDocumentName } from './documentMetadata';

jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: jest.fn() }));

it('uses the provider display name for opaque Android content URIs', async () => {
  const displayNameAsync = jest.fn(async () => 'invoice.pdf');
  jest.mocked(requireOptionalNativeModule).mockReturnValue({ displayNameAsync });
  await expect(
    selectedDocumentName({ uri: 'content://downloads/document/1234', name: '1234' }),
  ).resolves.toBe('invoice.pdf');
  expect(displayNameAsync).toHaveBeenCalledWith('content://downloads/document/1234');
});

it('falls back to the basename when the provider has no display name', async () => {
  jest.mocked(requireOptionalNativeModule).mockReturnValue({ displayNameAsync: async () => null });
  await expect(
    selectedDocumentName({ uri: 'content://downloads/document/1234', name: '1234' }),
  ).resolves.toBe('1234');
});

it('retains local file names without a native query', async () => {
  await expect(
    selectedDocumentName({ uri: 'file:///cache/invoice.pdf', name: 'invoice.pdf' }),
  ).resolves.toBe('invoice.pdf');
});

it('retains the basename without logging in production when the metadata module is absent', async () => {
  const previousDev = __DEV__;
  const devGlobal = globalThis as unknown as { __DEV__: boolean };
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.replaceProperty(devGlobal, '__DEV__', false);
  jest.mocked(requireOptionalNativeModule).mockReturnValue(null);
  try {
    await expect(
      selectedDocumentName({ uri: 'content://downloads/document/1234', name: '1234' }),
    ).resolves.toBe('1234');
    expect(warn).not.toHaveBeenCalled();
  } finally {
    jest.replaceProperty(devGlobal, '__DEV__', previousDev);
    warn.mockRestore();
  }
});

it('retains basenames and warns only once in development when the metadata module is absent', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.mocked(requireOptionalNativeModule).mockReturnValue(null);
  try {
    await expect(
      selectedDocumentName({ uri: 'content://downloads/document/1234', name: '1234' }),
    ).resolves.toBe('1234');
    await expect(
      selectedDocumentName({ uri: 'content://downloads/document/5678', name: '5678' }),
    ).resolves.toBe('5678');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Rebuild the dev client'));
  } finally {
    warn.mockRestore();
  }
});
