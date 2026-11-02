import { humanizePaymentError } from './paymentErrors';

describe('humanizePaymentError', () => {
  it.each([
    ['uk', 'Нічого не надіслано — сервер обміну не відповів вчасно.'],
    ['hi', 'कुछ नहीं भेजा गया — स्वैप सर्वर ने समय पर जवाब नहीं दिया।'],
    ['zh-Hans', '没有发送任何内容——兑换服务器未及时响应。'],
  ])('keeps an already-localised %s message', (_, message) => {
    expect(humanizePaymentError(message).message).toBe(message);
  });

  it('still replaces messages with no letters at all', () => {
    expect(humanizePaymentError('500 :: 404').message).toBe('Payment failed. Please try again.');
  });
});
