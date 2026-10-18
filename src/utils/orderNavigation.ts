import type { ExploreStackParamList, RootStackParamList } from '../navigation/types';

type OrderScreen = 'MarketMyOrders' | 'MarketShopOrders';

/** Seed home and the order list so Back from a linked detail stays within Explore. */
export function orderNavigationTarget<T extends OrderScreen>(
  screen: T,
  params: NonNullable<ExploreStackParamList[T]>,
) {
  return {
    screen: 'MainTabs',
    params: {
      screen: 'Explore',
      params: {
        state: {
          index: 2,
          routes: [{ name: 'ExploreHome' }, { name: screen }, { name: screen, params }],
        },
      },
    },
  } satisfies RootStackParamList['Main'];
}
