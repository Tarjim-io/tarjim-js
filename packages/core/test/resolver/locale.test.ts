import { describe, expect, it } from 'vitest';
import { matchLocale, selectLocale } from '../../src/index.js';

describe('matching a wanted locale against the available ones', () => {
  it('ignores case and answers with the available spelling', () => {
    expect(matchLocale('AR', ['en', 'ar'])).toBe('ar');
    expect(matchLocale('pt-br', ['en', 'pt-BR'])).toBe('pt-BR');
    expect(matchLocale('en-US', ['en-us', 'ar'])).toBe('en-us');
  });

  it('serves a region variant from the same language and script without a region', () => {
    expect(matchLocale('ar-EG', ['en', 'ar'])).toBe('ar');
    expect(matchLocale('en-GB', ['en', 'ar'])).toBe('en');
  });

  it('never invents a tag the available list does not spell', () => {
    const available = ['en', 'ar', 'zh-Hant', 'sr-Latn'];
    for (const wanted of ['en-US', 'EN', 'ar-EG', 'zh-Hant-HK', 'sr-Latn']) {
      const answer = matchLocale(wanted, available);
      expect(answer === null || available.includes(answer)).toBe(true);
    }
    expect(matchLocale('en-US', ['en'])).toBe('en');
  });

  it('finds nothing for a language the list lacks', () => {
    expect(matchLocale('de-DE', ['en', 'ar'])).toBeNull();
    expect(matchLocale('de', [])).toBeNull();
  });

  it('keeps Hans and Hant apart, and finds each in its own script', () => {
    expect(matchLocale('zh-HK', ['zh-Hans', 'en'])).toBeNull();
    expect(matchLocale('zh-TW', ['zh-Hans'])).toBeNull();
    expect(matchLocale('zh-HK', ['zh-Hant', 'en'])).toBe('zh-Hant');
    expect(matchLocale('zh-CN', ['zh-Hant', 'zh-Hans'])).toBe('zh-Hans');
    expect(matchLocale('zh-Hans', ['zh-Hant', 'zh-Hans'])).toBe('zh-Hans');
  });

  it('keeps Latin Serbian apart from Cyrillic Serbian', () => {
    expect(matchLocale('sr-Latn', ['sr'])).toBeNull();
    expect(matchLocale('sr', ['sr-Latn'])).toBeNull();
    expect(matchLocale('sr-Latn-RS', ['sr', 'sr-Latn'])).toBe('sr-Latn');
    expect(matchLocale('sr-RS', ['sr-Latn', 'sr'])).toBe('sr');
  });

  it('prefers the exact tag, whatever the order of the list', () => {
    expect(matchLocale('es-ES', ['es', 'es-ES'])).toBe('es-ES');
    expect(matchLocale('es-ES', ['es-ES', 'es'])).toBe('es-ES');
  });

  it('breaks a tie between regional variants with the least specific key, whatever the order', () => {
    expect(matchLocale('es-MX', ['es', 'es-ES'])).toBe('es');
    expect(matchLocale('es-MX', ['es-ES', 'es'])).toBe('es');
  });

  it('breaks a tie between equally specific variants by sorted order, whatever the order', () => {
    expect(matchLocale('es-MX', ['es-ES', 'es-AR'])).toBe('es-AR');
    expect(matchLocale('es-MX', ['es-AR', 'es-ES'])).toBe('es-AR');
  });

  it('skips a malformed tag on either side without throwing', () => {
    expect(matchLocale('not a tag!!', ['en'])).toBeNull();
    expect(matchLocale('', ['en'])).toBeNull();
    expect(matchLocale('en', ['@@', 'en'])).toBe('en');
    expect(matchLocale('en', ['', '###'])).toBeNull();
  });
});

