import { useEffect, useRef, useState } from 'react';
import { useNostr } from '../contexts/NostrContext';
import { emptyDeliveryAddress, type DeliveryAddress } from '../utils/deliveryAddress';
import {
  readCheckoutAddress,
  rememberCheckoutAddress,
  checkoutAddressGeneration,
} from '../services/checkoutAddressStorage';

export function useCheckoutAddress(visible: boolean) {
  const { pubkey, profile } = useNostr();
  const displayName = profile?.displayName || profile?.name || '';
  const [state, setState] = useState({
    account: pubkey,
    fields: emptyDeliveryAddress(displayName),
    remember: false,
  });
  const edited = useRef(false);
  const displayNameRef = useRef(displayName);
  displayNameRef.current = displayName;
  const epoch = pubkey ? checkoutAddressGeneration(pubkey) : 0;
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    edited.current = false;
    setState({
      account: pubkey,
      fields: emptyDeliveryAddress(displayNameRef.current),
      remember: false,
    });
    if (pubkey)
      void readCheckoutAddress(pubkey).then((fields) => {
        if (fields && !cancelled && !edited.current)
          setState({ account: pubkey, fields, remember: false });
      });
    return () => {
      cancelled = true;
    };
  }, [visible, pubkey]);
  useEffect(() => {
    if (!visible || edited.current || !displayName) return;
    setState((previous) =>
      previous.account === pubkey && !previous.fields.name
        ? { ...previous, fields: { ...previous.fields, name: displayName } }
        : previous,
    );
  }, [visible, pubkey, displayName]);
  const fields = state.account === pubkey ? state.fields : emptyDeliveryAddress(displayName);
  const remember = state.account === pubkey && state.remember;
  return {
    fields,
    remember,
    changeField: (key: keyof DeliveryAddress, value: string) => {
      edited.current = true;
      setState({ account: pubkey, fields: { ...fields, [key]: value }, remember });
    },
    toggleRemember: () => {
      edited.current = true;
      setState({ account: pubkey, fields, remember: !remember });
    },
    save: () =>
      pubkey
        ? rememberCheckoutAddress(pubkey, fields, remember, epoch).catch(() => {})
        : Promise.resolve(),
  };
}
