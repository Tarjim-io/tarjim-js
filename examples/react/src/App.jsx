import { useState } from 'react';
import { useTarjim } from '@tarjim/react';

const LANGUAGES = ['en', 'ar'];

export function App() {
  const { t, entry, language, setLanguage, pendingUpdate } = useTarjim();
  const [count, setCount] = useState(3);
  const [failed, setFailed] = useState(false);
  const hero = entry('hero.image');

  const choose = (next) => setLanguage(next).then(() => setFailed(false), () => setFailed(true));

  return (
    <main>
      <h1>{t('app.title')}</h1>

      <p>
        {LANGUAGES.map((code) => (
          <button key={code} disabled={code === language} onClick={() => choose(code)}>
            {code}
          </button>
        ))}
        {failed && <small> That language is not available.</small>}
      </p>

      <p>
        <button onClick={() => setCount(Math.max(0, count - 1))}>-</button> {t('cart.items', { count })}{' '}
        <button onClick={() => setCount(count + 1)}>+</button>
      </p>

      {/* The value is text; React escapes it. The alt text is the entry's own attribute. */}
      {hero && <img src={hero.value} alt={hero.attributes?.alt ?? ''} width="320" />}

      {pendingUpdate && <p>A new release is downloaded and will show at the next page load.</p>}
    </main>
  );
}
