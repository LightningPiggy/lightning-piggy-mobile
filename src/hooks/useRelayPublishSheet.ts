import { getCurrentUserPubkey } from '../services/nostrActiveAccount';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BottomSheetModal } from '../components/AccessibleBottomSheetModal';
import { Toast } from '../components/BrandedToast';
import { useTranslation } from '../contexts/LocaleContext';
import { useCoalescedMap } from '../utils/useCoalescedMap';
import {
  publishPhase,
  publishProgressRow,
  type PublishPhase,
  type PublishProgress,
  type PublishRow,
} from '../utils/relayPublishProgress';
import type { RelayPublishResult } from '../services/nostrRelayLists';

type Outcome = { ok: boolean; error?: string; results?: RelayPublishResult[] };

/** The sheet is a viewer: dismissal/unmount never aborts signing or publishing. */
export function useRelayPublishSheet(pubkey: string | null) {
  const t = useTranslation();
  const sheet = useRef<BottomSheetModal>(null);
  const visible = useRef(false);
  const busy = useRef(false);
  const owner = useRef(pubkey);
  owner.current = pubkey;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState<PublishPhase>('waiting');
  const [error, setError] = useState<string>();
  const { map, setMap, enqueue, flush, reset } = useCoalescedMap<PublishRow>();
  useEffect(() => {
    sheet.current?.dismiss();
    setOpen(false);
    setTitle('');
    reset();
  }, [pubkey, reset]);
  useEffect(
    () => () => {
      visible.current = false;
    },
    [],
  );
  const dismiss = useCallback(() => {
    visible.current = false;
    setOpen(false);
  }, []);

  const run = useCallback(
    async (
      heading: string,
      publish: (progress: PublishProgress) => Promise<Outcome>,
      errorPrefix: string,
    ) => {
      if (busy.current) return;
      busy.current = true;
      const pk = pubkey;
      reset();
      setTitle(heading);
      setPhase('waiting');
      setError(undefined);
      visible.current = true;
      setOpen(true);
      sheet.current?.present();
      try {
        const outcome = await publish((update) => {
          if (owner.current !== pk || getCurrentUserPubkey() !== pk) return;
          if (update.targets)
            setMap(new Map(update.targets.map((url) => [url, { url, status: 'pending' }])));
          if (update.signed) setPhase((value) => publishPhase(value, update));
          if (update.result) enqueue(update.result.url, publishProgressRow(update.result));
        });
        if (owner.current !== pk || getCurrentUserPubkey() !== pk) return;
        outcome.results?.forEach((result) => enqueue(result.url, publishProgressRow(result)));
        flush();
        setPhase((value) => publishPhase(value, { finished: true }));
        const failure = !outcome.ok
          ? t(`${errorPrefix}.error.${outcome.error ?? 'not-signed'}`)
          : undefined;
        setError(failure);
        if (!visible.current)
          Toast.show({
            type: outcome.ok ? 'success' : 'error',
            text1: heading,
            text2:
              outcome.results
                ?.map((result) => {
                  const row = publishProgressRow(result);
                  return `${row.url}: ${t(`relayPublishSheet.${row.status}`)}${row.reason ? ` — ${row.reason}` : ''}`;
                })
                .join('\n') || failure,
          });
      } catch {
        if (owner.current === pk && getCurrentUserPubkey() === pk) {
          const message = t(`${errorPrefix}.error.not-signed`);
          setError(message);
          setPhase('finished');
          if (!visible.current) Toast.show({ type: 'error', text1: heading, text2: message });
        }
      } finally {
        busy.current = false;
      }
    },
    [pubkey, reset, setMap, enqueue, flush, t],
  );
  return { sheet, title, open, phase, error, rows: [...map.values()], dismiss, run };
}
