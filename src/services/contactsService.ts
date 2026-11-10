import * as Contacts from 'expo-contacts/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LN_MAP_KEY = 'contact_lightning_map';

export interface PhoneContact {
  id: string;
  name: string;
  phoneNumber: string | null;
  lightningAddress: string | null;
}

export async function fetchPhoneContacts(): Promise<PhoneContact[]> {
  const { status } = await Contacts.requestPermissionsAsync();
  if (status !== 'granted') {
    return [];
  }

  const { data } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Name],
    sort: Contacts.SortTypes.FirstName,
  });

  const lnMap = await getLightningAddressMap();

  return data
    .filter((c) => c.name)
    .map((c) => ({
      id: c.id!,
      name: c.name!,
      phoneNumber: c.phoneNumbers?.[0]?.number ?? null,
      lightningAddress: lnMap[c.id!] ?? null,
    }));
}

export async function getLightningAddressMap(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(LN_MAP_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function setLightningAddress(contactId: string, address: string): Promise<void> {
  const map = await getLightningAddressMap();
  map[contactId] = address;
  await AsyncStorage.setItem(LN_MAP_KEY, JSON.stringify(map));
}
