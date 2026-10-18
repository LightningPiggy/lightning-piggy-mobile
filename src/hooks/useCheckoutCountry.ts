import { useCallback, useEffect, useRef, useState } from 'react';
import { useNostr } from '../contexts/NostrContext';
import { deviceCountryCode } from '../data/countries';
import { readCheckoutCountry, writeCheckoutCountry } from '../services/marketStorage';

/** Each sheet visit restores this account's destination, without overriding a queued pick. */
export function useCheckoutCountry(visible: boolean) {
  const { pubkey } = useNostr();
  const [state, setState] = useState({ account: pubkey, country: deviceCountryCode() });
  const edited = useRef(false);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    edited.current = false;
    setState({ account: pubkey, country: deviceCountryCode() });
    if (pubkey) {
      void readCheckoutCountry(pubkey).then((country) => {
        if (!cancelled && !edited.current && country) setState({ account: pubkey, country });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [visible, pubkey]);
  const countryCode = state.account === pubkey ? state.country : deviceCountryCode();
  const selectCountry = useCallback(
    (country: string | null) => {
      edited.current = true;
      setState({ account: pubkey, country });
      if (pubkey && country) void writeCheckoutCountry(pubkey, country);
    },
    [pubkey],
  );
  const rememberCountry = useCallback(() => {
    if (pubkey && countryCode) void writeCheckoutCountry(pubkey, countryCode);
  }, [pubkey, countryCode]);
  return { countryCode, selectCountry, rememberCountry };
}
