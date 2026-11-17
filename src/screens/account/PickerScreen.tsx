import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';
import { CommonActions } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import AccountScreenLayout from './AccountScreenLayout';
import SettingsPickerOptionRow from '../../components/SettingsPickerOptionRow';
import { useThemeColors } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LocaleContext';
import { createPickerScreenStyles } from '../../styles/PickerScreen.styles';
import {
  filterPickerOptions,
  getPickerOptions,
  hasPickerOptions,
  type SettingsPickerOption,
} from '../../utils/settingsPicker';

export default function PickerScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'SettingsPicker'>) {
  const { title, selectedValue, searchable, customOption, testID, returnTo } = route.params;
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createPickerScreenStyles(colors), [colors]);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const options = route.params.options ?? getPickerOptions(route.params.registryKey);
  const missingRegistration =
    route.params.options === undefined && !hasPickerOptions(route.params.registryKey);
  useEffect(() => {
    if (!missingRegistration) return;
    // Restored routes retain params, but the process-local registry is gone.
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.replace('Main', { screen: 'MainTabs', params: { screen: 'Home' } });
  }, [missingRegistration, navigation]);
  const filtered = useMemo(() => {
    const all = customOption
      ? [...options, { ...customOption, label: customOption.label ?? t('settingsKit.custom') }]
      : options;
    return filterPickerOptions(all, deferredSearch);
  }, [options, customOption, deferredSearch, t]);
  const select = useCallback(
    (value: string) => {
      navigation.dispatch({
        ...CommonActions.setParams({ [returnTo.param]: value }),
        source: returnTo.routeKey,
        target: returnTo.navigatorKey,
      });
      navigation.goBack();
    },
    [navigation, returnTo],
  );
  const renderItem = useCallback(
    ({ item }: { item: SettingsPickerOption }) => (
      <SettingsPickerOptionRow
        option={item}
        selected={item.value === selectedValue}
        onSelect={select}
        testID={`${testID}-option-${item.value}`}
      />
    ),
    [selectedValue, select, testID],
  );
  if (missingRegistration) return null;
  return (
    <AccountScreenLayout title={title} scrollable={false}>
      <View style={styles.card} testID={testID}>
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.value}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListHeaderComponent={
            searchable ? (
              <TextInput
                style={styles.search}
                value={search}
                onChangeText={setSearch}
                placeholder={t('settingsKit.search')}
                accessibilityLabel={t('settingsKit.search')}
                accessibilityRole="search"
                testID={`${testID}-search`}
                autoCorrect={false}
              />
            ) : undefined
          }
          ListEmptyComponent={<Text style={styles.empty}>{t('settingsKit.noResults')}</Text>}
        />
      </View>
    </AccountScreenLayout>
  );
}
