import { describe, expect, it } from 'vitest';
import { storeId } from '../../src/index.js';
import { API_KEY, DELIVERY_URL, hashOf } from '../helpers/store-contract.js';

describe('storeId', () => {
  it('is the sha256 hex of the delivery url, a newline and the key', async () => {
    expect(await storeId(DELIVERY_URL, API_KEY)).toBe(
      '7a45a815817041ceeed3ade931e23cc3b07816214c60ae639cadae5a974fff98',
    );
    expect(await storeId(DELIVERY_URL, API_KEY)).toBe(
      hashOf(new TextEncoder().encode(`${DELIVERY_URL}\n${API_KEY}`)),
    );
  });

  it('is lowercase hex that does not contain the key', async () => {
    const id = await storeId(DELIVERY_URL, API_KEY);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain(API_KEY);
  });

  it('differs for another key on the same url', async () => {
    expect(await storeId(DELIVERY_URL, 'tarjim-0-0-0-otherkey')).not.toBe(await storeId(DELIVERY_URL, API_KEY));
  });

  it('differs for another url with the same key', async () => {
    const other = 'https://delivery.example.invalid/t/2/projects/1/delivery/meta';
    expect(await storeId(other, API_KEY)).not.toBe(await storeId(DELIVERY_URL, API_KEY));
  });

  it('does not let url and key trade characters', async () => {
    expect(await storeId('https://a.example.invalid/x', 'yz')).not.toBe(await storeId('https://a.example.invalid/xy', 'z'));
  });
});
