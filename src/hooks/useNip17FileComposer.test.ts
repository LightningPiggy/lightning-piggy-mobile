import { act, renderHook } from '@testing-library/react-native';
import { Buffer } from 'buffer';
import { useNip17FileComposer } from './useNip17FileComposer';
import { MAX_UPLOAD_BYTES } from './useNip17FileComposer';

const mockPicker = jest.fn();
const mockUpload = jest.fn();
const mockAlert = jest.fn();
const mockSigner = jest.fn();
let mockPubkey = 'alice';
let mockActivePubkey = 'alice';
jest.mock('../services/walletStorageService', () => ({
  getActivePubkey: () => mockActivePubkey,
}));
jest.mock('../services/documentMetadata', () => ({
  selectedDocumentName: jest.fn(async () => '../invoice\u202e.pdf'),
}));
jest.mock('expo-file-system', () => ({
  File: { pickFileAsync: (...args: unknown[]) => mockPicker(...args) },
  Paths: { cache: { uri: 'file:///cache/' } },
}));
jest.mock('../services/imageUploadService', () => ({
  uploadEncryptedBlob: (...args: unknown[]) => mockUpload(...args),
}));
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ isLoggedIn: true, pubkey: mockPubkey, signEvent: mockSigner }),
}));
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
jest.mock('../components/BrandedAlert', () => ({
  Alert: { alert: (...args: unknown[]) => mockAlert(...args) },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockPubkey = 'alice';
  mockActivePubkey = 'alice';
});
const picked = () => ({
  uri: 'content://documents/1',
  name: '../invoice\u202e.pdf',
  type: 'application/pdf',
  size: 8,
  base64: jest.fn(async () => Buffer.from('%PDF-1.4').toString('base64')),
  delete: jest.fn(),
});

it('reads only the selected file and sends its encrypted upload as NIP-17 with a sanitized filename', async () => {
  const file = picked();
  mockPicker.mockResolvedValue(file);
  mockUpload.mockResolvedValue({ url: 'https://example.com/cipher', mime: 'application/pdf' });
  const send = jest.fn(async () => true);
  const { result } = renderHook(() => useNip17FileComposer('nip17', send, jest.fn()));
  await act(async () => {
    await result.current.pickFile?.();
  });
  expect(mockUpload).toHaveBeenCalledWith(
    file.uri,
    expect.any(Function),
    'application/pdf',
    await file.base64(),
  );
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ filename: 'invoice.pdf' }),
    'file',
    'nip17',
  );
  expect(file.delete).not.toHaveBeenCalled();
  expect(result.current.uploading).toBe(false);
});
it.each(['marmot', 'nip04'] as const)('does not expose a NIP-17 file picker in %s', (protocol) => {
  const { result } = renderHook(() => useNip17FileComposer(protocol, jest.fn(), jest.fn()));
  expect(result.current.pickFile).toBeUndefined();
});
it('rejects oversized provider metadata before reading or uploading', async () => {
  const file = { ...picked(), size: MAX_UPLOAD_BYTES + 1 };
  mockPicker.mockResolvedValue(file);
  const { result } = renderHook(() => useNip17FileComposer('nip17', jest.fn(), jest.fn()));
  await act(async () => {
    await result.current.pickFile?.();
  });
  expect(file.base64).not.toHaveBeenCalled();
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockAlert).toHaveBeenCalledWith('messageBubble.file', 'messageBubble.fileUploadLimit');
});
it('treats picker cancellation as no send and no error', async () => {
  mockPicker.mockRejectedValue(new Error('File picking was cancelled by the user'));
  const send = jest.fn();
  const { result } = renderHook(() => useNip17FileComposer('nip17', send, jest.fn()));
  await act(async () => {
    await result.current.pickFile?.();
  });
  expect(send).not.toHaveBeenCalled();
  expect(mockAlert).not.toHaveBeenCalled();
});

