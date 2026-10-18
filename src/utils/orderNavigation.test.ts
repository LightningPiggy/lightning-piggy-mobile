import { CommonActions, StackRouter } from '@react-navigation/routers';
import { orderNavigationTarget } from './orderNavigation';

it.each([
  { screen: 'MarketMyOrders' as const, params: { orderId: 'purchase', sellerPubkey: 'seller' } },
  {
    screen: 'MarketShopOrders' as const,
    params: { eventId: 'placed-event', buyerPubkey: 'buyer' },
  },
])('Back from a linked $screen detail opens its list, then Explore home', ({ screen, params }) => {
  const target = orderNavigationTarget(screen, params);
  const router = StackRouter({ initialRouteName: 'ExploreHome' });
  const options = {
    routeNames: ['ExploreHome', 'MarketMyOrders', 'MarketShopOrders'],
    routeParamList: {},
    routeGetIdList: {},
  };
  const state = router.getRehydratedState(target.params.params.state, options);
  expect(state.routes[state.index]).toMatchObject({ name: screen, params });
  const back = router.getRehydratedState(
    router.getStateForAction(state, CommonActions.goBack(), options)!,
    options,
  );
  expect(back.routes[back.index].name).toBe(screen);
  expect(back.routes[back.index].params).toBeUndefined();
  const home = router.getRehydratedState(
    router.getStateForAction(back, CommonActions.goBack(), options)!,
    options,
  );
  expect(home.routes[home.index].name).toBe('ExploreHome');
});