describe('selecting the locale for a visitor', () => {
  const universe = ['en', 'ar', 'fr'];

  it('takes the explicit language before everything else', () => {
    expect(selectLocale({ explicit: 'fr', saved: 'ar', browser: ['en'], fallback: 'en', universe })).toEqual({
      locale: 'fr',
      source: 'explicit',
    });
  });

  it('takes the saved override when there is no explicit language', () => {
    expect(selectLocale({ saved: 'ar', browser: ['fr'], fallback: 'en', universe })).toEqual({
      locale: 'ar',
      source: 'saved',
    });
  });

  it('takes the first browser language that the universe serves, in the browser order', () => {
    expect(selectLocale({ browser: ['de-DE', 'ar-EG', 'fr'], fallback: 'en', universe })).toEqual({
      locale: 'ar',
      source: 'browser',
    });
  });

  it('falls to the fallback as a whole when nothing matches', () => {
    expect(selectLocale({ browser: ['de-DE', 'ja'], fallback: 'en', universe })).toEqual({
      locale: 'en',
      source: 'fallback',
    });
    expect(selectLocale({ browser: [], fallback: 'en', universe })).toEqual({ locale: 'en', source: 'fallback' });
  });

  it('ignores a saved override the universe no longer lists', () => {
    expect(selectLocale({ saved: 'ja', browser: ['fr'], fallback: 'en', universe })).toEqual({
      locale: 'fr',
      source: 'browser',
    });
  });

  it('answers with the universe spelling for explicit, saved and browser choices', () => {
    const regional = ['en', 'pt-BR'];
    expect(selectLocale({ explicit: 'PT-br', browser: [], fallback: 'en', universe: regional }).locale).toBe('pt-BR');
    expect(selectLocale({ saved: 'pt-br', browser: [], fallback: 'en', universe: regional }).locale).toBe('pt-BR');
    expect(selectLocale({ browser: ['pt-br'], fallback: 'en', universe: regional }).locale).toBe('pt-BR');
  });

  it('never picks a locale outside the universe from a browser list', () => {
    const choice = selectLocale({ browser: ['de-DE', 'zh-HK'], fallback: 'en', universe: ['en', 'zh-Hans'] });
    expect(choice).toEqual({ locale: 'en', source: 'fallback' });
  });

  it('keeps Hant and Hans apart when choosing for a browser', () => {
    expect(selectLocale({ browser: ['zh-HK'], fallback: 'en', universe: ['en', 'zh-Hant'] })).toEqual({
      locale: 'zh-Hant',
      source: 'browser',
    });
  });

  it('skips malformed browser tags without throwing', () => {
    expect(selectLocale({ browser: ['@@', '', 'ar-EG'], fallback: 'en', universe })).toEqual({
      locale: 'ar',
      source: 'browser',
    });
  });

  it('takes an explicit language as given before any manifest is held', () => {
    expect(selectLocale({ explicit: 'ar', browser: ['en'], fallback: 'en', universe: [] })).toEqual({
      locale: 'ar',
      source: 'explicit',
    });
    expect(selectLocale({ explicit: 'de-DE', saved: 'ar', browser: [], fallback: 'en', universe: [] })).toEqual({
      locale: 'de-DE',
      source: 'explicit',
    });
  });

  it('selects a locale that only the embedded slices have, instead of the fallback', () => {
    expect(selectLocale({ browser: ['ar-EG'], fallback: 'en', universe: ['en', 'ar'] })).toEqual({
      locale: 'ar',
      source: 'browser',
    });
    expect(selectLocale({ explicit: 'ar', browser: [], fallback: 'en', universe: ['ar'] })).toEqual({
      locale: 'ar',
      source: 'explicit',
    });
  });

  it('spells the fallback the way the universe does when it matches, and as given when it does not', () => {
    expect(selectLocale({ browser: [], fallback: 'PT-br', universe: ['en', 'pt-BR'] })).toEqual({ locale: 'pt-BR', source: 'fallback' });
    expect(selectLocale({ browser: [], fallback: 'en-GB', universe: ['en'] })).toEqual({ locale: 'en', source: 'fallback' });
    expect(selectLocale({ browser: [], fallback: 'de', universe: ['en'] })).toEqual({ locale: 'de', source: 'fallback' });
  });

  it('uses the fallback when the universe is empty and nothing is explicit', () => {
    expect(selectLocale({ saved: 'ar', browser: ['ar'], fallback: 'en', universe: [] })).toEqual({
      locale: 'en',
      source: 'fallback',
    });
  });
});