it('does not open the picker when the group send target is unavailable', async () => {
  const { result } = renderHook(() =>
    useNip17FileComposer('nip17', jest.fn(), jest.fn(), () => false),
  );
  await act(async () => {
    await result.current.pickFile?.();
  });
  expect(mockPicker).not.toHaveBeenCalled();
});

it('checks actual bytes against the upload cap even when provider metadata is smaller', async () => {
  const file = {
    ...picked(),
    base64: jest.fn(async () => Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64')),
  };
  mockPicker.mockResolvedValue(file);
  const { result } = renderHook(() => useNip17FileComposer('nip17', jest.fn(), jest.fn()));
  await act(async () => {
    await result.current.pickFile?.();
  });
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockAlert).toHaveBeenCalledWith('messageBubble.file', 'messageBubble.fileUploadLimit');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

it.each(['picker', 'upload'] as const)(
  'uses the latest authorized roster after the %s awaits',
  async (stage) => {
    const gate = deferred<ReturnType<typeof picked>>();
    const uploadGate = deferred<{ url: string; mime: string }>();
    mockPicker.mockReturnValue(stage === 'picker' ? gate.promise : Promise.resolve(picked()));
    mockUpload.mockReturnValue(
      stage === 'upload'
        ? uploadGate.promise
        : Promise.resolve({ url: 'https://example.com/file', mime: 'application/pdf' }),
    );
    const oldSend = jest.fn(async () => true);
    const currentSend = jest.fn(async () => true);
    const { result, rerender } = renderHook(
      ({ send }: { send: typeof oldSend }) =>
        useNip17FileComposer('nip17', send, jest.fn(), () => true, 'group'),
      { initialProps: { send: oldSend } },
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.pickFile!();
    });
    rerender({ send: currentSend });
    await act(async () => {
      gate.resolve(picked());
      uploadGate.resolve({ url: 'https://example.com/file', mime: 'application/pdf' });
      await pending;
    });
    expect(oldSend).not.toHaveBeenCalled();
    expect(currentSend).toHaveBeenCalledTimes(1);
  },
);

it.each(['identity', 'active store', 'target', 'permission', 'protocol', 'unmount'] as const)(
  'cancels a pending upload when %s changes',
  async (change) => {
    const gate = deferred<{ url: string; mime: string }>();
    const file = { ...picked(), uri: 'file:///cache/document.pdf' };
    mockPicker.mockResolvedValue(file);
    mockUpload.mockReturnValue(gate.promise);
    const send = jest.fn(async () => true);
    const { result, rerender, unmount } = renderHook(
      ({
        target,
        allowed,
        protocol,
      }: {
        target: string;
        allowed: boolean;
        protocol: 'nip17' | 'nip04';
      }) => useNip17FileComposer(protocol, send, jest.fn(), () => allowed, target),
      { initialProps: { target: 'group', allowed: true, protocol: 'nip17' as 'nip17' | 'nip04' } },
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.pickFile!();
    });
    expect(mockUpload).toHaveBeenCalledTimes(1);
    if (change === 'identity') mockPubkey = 'bob';
    if (change === 'active store') mockActivePubkey = 'bob';
    if (change === 'unmount') unmount();
    else
      rerender({
        target: change === 'target' ? 'other' : 'group',
        allowed: change !== 'permission',
        protocol: change === 'protocol' ? 'nip04' : 'nip17',
      });
    await act(async () => {
      gate.resolve({ url: 'https://example.com/file', mime: 'application/pdf' });
      await pending;
    });
    expect(send).not.toHaveBeenCalled();
    expect(file.delete).toHaveBeenCalledTimes(1);
  },
);

it('does not read or upload a picked file after an identity switch', async () => {
  const gate = deferred<ReturnType<typeof picked>>();
  const file = picked();
  mockPicker.mockReturnValue(gate.promise);
  const send = jest.fn();
  const { result } = renderHook(() => useNip17FileComposer('nip17', send, jest.fn()));
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.pickFile!();
  });
  mockActivePubkey = 'bob';
  await act(async () => {
    gate.resolve(file);
    await pending;
  });
  expect(file.base64).not.toHaveBeenCalled();
  expect(mockUpload).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
